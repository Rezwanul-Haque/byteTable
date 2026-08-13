// Self-check for the connect modal's URL importer. There is no frontend test
// framework in this repo, and a scheme table + a TLS-option mapping is exactly
// the kind of logic that rots silently, so it carries its own runner:
//
//     node src/features/connections/urlImport.check.ts
//
// (Node ≥ 22.18 strips the types itself — nothing to install.) Prints nothing
// and exits 0 when every case holds; throws on the first mismatch.

// Explicit `.ts` (allowed by `allowImportingTsExtensions`) so plain `node` can
// resolve it — Node's ESM resolver does no extension guessing.
import { parseConnectionUrl } from "./urlImport.ts";

function eq(raw: string, want: unknown) {
  const got = JSON.stringify(parseConnectionUrl(raw));
  const expected = JSON.stringify(want);
  if (got !== expected) {
    throw new Error(
      `parseConnectionUrl(${JSON.stringify(raw)})\n  got      ${got}\n  expected ${expected}`,
    );
  }
}

// Key order matters to the JSON comparison above: it mirrors the order the
// parser builds its object in (engine, host, port, user, password, db, tls).
eq("postgres://admin:s3cr%40t@db.example.com:6432/byteshop?sslmode=verify-full", {
  engine: "postgres",
  host: "db.example.com",
  port: "6432",
  user: "admin",
  password: "s3cr@t",
  db: "byteshop",
  tls: "verify-full",
});
eq("postgresql://localhost/shop", { engine: "postgres", host: "localhost", db: "shop" });
eq("jdbc:sqlserver://win.example.com:1433/master", {
  engine: "mssql",
  host: "win.example.com",
  port: "1433",
  db: "master",
});
eq("mysql://root@127.0.0.1:3306/byteshop?ssl-mode=REQUIRED", {
  engine: "mysql",
  host: "127.0.0.1",
  port: "3306",
  user: "root",
  db: "byteshop",
  tls: "require",
});
// MySQL screams its ssl-mode values and separates them with `_`.
eq("mysql://db.example.com/shop?ssl-mode=DISABLED", {
  engine: "mysql",
  host: "db.example.com",
  db: "shop",
  tls: "disable",
});
eq("mysql://db.example.com/shop?ssl-mode=VERIFY_CA", {
  engine: "mysql",
  host: "db.example.com",
  db: "shop",
  tls: "verify-ca",
});
// The scheme alone implies TLS, and Redis's path segment is a db index.
eq("rediss://cache.byteshop.io:6380/3", {
  engine: "redis",
  host: "cache.byteshop.io",
  port: "6380",
  db: "3",
  tls: "require",
});
// Mongo keeps the whole string (SRV / replica sets don't survive being split).
eq("mongodb+srv://u:p@cluster0.mongodb.net/byteshop", {
  engine: "mongodb",
  mongoConnMode: "uri",
  mongoUri: "mongodb+srv://u:p@cluster0.mongodb.net/byteshop",
  host: "cluster0.mongodb.net",
});
// Cassandra contact points: several hosts in one authority.
eq("cassandra://n1.example.com,n2.example.com:9042/byteshop", {
  engine: "cassandra",
  host: "n1.example.com,n2.example.com",
  port: "9042",
  db: "byteshop",
});
// A TLS scheme with no port takes the secure port, never the cleartext default
// the connect form would otherwise fill in (8123 / 6379 cannot serve TLS).
eq("clickhouses://ch.example.com/analytics", {
  engine: "clickhouse",
  host: "ch.example.com",
  port: "8443",
  db: "analytics",
  tls: "require",
});
eq("rediss://cache.example.io/0", {
  engine: "redis",
  host: "cache.example.io",
  port: "6380",
  db: "0",
  tls: "require",
});
// Same when TLS comes from a query flag rather than the scheme.
eq("clickhouse://ch.example.com/analytics?ssl=true", {
  engine: "clickhouse",
  host: "ch.example.com",
  port: "8443",
  db: "analytics",
  tls: "require",
});
// No TLS: no port at all, so the form's own default (8123) still applies.
eq("clickhouse://ch.example.com/analytics", {
  engine: "clickhouse",
  host: "ch.example.com",
  db: "analytics",
});
eq("clickhouses://default@ch.example.com:8443/analytics", {
  engine: "clickhouse",
  host: "ch.example.com",
  port: "8443",
  user: "default",
  db: "analytics",
  tls: "require",
});
// SQLite is a path, not an authority — including a Windows drive letter.
eq("file:///C:/data/byteshop.sqlite", { engine: "sqlite", file: "C:/data/byteshop.sqlite" });
eq("sqlite:///home/joy/byteshop.db", { engine: "sqlite", file: "/home/joy/byteshop.db" });

// ODBC / ADO.NET: what the Azure portal hands you. Encrypt without
// TrustServerCertificate means the certificate is actually checked.
eq(
  "Server=tcp:sql.example.com,1433;Initial Catalog=byteshop;User ID=sa;Password=pw;Encrypt=True;TrustServerCertificate=False",
  {
    engine: "mssql",
    host: "sql.example.com",
    port: "1433",
    user: "sa",
    password: "pw",
    db: "byteshop",
    tls: "verify-full",
  },
);
// The driver names the engine when the string carries one.
eq("Driver={MySQL ODBC 8.0 Unicode Driver};Server=127.0.0.1;Database=shop;Uid=root;Pwd=secret", {
  engine: "mysql",
  host: "127.0.0.1",
  user: "root",
  password: "secret",
  db: "shop",
});

// Rejected: no scheme, an unknown scheme, nothing to import, malformed, and
// key=value pairs that name no server.
for (const bad of [
  "",
  "  ",
  "localhost:5432",
  "ftp://x/y",
  "postgres://",
  "postgres://a b",
  "hello=world;foo=bar",
]) {
  eq(bad, null);
}
