// "Import from URL" for the connect modal (Beekeeper Studio's paste-a-DSN
// flow): turn a pasted connection string into the modal's form fields.
//
// The parsing is mostly the platform's — nearly every string we accept is a
// real URL, so `new URL()` already does authority / userinfo / port / query,
// including the percent-decoding of a password with an `@` in it. Ours is only
// the scheme→engine map, where each engine wants the path segment, and which
// query keys mean TLS. The one non-URL dialect worth having is ODBC / ADO.NET's
// `Server=…;Database=…;` (what Azure and SSMS hand you), which has its own
// small parser below.
//
// Engines with no conventional URL form (SQLite is a file path, DynamoDB is a
// region + credentials, Typesense is host + API key) are deliberately absent:
// `file:` / `sqlite:` are handled as paths, the other two have nothing to parse.

import type { Engine } from "../../shared/types";
import type { TlsMode } from "./api";

/** Scheme (lowercased, no colon) → the engine that URL configures. */
const SCHEME_ENGINE: Record<string, Engine> = {
  postgres: "postgres",
  postgresql: "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  mssql: "mssql",
  sqlserver: "mssql",
  redis: "redis",
  rediss: "redis",
  valkey: "redis",
  mongodb: "mongodb",
  "mongodb+srv": "mongodb",
  cassandra: "cassandra",
  cql: "cassandra",
  clickhouse: "clickhouse",
  clickhouses: "clickhouse",
  sqlite: "sqlite",
  file: "sqlite",
};

/** Schemes where the scheme itself already says "TLS on". */
const TLS_SCHEMES = new Set(["rediss", "clickhouses", "mongodb+srv"]);

/**
 * The port an engine listens on for TLS, where that differs from its cleartext
 * one. Used only when a TLS URL names no port — otherwise the caller's
 * plaintext default would be filled in and the connection could not be made.
 * Engines that negotiate TLS on their single port are deliberately absent.
 */
const SECURE_PORTS: Partial<Record<Engine, string>> = {
  // ClickHouse's HTTPS interface (its cleartext HTTP one is 8123).
  clickhouse: "8443",
  // The `rediss://` convention managed Redis uses (cleartext is 6379).
  redis: "6380",
};

const TLS_MODES = new Set<string>(["disable", "prefer", "require", "verify-ca", "verify-full"]);

/**
 * The form fields a pasted URL resolved to. Every key is also a key of the
 * modal's `FormState` (with the same type), so this object is applied as one
 * field patch. Absent keys keep whatever the form already has — so a URL that
 * says nothing about TLS never silently downgrades the current mode.
 */
export interface ImportedConnection {
  engine: Engine;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  /** Database / keyspace / Redis db index — whatever the path segment means. */
  db?: string;
  /** SQLite only: the file path. */
  file?: string;
  tls?: TlsMode;
  mongoConnMode?: "fields" | "uri";
  mongoUri?: string;
}

/**
 * ODBC / ADO.NET key=value strings (`Server=tcp:host,1433;Database=shop;…`) —
 * what the Azure portal and SSMS hand you, and the one common connection-string
 * dialect that is not a URL. Returns null when there is no server key, which is
 * also how "this isn't a connection string at all" is reported.
 */
function parseOdbc(text: string): ImportedConnection | null {
  const pairs = new Map<string, string>();
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    // `eq < 1` rejects both "no =" and a nameless "=value".
    if (eq < 1) continue;
    // Keys are case- and space-insensitive: `User Id`, `user id`, `UID`.
    pairs.set(
      part.slice(0, eq).trim().toLowerCase().replace(/\s+/g, ""),
      part.slice(eq + 1).trim(),
    );
  }
  const pick = (...keys: string[]) => keys.map((k) => pairs.get(k)).find((v) => v);
  const server = pick("server", "datasource", "address", "addr", "networkaddress", "host");
  if (!server) return null;

  // The driver/provider names the engine when it is there; SQL Server is the
  // overwhelming default for this dialect otherwise.
  const driver = (pick("driver", "provider") ?? "").toLowerCase();
  const engine: Engine = /mysql|maria/.test(driver)
    ? "mysql"
    : /postgres|psql/.test(driver)
      ? "postgres"
      : "mssql";

  // `tcp:host,1433` (SQL Server's comma) / `host:1433` / a bare host.
  const [host, port] = server.replace(/^tcp:/i, "").split(/[,:]/);
  // Encrypt=true means TLS; TrustServerCertificate then decides whether the
  // certificate is actually checked — which is exactly the require/verify-full
  // distinction.
  const yes = (v: string | undefined) => v === "true" || v === "yes" || v === "1";
  const encrypt = pick("encrypt")?.toLowerCase();
  const tls: TlsMode | undefined = encrypt
    ? yes(encrypt)
      ? yes(pick("trustservercertificate")?.toLowerCase())
        ? "require"
        : "verify-full"
      : "disable"
    : undefined;

  const database = pick("database", "initialcatalog");
  const user = pick("userid", "uid", "user");
  const password = pick("password", "pwd");
  return {
    engine,
    ...(host ? { host } : {}),
    ...(port ? { port } : {}),
    ...(user ? { user } : {}),
    ...(password ? { password } : {}),
    ...(database ? { db: database } : {}),
    ...(tls ? { tls } : {}),
  };
}

/** Percent-decode, tolerating a stray `%` that isn't an escape. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The TLS mode a URL asks for, or undefined when it doesn't say. */
function tlsMode(query: URLSearchParams, scheme: string): TlsMode | undefined {
  // libpq's `sslmode` (Postgres), MySQL's `ssl-mode`. MySQL screams its values
  // and separates with `_` (DISABLED, VERIFY_CA), so normalise before matching.
  const mode = (query.get("sslmode") ?? query.get("ssl-mode") ?? "")
    .toLowerCase()
    .replace(/_/g, "-");
  if (mode === "allow" || mode === "preferred") return "prefer";
  if (mode === "required") return "require";
  if (mode === "disabled") return "disable";
  if (mode === "verify-identity") return "verify-full";
  if (TLS_MODES.has(mode)) return mode as TlsMode;
  // Boolean flags (`?ssl=true`, `?tls=1`).
  const flag = (query.get("ssl") ?? query.get("tls") ?? "").toLowerCase();
  if (flag === "true" || flag === "1") return "require";
  if (flag === "false" || flag === "0") return "disable";
  return TLS_SCHEMES.has(scheme) ? "require" : undefined;
}

/**
 * Parse a pasted connection string into form fields, or null when it isn't a
 * connection URL this build understands (no scheme, an unknown scheme, or
 * malformed enough that `new URL` rejects it).
 */
export function parseConnectionUrl(raw: string): ImportedConnection | null {
  // `jdbc:postgresql://…` — the JDBC prefix wraps an otherwise ordinary URL.
  const text = raw.trim().replace(/^jdbc:/i, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  const engine = scheme ? SCHEME_ENGINE[scheme] : undefined;
  // No scheme, or one this build has no engine for: the other dialect worth
  // supporting is ODBC's `Key=value;` (and it reports "not a connection
  // string" for us by returning null).
  if (!scheme || !engine) return parseOdbc(text);

  // SQLite is a path, not an authority: `sqlite:///abs/db.sqlite`,
  // `file:///C:/db.sqlite`, `sqlite:relative.db`. Strip the scheme and the
  // authority slashes, then the leading `/` a Windows drive letter doesn't want.
  if (engine === "sqlite") {
    let path = text.slice(scheme.length + 1).replace(/^\/\//, "");
    if (/^\/[a-z]:/i.test(path)) path = path.slice(1);
    path = decode(path.replace(/[?#].*$/, ""));
    return path ? { engine, file: path } : null;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // A hostless `postgres://` parses fine but says nothing — importing it would
  // just flip the engine picker under the user. Treat it as not-a-URL.
  if (!url.hostname) return null;

  // MongoDB keeps the whole string: the driver understands SRV records, replica
  // sets and its own options, none of which survive being split into fields.
  if (engine === "mongodb") {
    return {
      engine,
      mongoConnMode: "uri",
      mongoUri: text,
      ...(url.hostname ? { host: decode(url.hostname) } : {}),
      ...(url.port ? { port: url.port } : {}),
    };
  }

  const path = decode(url.pathname.replace(/^\//, ""));
  const tls = tlsMode(url.searchParams, scheme);
  // A TLS URL that names no port must not leave the caller falling back to the
  // engine's cleartext default: ClickHouse serves HTTPS on 8443, not 8123, and
  // Redis TLS on 6380, not 6379 — both would produce a config that cannot
  // connect. The other engines negotiate TLS on their one port, so they have no
  // entry and keep the normal default.
  const port =
    url.port || (tls && tls !== "disable" && tls !== "prefer" ? SECURE_PORTS[engine] : "");
  return {
    engine,
    ...(url.hostname ? { host: decode(url.hostname) } : {}),
    ...(port ? { port } : {}),
    ...(url.username ? { user: decode(url.username) } : {}),
    ...(url.password ? { password: decode(url.password) } : {}),
    // Redis puts the logical db index where the others put a database name;
    // Cassandra puts the keyspace there. Same slot in the form either way.
    ...(path ? { db: path } : {}),
    ...(tls ? { tls } : {}),
  };
}
