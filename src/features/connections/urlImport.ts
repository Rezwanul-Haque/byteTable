// "Import from URL" for the connect modal (M34): turn a pasted connection
// string into the fields the new/edit connection form wants.
//
// Ported from the prototype's `parseConnUri` / `parseKvConnStr` (connect.jsx).
// The parsing is deliberately hand-rolled rather than `new URL()`-based: the
// platform parser rejects `mongodb+srv://`, mangles the comma-separated host
// lists Cassandra and Mongo use, and hides credentials behind getters that
// re-encode them. Splitting in the documented order — query, path, userinfo,
// host — is both shorter and the only way those shapes survive.
//
// Nothing here throws: it runs on every keystroke in the import sheet, so a
// half-typed URL must produce an `error` string rather than an exception.

import type { Engine } from "../../shared/types";
import type { TlsMode } from "./api";

/**
 * Scheme → the engine it configures and that engine's conventional port. The
 * port is a starting point only: an explicit `:port` in the URL always wins.
 */
const IMP_SCHEMES: Record<string, [Engine, string | null]> = {
  postgres: ["postgres", "5432"],
  postgresql: ["postgres", "5432"],
  pgsql: ["postgres", "5432"],
  mysql: ["mysql", "3306"],
  mariadb: ["mysql", "3306"],
  sqlserver: ["mssql", "1433"],
  mssql: ["mssql", "1433"],
  // ClickHouse's native TCP protocol is 9000; the `+http` / `+https` variants
  // name its HTTP interface explicitly.
  clickhouse: ["clickhouse", "9000"],
  "clickhouse+http": ["clickhouse", "8123"],
  "clickhouse+https": ["clickhouse", "8443"],
  redis: ["redis", "6379"],
  rediss: ["redis", "6379"],
  mongodb: ["mongodb", "27017"],
  "mongodb+srv": ["mongodb", "27017"],
  cassandra: ["cassandra", "9042"],
  // Typesense is an HTTP search API, so its URLs are ordinary http(s) ones.
  http: ["typesense", "8108"],
  https: ["typesense", "8108"],
  sqlite: ["sqlite", null],
  file: ["sqlite", null],
};

/**
 * Schemes this build parses but has no engine for. Recognising them is the
 * point: "oracle:// isn't supported yet" is a far better answer than listing
 * every scheme that is, and it keeps the two milestones (M29 Neo4j, Oracle)
 * from silently reading as typos.
 */
const IMP_UNSUPPORTED: Record<string, string> = {
  oracle: "Oracle",
  neo4j: "Neo4j",
  "neo4j+s": "Neo4j",
  bolt: "Neo4j",
  "bolt+s": "Neo4j",
};

/** Schemes where the scheme itself already says "TLS on". */
const IMP_SECURE = new Set([
  "rediss",
  "mongodb+srv",
  "neo4j+s",
  "bolt+s",
  "https",
  "clickhouse+https",
]);

/**
 * What the path segment is called per engine, for the sheet's "Fields to fill"
 * list. Cassandra's is a keyspace, Redis's a numeric db index, and so on —
 * calling every one of them "Database" would misdescribe most of them.
 */
export const IMP_DBLABEL: Record<string, string> = {
  cassandra: "Keyspace",
  oracle: "Service name",
  neo4j: "Database",
  typesense: "Collection",
  redis: "Database index",
  sqlite: "File",
};

/** ODBC / ADO.NET key (lowercased) → the field it maps onto. */
const IMP_KV_KEYS: Record<string, string> = {
  server: "host",
  "data source": "host",
  host: "host",
  hostname: "host",
  addr: "host",
  port: "port",
  database: "db",
  "initial catalog": "db",
  db: "db",
  "user id": "user",
  uid: "user",
  user: "user",
  username: "user",
  password: "password",
  pwd: "password",
  encrypt: "tls",
  sslmode: "tls",
  ssl: "tls",
  trustservercertificate: "trust",
};

/** A driver option the parser understood but ByteTable has no field for. */
export interface ImportOption {
  k: string;
  v: string;
}

/**
 * What a pasted string resolved to. Only the keys actually present in the
 * input are set, so {@link applyImport} can fill the form without blanking
 * anything the user already typed.
 */
export interface ImportedConnection {
  /** The scheme as written (`postgres`), or `key=value` for the ODBC form. */
  scheme: string;
  engine: Engine;
  /** True for the ODBC `key=value` dialect, which has no scheme to trust. */
  kv?: true;
  /** False when the engine was inferred rather than named by a scheme. */
  confident: boolean;
  host?: string;
  port?: string;
  /** Database / keyspace / collection / Redis db index — see IMP_DBLABEL. */
  db?: string;
  /** SQLite only: the file path. */
  file?: string;
  user?: string;
  password?: string;
  apiKey?: string;
  tls?: TlsMode;
  datacenter?: string;
  /** MongoDB only: the URI verbatim, so the driver keeps its own options. */
  uri?: string;
  /** How many hosts past the first a seed list carried. */
  extraHosts?: number;
  opts: ImportOption[];
  warnings: string[];
}

/** A human explanation of why a paste could not be read. Never a stack trace. */
export interface ImportError {
  error: string;
}

/** `null` means "nothing typed yet" — neither a success nor a failure. */
export type ImportResult = ImportedConnection | ImportError | null;

export function isImportError(result: ImportResult): result is ImportError {
  return result !== null && "error" in result;
}

/** Percent-decode, tolerating a stray `%` that isn't an escape. */
function impDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Every TLS spelling in the wild — libpq's `sslmode`, MySQL's screaming
 * `ssl-mode`, JDBC's booleans, ODBC's `Encrypt` — onto ByteTable's four modes.
 * Returns null when the value means nothing to us, so the caller can decide
 * whether to fall back or leave the form's current mode alone.
 */
function impTls(raw: string): TlsMode | null {
  const v = raw.trim().toLowerCase();
  if (["disable", "disabled", "false", "off", "no", "none", "0"].includes(v)) return "disable";
  if (["verify-full", "verify_identity", "verify-ca", "verify_ca", "strict"].includes(v)) {
    return "verify-full";
  }
  if (["require", "required", "true", "on", "yes", "1"].includes(v)) return "require";
  if (v === "prefer" || v === "preferred") return "prefer";
  return null;
}

/**
 * ODBC / ADO.NET `Server=tcp:host,1433;Database=shop;…` — what the Azure
 * portal and SSMS hand you, and the one common dialect that is not a URL.
 *
 * There is no scheme here, so the engine is a guess: the port is the only
 * signal, and `confident: false` tells the sheet to say so rather than
 * switching the user's engine with a confidence we do not have.
 */
function parseKvConnStr(text: string): ImportResult {
  const out: ImportedConnection = {
    scheme: "key=value",
    engine: "mssql",
    kv: true,
    confident: false,
    opts: [],
    warnings: [],
  };
  for (const pair of text.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value) continue;
    const mapped = IMP_KV_KEYS[key.toLowerCase()];
    if (mapped === "host") {
      // `tcp:host,1433` (SQL Server's comma) and `host\SQLEXPRESS` (the named
      // instance form). Splitting on `:` too would cut IPv6 addresses in half.
      const parts = value.replace(/^tcp:/i, "").split(/[,\\]/);
      out.host = parts[0];
      if (parts[1] && /^\d+$/.test(parts[1])) out.port = parts[1];
    } else if (mapped === "tls") {
      out.tls = impTls(value) ?? "require";
    } else if (mapped === "port") {
      out.port = value;
    } else if (mapped === "db") {
      out.db = value;
    } else if (mapped === "user") {
      out.user = value;
    } else if (mapped === "password") {
      out.password = value;
    } else {
      // Unmapped keys (and `TrustServerCertificate`, which has no field of its
      // own) survive as driver options rather than vanishing.
      out.opts.push({ k: key, v: value });
    }
  }
  if (!out.host) return { error: "No Server / Host key found in that connection string." };
  out.engine = out.port === "3306" ? "mysql" : out.port === "5432" ? "postgres" : "mssql";
  out.confident = out.port === "3306" || out.port === "5432";
  if (!out.port) out.port = out.engine === "mssql" ? "1433" : "5432";
  if (out.password) out.warnings.push(PASSWORD_WARNING);
  return out;
}

const PASSWORD_WARNING =
  "A password is embedded in this URL. It goes to your OS keychain on save and is never written into the connection file.";

/**
 * Parse a pasted connection string. Returns null for empty input, an
 * {@link ImportError} with a human message for anything unreadable, and an
 * {@link ImportedConnection} otherwise.
 */
export function parseConnUri(raw: string): ImportResult {
  // Strip the quotes that come with a copied `DATABASE_URL="…"` line.
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  // No `://` but key=value pairs: the ODBC dialect.
  if (!s.includes("://") && s.includes("=") && s.includes(";")) return parseKvConnStr(s);

  // `jdbc:postgresql://…` — the JDBC prefix wraps an otherwise ordinary URL.
  const m = /^([a-z0-9+.-]+):\/\/(.*)$/i.exec(s.replace(/^jdbc:/i, ""));
  if (!m) {
    return {
      error: "Not a connection URL — expected something like postgres://user@host:5432/shop",
    };
  }
  const scheme = m[1]!.toLowerCase();
  const unsupported = IMP_UNSUPPORTED[scheme];
  if (unsupported) {
    return {
      error: "“" + scheme + "://” is " + unsupported + ", which this build has no engine for yet.",
    };
  }
  const meta = IMP_SCHEMES[scheme];
  if (!meta) {
    return {
      error:
        "“" +
        scheme +
        "://” isn’t a supported scheme. Try postgres, mysql, sqlserver, clickhouse, redis, mongodb, cassandra or http (Typesense).",
    };
  }

  const out: ImportedConnection = {
    scheme,
    engine: meta[0],
    confident: true,
    opts: [],
    warnings: [],
  };
  if (meta[1]) out.port = meta[1];

  // Split in this order: the query first (a `?` may contain `/` and `@`), then
  // the path, then the userinfo, leaving the authority.
  let rest = m[2]!;
  let query = "";
  let path = "";
  const qi = rest.indexOf("?");
  if (qi >= 0) {
    query = rest.slice(qi + 1);
    rest = rest.slice(0, qi);
  }
  const pi = rest.indexOf("/");
  if (pi >= 0) {
    path = rest.slice(pi + 1);
    rest = rest.slice(0, pi);
  }
  // `lastIndexOf` so a password containing `@` survives — the last `@` is the
  // one that separates userinfo from host.
  const ai = rest.lastIndexOf("@");
  if (ai >= 0) {
    const cred = rest.slice(0, ai);
    rest = rest.slice(ai + 1);
    const ci = cred.indexOf(":");
    // `redis://:pw@host` is a password with no user — leave `user` unset rather
    // than writing an empty string the form would have to ignore.
    const user = impDecode(ci >= 0 ? cred.slice(0, ci) : cred);
    const password = ci >= 0 ? impDecode(cred.slice(ci + 1)) : "";
    if (user) out.user = user;
    if (password) out.password = password;
  }

  // SQLite is a path, not an authority.
  if (out.engine === "sqlite") {
    delete out.port;
    out.file = "/" + (rest + (path ? "/" + path : "")).replace(/^\/+/, "");
    return out;
  }

  const hosts = rest.split(",").filter(Boolean);
  if (!hosts.length) return { error: "No host found in that URL." };
  // `[::1]:6379` — the bracketed IPv6 form, or a plain host, then `:port`.
  const hp = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hosts[0]!);
  out.host = hp ? hp[1] : hosts[0];
  if (hp?.[2]) out.port = hp[2];
  if (hosts.length > 1) {
    out.extraHosts = hosts.length - 1;
    out.warnings.push(
      hosts.length +
        " hosts in the URL — only the first is used for the fields; keep the full URI to preserve the seed list.",
    );
  }

  if (path) {
    const seg = path.split("/").filter(Boolean);
    if (seg.length) out.db = impDecode(seg[0]!);
    // Extra segments are carried rather than dropped: they mean something to
    // the driver even when ByteTable has no field for them.
    if (seg.length > 1) out.opts.push({ k: "path", v: "/" + seg.slice(1).join("/") });
  }

  if (IMP_SECURE.has(scheme)) out.tls = scheme === "https" ? "require" : "verify-full";

  for (const p of query.split("&")) {
    if (!p) continue;
    const eq = p.indexOf("=");
    const k = impDecode(eq < 0 ? p : p.slice(0, eq));
    const v = eq < 0 ? "true" : impDecode(p.slice(eq + 1));
    const lk = k.toLowerCase();
    if (lk === "sslmode" || lk === "ssl" || lk === "tls" || lk === "secure") {
      const t = impTls(v);
      if (t) {
        out.tls = t;
        continue;
      }
    }
    if (lk === "x-typesense-api-key" || lk === "api_key" || lk === "apikey") {
      out.apiKey = v;
      continue;
    }
    if (lk === "user" || lk === "username") {
      out.user = v;
      continue;
    }
    if (lk === "password") {
      out.password = v;
      continue;
    }
    if (lk === "database" || lk === "dbname" || lk === "db" || lk === "keyspace") {
      out.db = v;
      continue;
    }
    if (lk === "datacenter" || lk === "localdatacenter" || lk === "local_dc") {
      out.datacenter = v;
      continue;
    }
    out.opts.push({ k, v });
  }

  // Mongo keeps the string verbatim: SRV records, replica sets and the
  // driver's own options do not survive being split into fields.
  if (out.engine === "mongodb") out.uri = s;
  if (scheme === "mongodb+srv") {
    out.warnings.push(
      "SRV URI — the host list is resolved from DNS at connect time. ByteTable keeps the URI as given.",
    );
  }
  if (out.password) out.warnings.push(PASSWORD_WARNING);
  return out;
}
