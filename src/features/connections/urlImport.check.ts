// Self-check for the connect modal's URL importer (M34). There is no frontend
// test framework in this repo, and a scheme table plus a TLS vocabulary is
// exactly the kind of logic that rots silently, so it carries its own runner:
//
//     node src/features/connections/urlImport.check.ts
//
// (Node ≥ 22.18 strips the types itself — nothing to install.) `make test` runs
// it. Prints a pass count and exits 0 when every case holds; prints the first
// mismatch and exits 1 otherwise.
//
// Cases marked "QA" come from MILESTONE_34_IMPORT_FROM_URL.md Task 5.

// Explicit `.ts` (allowed by `allowImportingTsExtensions`) so plain `node` can
// resolve it — Node's ESM resolver does no extension guessing.
import { isImportError, parseConnUri, type ImportOption } from "./urlImport.ts";

let passed = 0;
const failures: string[] = [];

/** Stable stringify so key order never decides whether a case passes. */
function show(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

interface Expected {
  scheme: string;
  engine: string;
  confident?: boolean;
  host?: string;
  port?: string;
  db?: string;
  file?: string;
  user?: string;
  password?: string;
  apiKey?: string;
  tls?: string;
  datacenter?: string;
  uri?: string;
  extraHosts?: number;
  kv?: true;
  opts?: ImportOption[];
  /** Substrings, one per expected warning — the full sentences are long. */
  warns?: string[];
}

/** The paste parses, and every field matches exactly (absent key ⇒ absent). */
function ok(raw: string, want: Expected) {
  const result = parseConnUri(raw);
  if (result === null || isImportError(result)) {
    failures.push(`ok(${JSON.stringify(raw)})\n  expected a parse, got ${show(result)}`);
    return;
  }
  const { warnings, opts, ...rest } = result;
  const { warns = [], opts: wantOpts = [], confident = true, ...wantRest } = want;
  const got = show({ ...rest, opts });
  const expected = show({ ...wantRest, confident, opts: wantOpts });
  if (got !== expected) {
    failures.push(`ok(${JSON.stringify(raw)})\n  got      ${got}\n  expected ${expected}`);
    return;
  }
  if (warnings.length !== warns.length || !warns.every((w, i) => warnings[i]?.includes(w))) {
    failures.push(
      `ok(${JSON.stringify(raw)}) warnings\n  got ${show(warnings)}\n  want ${show(warns)}`,
    );
    return;
  }
  passed++;
}

/** The paste is rejected with a human message containing `contains`. */
function err(raw: string, contains: string) {
  const result = parseConnUri(raw);
  if (result === null || !isImportError(result)) {
    failures.push(`err(${JSON.stringify(raw)})\n  expected an error, got ${show(result)}`);
    return;
  }
  if (!result.error.includes(contains)) {
    failures.push(
      `err(${JSON.stringify(raw)})\n  got      ${result.error}\n  expected ~ ${contains}`,
    );
    return;
  }
  passed++;
}

/** Nothing typed yet — neither a success nor a failure. */
function idle(raw: string) {
  const result = parseConnUri(raw);
  if (result !== null) {
    failures.push(`idle(${JSON.stringify(raw)})\n  expected null, got ${show(result)}`);
    return;
  }
  passed++;
}

// -- QA 1: the canonical Postgres URL ---------------------------------------
ok("postgresql://app:s3cret@db:5432/shop?sslmode=verify-full", {
  scheme: "postgresql",
  engine: "postgres",
  host: "db",
  port: "5432",
  user: "app",
  password: "s3cret",
  db: "shop",
  tls: "verify-full",
  warns: ["password is embedded"],
});

// -- QA 2: Mongo SRV keeps the URI and carries driver options ----------------
ok("mongodb+srv://svc@cluster0.x.mongodb.net/byteshop?retryWrites=true", {
  scheme: "mongodb+srv",
  engine: "mongodb",
  host: "cluster0.x.mongodb.net",
  port: "27017",
  user: "svc",
  db: "byteshop",
  tls: "verify-full",
  uri: "mongodb+srv://svc@cluster0.x.mongodb.net/byteshop?retryWrites=true",
  opts: [{ k: "retryWrites", v: "true" }],
  warns: ["SRV URI"],
});

// -- QA 3: the jdbc: wrapper, and the ODBC dialect --------------------------
ok("jdbc:postgresql://host/db", {
  scheme: "postgresql",
  engine: "postgres",
  host: "host",
  port: "5432",
  db: "db",
});
// The engine is a guess here: no scheme said so, and 1433 is not a giveaway.
ok("Server=tcp:sql,1433;Database=w;User Id=r;Encrypt=true;", {
  scheme: "key=value",
  engine: "mssql",
  kv: true,
  confident: false,
  host: "sql",
  port: "1433",
  db: "w",
  user: "r",
  tls: "require",
});
// A port we do recognise makes the engine confident.
ok("Server=db.internal,5432;Database=shop;Uid=app;Pwd=hunter2", {
  scheme: "key=value",
  engine: "postgres",
  kv: true,
  confident: true,
  host: "db.internal",
  port: "5432",
  db: "shop",
  user: "app",
  password: "hunter2",
  warns: ["password is embedded"],
});
// Unmapped keys survive as driver options rather than vanishing.
ok("Server=sql;Database=w;MultiSubnetFailover=True;TrustServerCertificate=true", {
  scheme: "key=value",
  engine: "mssql",
  kv: true,
  confident: false,
  host: "sql",
  port: "1433",
  db: "w",
  opts: [
    { k: "MultiSubnetFailover", v: "True" },
    { k: "TrustServerCertificate", v: "true" },
  ],
});
// `host\INSTANCE` — the named-instance form, split on the backslash.
ok("Data Source=sql\\SQLEXPRESS;Initial Catalog=w", {
  scheme: "key=value",
  engine: "mssql",
  kv: true,
  confident: false,
  host: "sql",
  port: "1433",
  db: "w",
});
// Splitting the host on `:` too would cut an IPv6 literal in half.
ok("Server=tcp:[::1],1433;Database=shop", {
  scheme: "key=value",
  engine: "mssql",
  kv: true,
  confident: false,
  host: "[::1]",
  port: "1433",
  db: "shop",
});
err("Driver={ODBC};Database=w;Uid=sa", "No Server / Host key");

// -- QA 4: one URL per remaining engine -------------------------------------
// A password with no user (`redis://:pw@`) leaves the user unset.
ok("redis://:pw@cache:6380/3", {
  scheme: "redis",
  engine: "redis",
  host: "cache",
  port: "6380",
  password: "pw",
  db: "3",
  warns: ["password is embedded"],
});
ok("http://ts:8108", { scheme: "http", engine: "typesense", host: "ts", port: "8108" });
// `https` implies TLS, but only `require` — the scheme is the protocol here.
ok("https://ts.example.com/products?x-typesense-api-key=abc123", {
  scheme: "https",
  engine: "typesense",
  host: "ts.example.com",
  port: "8108",
  db: "products",
  apiKey: "abc123",
  tls: "require",
});
ok("cassandra://a:9042,b:9042/ks", {
  scheme: "cassandra",
  engine: "cassandra",
  host: "a",
  port: "9042",
  db: "ks",
  extraHosts: 1,
  warns: ["2 hosts in the URL"],
});
ok("cassandra://a:9042/ks?localDatacenter=dc2", {
  scheme: "cassandra",
  engine: "cassandra",
  host: "a",
  port: "9042",
  db: "ks",
  datacenter: "dc2",
});
ok("sqlite:///~/dev/app.db", { scheme: "sqlite", engine: "sqlite", file: "/~/dev/app.db" });
ok("file:///C:/data/byteshop.sqlite", {
  scheme: "file",
  engine: "sqlite",
  file: "/C:/data/byteshop.sqlite",
});
ok("mysql://root@127.0.0.1:3306/shop?ssl-mode=REQUIRED", {
  scheme: "mysql",
  engine: "mysql",
  host: "127.0.0.1",
  port: "3306",
  user: "root",
  db: "shop",
  // `ssl-mode` is not one of the four TLS query keys, so it rides along.
  opts: [{ k: "ssl-mode", v: "REQUIRED" }],
});
ok("mariadb://h/shop", { scheme: "mariadb", engine: "mysql", host: "h", port: "3306", db: "shop" });
ok("sqlserver://win:1433/master", {
  scheme: "sqlserver",
  engine: "mssql",
  host: "win",
  port: "1433",
  db: "master",
});
// ClickHouse's three schemes name three different ports.
ok("clickhouse://h/analytics", {
  scheme: "clickhouse",
  engine: "clickhouse",
  host: "h",
  port: "9000",
  db: "analytics",
});
ok("clickhouse+http://h/analytics", {
  scheme: "clickhouse+http",
  engine: "clickhouse",
  host: "h",
  port: "8123",
  db: "analytics",
});
ok("clickhouse+https://h/analytics", {
  scheme: "clickhouse+https",
  engine: "clickhouse",
  host: "h",
  port: "8443",
  db: "analytics",
  tls: "verify-full",
});
ok("rediss://cache/0", {
  scheme: "rediss",
  engine: "redis",
  host: "cache",
  port: "6379",
  db: "0",
  tls: "verify-full",
});
ok("mongodb://localhost:27017/shop", {
  scheme: "mongodb",
  engine: "mongodb",
  host: "localhost",
  port: "27017",
  db: "shop",
  uri: "mongodb://localhost:27017/shop",
});

// -- QA 5: garbage and unknown schemes get a helpful error ------------------
idle("");
idle("   ");
err("just some text", "Not a connection URL");
err("localhost:5432", "Not a connection URL");
err("ftp://x/y", "isn’t a supported scheme");
err("postgres://", "No host found");
// Recognised but unimplemented — say so, rather than listing every scheme.
err("oracle://h:1521/orcl", "Oracle");
err("neo4j+s://graph:7687", "Neo4j");
err("bolt://graph:7687", "Neo4j");

// -- QA 6: passwords with `@` and `:`, and percent-encoding -----------------
// `lastIndexOf('@')` picks the right separator; the first `:` splits the pair.
ok("postgres://u:p@ss:word@host/db", {
  scheme: "postgres",
  engine: "postgres",
  host: "host",
  port: "5432",
  user: "u",
  password: "p@ss:word",
  db: "db",
  warns: ["password is embedded"],
});
ok("postgres://ad%40min:s3cr%40t@db.example.com:6432/byte%20shop", {
  scheme: "postgres",
  engine: "postgres",
  host: "db.example.com",
  port: "6432",
  user: "ad@min",
  password: "s3cr@t",
  db: "byte shop",
  warns: ["password is embedded"],
});
// A lone `%` is not an escape — decoding must not throw.
ok("postgres://u:100%@host/db", {
  scheme: "postgres",
  engine: "postgres",
  host: "host",
  port: "5432",
  user: "u",
  password: "100%",
  db: "db",
  warns: ["password is embedded"],
});
// A quoted `DATABASE_URL="…"` line pastes as-is.
ok('"postgres://host/db"', {
  scheme: "postgres",
  engine: "postgres",
  host: "host",
  port: "5432",
  db: "db",
});

// -- Hosts: IPv6 literals and seed lists ------------------------------------
ok("postgres://[::1]:5432/db", {
  scheme: "postgres",
  engine: "postgres",
  host: "[::1]",
  port: "5432",
  db: "db",
});
ok("postgres://[2001:db8::1]/db", {
  scheme: "postgres",
  engine: "postgres",
  host: "[2001:db8::1]",
  port: "5432",
  db: "db",
});

// -- Paths: the first segment is the database, the rest is carried ----------
ok("postgres://host/db/extra/bits", {
  scheme: "postgres",
  engine: "postgres",
  host: "host",
  port: "5432",
  db: "db",
  opts: [{ k: "path", v: "/extra/bits" }],
});

// -- The TLS vocabulary, mapped onto ByteTable's four modes -----------------
const TLS_CASES: [string, string][] = [
  ["disable", "disable"],
  ["disabled", "disable"],
  ["false", "disable"],
  ["off", "disable"],
  ["no", "disable"],
  ["none", "disable"],
  ["0", "disable"],
  ["verify-full", "verify-full"],
  ["VERIFY_IDENTITY", "verify-full"],
  ["verify-ca", "verify-full"],
  ["VERIFY_CA", "verify-full"],
  ["strict", "verify-full"],
  ["require", "require"],
  ["required", "require"],
  ["true", "require"],
  ["on", "require"],
  ["yes", "require"],
  ["1", "require"],
  ["prefer", "prefer"],
];
for (const [value, mode] of TLS_CASES) {
  ok("postgres://h/db?sslmode=" + value, {
    scheme: "postgres",
    engine: "postgres",
    host: "h",
    port: "5432",
    db: "db",
    tls: mode,
  });
}
// All four spellings of the TLS key are honoured, and an unreadable value is
// carried as a driver option rather than guessed at.
for (const key of ["sslmode", "ssl", "tls", "secure"]) {
  ok("postgres://h/db?" + key + "=require", {
    scheme: "postgres",
    engine: "postgres",
    host: "h",
    port: "5432",
    db: "db",
    tls: "require",
  });
}
// Query keys are matched case-insensitively — `?SSLMODE=` is a real spelling.
ok("postgres://h/db?SSLMODE=disable", {
  scheme: "postgres",
  engine: "postgres",
  host: "h",
  port: "5432",
  db: "db",
  tls: "disable",
});
ok("postgres://h/db?sslmode=banana", {
  scheme: "postgres",
  engine: "postgres",
  host: "h",
  port: "5432",
  db: "db",
  opts: [{ k: "sslmode", v: "banana" }],
});
// An explicit query beats the scheme's implied mode.
ok("rediss://cache/0?ssl=false", {
  scheme: "rediss",
  engine: "redis",
  host: "cache",
  port: "6379",
  db: "0",
  tls: "disable",
});

// -- Query params that map onto fields --------------------------------------
ok("postgres://h/?user=app&password=pw&dbname=shop&datacenter=dc1&application_name=bt", {
  scheme: "postgres",
  engine: "postgres",
  host: "h",
  port: "5432",
  user: "app",
  password: "pw",
  db: "shop",
  datacenter: "dc1",
  opts: [{ k: "application_name", v: "bt" }],
  warns: ["password is embedded"],
});
// A valueless flag reads as `true`.
ok("postgres://h/db?readonly", {
  scheme: "postgres",
  engine: "postgres",
  host: "h",
  port: "5432",
  db: "db",
  opts: [{ k: "readonly", v: "true" }],
});

// -- Idempotence: parsing the same string twice gives the same answer -------
// (QA "importing twice in a row is idempotent" — the form side of that is the
// `if (p.x)` guards in `applyImport`, which have no field to clear from.)
const twice = "postgres://app:s3cret@db:5432/shop?sslmode=require";
if (show(parseConnUri(twice)) !== show(parseConnUri(twice))) {
  failures.push("parseConnUri is not idempotent for " + twice);
} else {
  passed++;
}

if (failures.length) {
  console.error(failures.join("\n\n"));
  // Throwing rather than `process.exit` keeps this file inside the app's
  // tsconfig (which has DOM libs, not Node's) while still exiting non-zero.
  throw new Error(`${failures.length} failed, ${passed} passed`);
}
console.log(`urlImport: ${passed} checks passed`);
