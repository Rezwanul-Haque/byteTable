// Unit tests for the connect modal's URL importer (M34). A scheme table plus a
// TLS vocabulary is exactly the kind of logic that rots silently, so every
// scheme, every TLS spelling and every rejection path is covered here.
//
// Cases marked "QA" come from MILESTONE_34_IMPORT_FROM_URL.md Task 5.
//
//     pnpm test            (all suites)
//     pnpm test:watch      (re-run on change)

import { describe, expect, it } from "vitest";

import { isImportError, parseConnUri, type ImportOption } from "./urlImport";

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
function expectOk(raw: string, want: Expected) {
  const result = parseConnUri(raw);
  if (result === null || isImportError(result)) {
    throw new Error(`expected a parse, got ${JSON.stringify(result)}`);
  }
  const { warnings, opts, ...rest } = result;
  const { warns = [], opts: wantOpts = [], confident = true, ...wantRest } = want;
  expect({ ...rest, opts }).toEqual({ ...wantRest, confident, opts: wantOpts });
  expect(warnings).toHaveLength(warns.length);
  warns.forEach((w, i) => expect(warnings[i]).toContain(w));
}

/** The paste is rejected with a human message containing `contains`. */
function expectErr(raw: string, contains: string) {
  const result = parseConnUri(raw);
  if (result === null || !isImportError(result)) {
    throw new Error(`expected an error, got ${JSON.stringify(result)}`);
  }
  expect(result.error).toContain(contains);
}

describe("parseConnUri", () => {
  describe("QA 1: the canonical Postgres URL", () => {
    it("reads every part and warns about the embedded password", () => {
      expectOk("postgresql://app:s3cret@db:5432/shop?sslmode=verify-full", {
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
    });
  });

  describe("QA 2: Mongo SRV", () => {
    it("keeps the URI and carries driver options", () => {
      expectOk("mongodb+srv://svc@cluster0.x.mongodb.net/byteshop?retryWrites=true", {
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
    });
  });

  describe("QA 3: the jdbc: wrapper and the ODBC dialect", () => {
    it("unwraps jdbc:", () => {
      expectOk("jdbc:postgresql://host/db", {
        scheme: "postgresql",
        engine: "postgres",
        host: "host",
        port: "5432",
        db: "db",
      });
    });

    it("guesses the engine when no scheme says so", () => {
      // 1433 is not a giveaway, so the engine is a guess — hence confident:false.
      expectOk("Server=tcp:sql,1433;Database=w;User Id=r;Encrypt=true;", {
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
    });

    it("is confident when the port is recognisable", () => {
      expectOk("Server=db.internal,5432;Database=shop;Uid=app;Pwd=hunter2", {
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
    });

    it("keeps unmapped keys as driver options rather than dropping them", () => {
      expectOk("Server=sql;Database=w;MultiSubnetFailover=True;TrustServerCertificate=true", {
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
    });

    it("splits the named-instance form on the backslash", () => {
      expectOk("Data Source=sql\\SQLEXPRESS;Initial Catalog=w", {
        scheme: "key=value",
        engine: "mssql",
        kv: true,
        confident: false,
        host: "sql",
        port: "1433",
        db: "w",
      });
    });

    it("does not cut an IPv6 literal in half", () => {
      expectOk("Server=tcp:[::1],1433;Database=shop", {
        scheme: "key=value",
        engine: "mssql",
        kv: true,
        confident: false,
        host: "[::1]",
        port: "1433",
        db: "shop",
      });
    });

    it("rejects a key=value string with no host", () => {
      expectErr("Driver={ODBC};Database=w;Uid=sa", "No Server / Host key");
    });
  });

  describe("QA 4: one URL per remaining engine", () => {
    it("leaves the user unset for a password-only redis URL", () => {
      expectOk("redis://:pw@cache:6380/3", {
        scheme: "redis",
        engine: "redis",
        host: "cache",
        port: "6380",
        password: "pw",
        db: "3",
        warns: ["password is embedded"],
      });
    });

    it.each([
      ["http://ts:8108", { scheme: "http", engine: "typesense", host: "ts", port: "8108" }],
      [
        // `https` implies TLS, but only `require` — the scheme is the protocol here.
        "https://ts.example.com/products?x-typesense-api-key=abc123",
        {
          scheme: "https",
          engine: "typesense",
          host: "ts.example.com",
          port: "8108",
          db: "products",
          apiKey: "abc123",
          tls: "require",
        },
      ],
      [
        "cassandra://a:9042,b:9042/ks",
        {
          scheme: "cassandra",
          engine: "cassandra",
          host: "a",
          port: "9042",
          db: "ks",
          extraHosts: 1,
          warns: ["2 hosts in the URL"],
        },
      ],
      [
        "cassandra://a:9042/ks?localDatacenter=dc2",
        {
          scheme: "cassandra",
          engine: "cassandra",
          host: "a",
          port: "9042",
          db: "ks",
          datacenter: "dc2",
        },
      ],
      ["sqlite:///~/dev/app.db", { scheme: "sqlite", engine: "sqlite", file: "/~/dev/app.db" }],
      [
        "file:///C:/data/byteshop.sqlite",
        { scheme: "file", engine: "sqlite", file: "/C:/data/byteshop.sqlite" },
      ],
      [
        "mysql://root@127.0.0.1:3306/shop?ssl-mode=REQUIRED",
        {
          scheme: "mysql",
          engine: "mysql",
          host: "127.0.0.1",
          port: "3306",
          user: "root",
          db: "shop",
          // `ssl-mode` is not one of the four TLS query keys, so it rides along.
          opts: [{ k: "ssl-mode", v: "REQUIRED" }],
        },
      ],
      [
        "mariadb://h/shop",
        { scheme: "mariadb", engine: "mysql", host: "h", port: "3306", db: "shop" },
      ],
      [
        "sqlserver://win:1433/master",
        { scheme: "sqlserver", engine: "mssql", host: "win", port: "1433", db: "master" },
      ],
      // ClickHouse's three schemes name three different ports.
      [
        "clickhouse://h/analytics",
        { scheme: "clickhouse", engine: "clickhouse", host: "h", port: "9000", db: "analytics" },
      ],
      [
        "clickhouse+http://h/analytics",
        {
          scheme: "clickhouse+http",
          engine: "clickhouse",
          host: "h",
          port: "8123",
          db: "analytics",
        },
      ],
      [
        "clickhouse+https://h/analytics",
        {
          scheme: "clickhouse+https",
          engine: "clickhouse",
          host: "h",
          port: "8443",
          db: "analytics",
          tls: "verify-full",
        },
      ],
      [
        "rediss://cache/0",
        {
          scheme: "rediss",
          engine: "redis",
          host: "cache",
          port: "6379",
          db: "0",
          tls: "verify-full",
        },
      ],
      [
        "mongodb://localhost:27017/shop",
        {
          scheme: "mongodb",
          engine: "mongodb",
          host: "localhost",
          port: "27017",
          db: "shop",
          uri: "mongodb://localhost:27017/shop",
        },
      ],
    ] as [string, Expected][])("%s", (raw, want) => {
      expectOk(raw, want);
    });
  });

  describe("QA 5: garbage and unknown schemes", () => {
    it.each(["", "   "])("treats %o as nothing typed yet", (raw) => {
      expect(parseConnUri(raw)).toBeNull();
    });

    it.each([
      ["just some text", "Not a connection URL"],
      ["localhost:5432", "Not a connection URL"],
      ["ftp://x/y", "isn’t a supported scheme"],
      ["postgres://", "No host found"],
      // Recognised but unimplemented — say so, rather than listing every scheme.
      ["oracle://h:1521/orcl", "Oracle"],
      ["neo4j+s://graph:7687", "Neo4j"],
      ["bolt://graph:7687", "Neo4j"],
    ])("rejects %s", (raw, message) => {
      expectErr(raw, message);
    });
  });

  describe("QA 6: passwords with @ and :, and percent-encoding", () => {
    it("picks the last @ as the separator and the first : within the pair", () => {
      expectOk("postgres://u:p@ss:word@host/db", {
        scheme: "postgres",
        engine: "postgres",
        host: "host",
        port: "5432",
        user: "u",
        password: "p@ss:word",
        db: "db",
        warns: ["password is embedded"],
      });
    });

    it("decodes percent-escapes", () => {
      expectOk("postgres://ad%40min:s3cr%40t@db.example.com:6432/byte%20shop", {
        scheme: "postgres",
        engine: "postgres",
        host: "db.example.com",
        port: "6432",
        user: "ad@min",
        password: "s3cr@t",
        db: "byte shop",
        warns: ["password is embedded"],
      });
    });

    it("does not throw on a lone % (not an escape)", () => {
      expectOk("postgres://u:100%@host/db", {
        scheme: "postgres",
        engine: "postgres",
        host: "host",
        port: "5432",
        user: "u",
        password: "100%",
        db: "db",
        warns: ["password is embedded"],
      });
    });

    it('accepts a quoted DATABASE_URL="…" line as-is', () => {
      expectOk('"postgres://host/db"', {
        scheme: "postgres",
        engine: "postgres",
        host: "host",
        port: "5432",
        db: "db",
      });
    });
  });

  describe("hosts", () => {
    it.each([
      ["postgres://[::1]:5432/db", "[::1]"],
      ["postgres://[2001:db8::1]/db", "[2001:db8::1]"],
    ])("keeps the IPv6 literal in %s intact", (raw, host) => {
      expectOk(raw, { scheme: "postgres", engine: "postgres", host, port: "5432", db: "db" });
    });
  });

  describe("paths", () => {
    it("takes the first segment as the database and carries the rest", () => {
      expectOk("postgres://host/db/extra/bits", {
        scheme: "postgres",
        engine: "postgres",
        host: "host",
        port: "5432",
        db: "db",
        opts: [{ k: "path", v: "/extra/bits" }],
      });
    });
  });

  describe("the TLS vocabulary, mapped onto ByteTable's four modes", () => {
    it.each([
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
    ])("sslmode=%s → %s", (value, mode) => {
      expectOk("postgres://h/db?sslmode=" + value, {
        scheme: "postgres",
        engine: "postgres",
        host: "h",
        port: "5432",
        db: "db",
        tls: mode,
      });
    });

    it.each(["sslmode", "ssl", "tls", "secure"])("honours the %s key", (key) => {
      expectOk("postgres://h/db?" + key + "=require", {
        scheme: "postgres",
        engine: "postgres",
        host: "h",
        port: "5432",
        db: "db",
        tls: "require",
      });
    });

    it("matches query keys case-insensitively (?SSLMODE= is a real spelling)", () => {
      expectOk("postgres://h/db?SSLMODE=disable", {
        scheme: "postgres",
        engine: "postgres",
        host: "h",
        port: "5432",
        db: "db",
        tls: "disable",
      });
    });

    it("carries an unreadable value as a driver option rather than guessing", () => {
      expectOk("postgres://h/db?sslmode=banana", {
        scheme: "postgres",
        engine: "postgres",
        host: "h",
        port: "5432",
        db: "db",
        opts: [{ k: "sslmode", v: "banana" }],
      });
    });

    it("lets an explicit query beat the scheme's implied mode", () => {
      expectOk("rediss://cache/0?ssl=false", {
        scheme: "rediss",
        engine: "redis",
        host: "cache",
        port: "6379",
        db: "0",
        tls: "disable",
      });
    });
  });

  describe("query params that map onto fields", () => {
    it("reads user / password / dbname / datacenter and carries the rest", () => {
      expectOk(
        "postgres://h/?user=app&password=pw&dbname=shop&datacenter=dc1&application_name=bt",
        {
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
        },
      );
    });

    it("reads a valueless flag as true", () => {
      expectOk("postgres://h/db?readonly", {
        scheme: "postgres",
        engine: "postgres",
        host: "h",
        port: "5432",
        db: "db",
        opts: [{ k: "readonly", v: "true" }],
      });
    });
  });

  describe("idempotence", () => {
    // QA "importing twice in a row is idempotent" — the form side of that is
    // the `if (p.x)` guards in `applyImport`, which have no field to clear.
    it("gives the same answer when parsing the same string twice", () => {
      const twice = "postgres://app:s3cret@db:5432/shop?sslmode=require";
      expect(parseConnUri(twice)).toEqual(parseConnUri(twice));
    });
  });
});
