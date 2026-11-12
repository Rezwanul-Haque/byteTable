import { describe, expect, it } from "vitest";

import { DEFAULTS, mergeSettings } from "../settings/api";
import type { SchemaTable } from "./api";
import {
  aiIntent,
  bullets,
  lineDiff,
  parseFixAnswer,
  parseIndexAnswer,
  parseSqlAnswer,
  richSegments,
  sameSql,
  RUNTIMES,
  actionsFor,
  isAssistantEngine,
  languageOf,
  validateFor,
  mentionedTables,
  modelKeyOf,
  prevWordStart,
  replaceTrigger,
  triggerAt,
  runtimeKeys,
  runtimeOf,
  slot,
  startersFor,
  splitSlots,
  validate,
} from "./logic";

const SCHEMA: SchemaTable[] = [
  {
    name: "users",
    columns: ["id", "full_name", "email", "country", "is_active", "created_at"],
    indexes: ["users_email_key", "idx_users_country"],
  },
  {
    name: "orders",
    columns: ["id", "user_id", "status", "total", "created_at"],
    indexes: ["idx_orders_user_id", "idx_orders_status"],
  },
];

describe("slots", () => {
  it("finds styled placeholders again inside a whole message", () => {
    const text = `${slot("name")} is tagged ${slot("env")}, so it is off.`;
    expect(splitSlots(text)).toEqual([
      { slot: "name" },
      { text: " is tagged " },
      { slot: "env" },
      { text: ", so it is off." },
    ]);
    expect(splitSlots("plain")).toEqual([{ text: "plain" }]);
  });
});

describe("runtimes", () => {
  it("map to and from the settings keys", () => {
    expect(runtimeOf(DEFAULTS)).toBe("ollama");
    for (const id of RUNTIMES) {
      expect(runtimeOf({ ...DEFAULTS, ...runtimeKeys(id) })).toBe(id);
    }
    expect(runtimeKeys("openai")).toEqual({ aiProvider: "key", aiVendor: "openai" });
    expect(runtimeKeys("custom")).toEqual({ aiProvider: "local", aiRuntime: "custom" });
  });
});

describe("@ and /", () => {
  it("opens on @ at a word start and / at the message start", () => {
    expect(triggerAt("show @ord", 9)).toEqual({ sign: "@", query: "ord", start: 5 });
    expect(triggerAt("@", 1)).toEqual({ sign: "@", query: "", start: 0 });
    expect(triggerAt("mail@ex", 7)).toBeNull();
    expect(triggerAt("/pla", 4)).toEqual({ sign: "/", query: "pla", start: 0 });
    expect(triggerAt("  /", 3)).toEqual({ sign: "/", query: "", start: 2 });
    expect(triggerAt("a / b", 3)).toBeNull();
    expect(triggerAt("show @orders now", 16)).toBeNull();
  });

  it("replaces the token and finds real mentions", () => {
    const trig = triggerAt("rows in @ord", 12)!;
    expect(replaceTrigger("rows in @ord", 12, trig, "@orders ")).toEqual({
      text: "rows in @orders ",
      caret: 16,
    });
    expect(mentionedTables("join @Orders, @users and @nope; @orders", ["users", "orders"])).toEqual(
      ["orders", "users"],
    );
    expect(mentionedTables("mail me@users", ["users"])).toEqual([]);
  });

  it("finds the word ⌘⌫ deletes", () => {
    expect(prevWordStart("count @orders by status", 23)).toBe(17);
    expect(prevWordStart("count @orders ", 14)).toBe(6);
    expect(prevWordStart("only Germany, ", 14)).toBe(12);
    expect(prevWordStart("x", 0)).toBe(0);
  });

  it("maps a runtime to its model setting", () => {
    expect(modelKeyOf("ollama")).toBe("aiLocalModel");
    expect(modelKeyOf("lmstudio")).toBe("aiLmModel");
    expect(modelKeyOf("custom")).toBe("aiCustomModel");
    expect(modelKeyOf("anthropic")).toBe("aiKeyModel");
  });
});

describe("starters", () => {
  it("come from the connected schema, one table each", () => {
    expect(startersFor(SCHEMA)).toEqual([
      { kind: "latest", table: "users" },
      { kind: "countBy", table: "orders", column: "status" },
      { kind: "count", table: "users" },
    ]);
    const audit = [
      { name: "cms_audit_logs", columns: ["id", "action", "created_at"], indexes: [] },
    ];
    expect(startersFor(audit)).toEqual([
      { kind: "latest", table: "cms_audit_logs" },
      { kind: "countBy", table: "cms_audit_logs", column: "action" },
      { kind: "count", table: "cms_audit_logs" },
    ]);
    expect(startersFor([])).toEqual([]);
  });
});

describe("non-SQL languages", () => {
  const MONGO: SchemaTable[] = [
    { name: "orders", columns: ["_id", "status", "createdAt"], indexes: [] },
  ];
  const TS: SchemaTable[] = [
    { name: "products", columns: ["title", "brand", "price"], indexes: [] },
  ];

  it("maps every engine to a language", () => {
    expect(languageOf("postgres")).toBe("sql");
    expect(languageOf("cassandra")).toBe("cql");
    expect(languageOf("dynamodb")).toBe("partiQl");
    expect(languageOf("mongodb")).toBe("mongo");
    expect(languageOf("typesense")).toBe("typesense");
    expect(languageOf("redis")).toBe("redis");
    expect(isAssistantEngine("redis")).toBe(true);
    expect(actionsFor("mongo")).toEqual(["explain"]);
    expect(actionsFor("sql")).toEqual(["explain", "plan", "index"]);
  });

  it("reads each language's answer, fenced or bare", () => {
    expect(
      parseSqlAnswer(
        "// assume: shipped = status 'shipped'\n```javascript\ndb.orders.find({ status: 'shipped' })\n```",
        "mongo",
      ),
    ).toMatchObject({
      sql: "db.orders.find({ status: 'shipped' })",
      assumptions: ["shipped = status 'shipped'"],
    });
    expect(parseSqlAnswer("db.orders.countDocuments({})", "mongo").sql).toBe(
      "db.orders.countDocuments({})",
    );
    expect(
      parseSqlAnswer(
        "# assume: brand facet\nhttp\nGET /collections/products/documents/search?q=*",
        "typesense",
      ),
    ).toMatchObject({
      sql: "GET /collections/products/documents/search?q=*",
      assumptions: ["brand facet"],
    });
    expect(
      parseSqlAnswer("```redis\nSCAN 0 MATCH user:*:session COUNT 100\n```", "redis").sql,
    ).toBe("SCAN 0 MATCH user:*:session COUNT 100");
    expect(parseSqlAnswer("Use SCAN, not KEYS.", "redis").sql).toBeNull();
  });

  it("checks what it can name, per language", () => {
    expect(validateFor("mongo", "db.orders.find({})", MONGO, "mongodb").unknown).toEqual([]);
    expect(validateFor("mongo", "db.order.find({})", MONGO, "mongodb").unknown).toEqual(["order"]);
    expect(validateFor("mongo", "db.orders.deleteMany({})", MONGO, "mongodb").write).toBe(true);
    const guess = 'db.orders.find({ _id: ObjectId("318f615f") })';
    expect(validateFor("mongo", guess, MONGO, "mongodb").parseError).toMatch(/24 hex/);
    const hole = 'db.orders.find({ _id: ObjectId("<orderId>") })';
    expect(validateFor("mongo", hole, MONGO, "mongodb").parseError).toMatch(/fill in/);
    const real = 'db.orders.find({ _id: ObjectId("65f0a1b2c3d4e5f6a7b8c9d0") })';
    expect(validateFor("mongo", real, MONGO, "mongodb").parseError).toBeUndefined();
    expect(validateFor("mongo", "orders.find()", MONGO, "mongodb").parseError).toBeTruthy();
    expect(
      validateFor(
        "typesense",
        "GET /collections/products/documents/search?q=x&query_by=title,nme",
        TS,
        "typesense",
      ).unknown,
    ).toEqual(["nme"]);
    expect(validateFor("typesense", "DELETE /collections/products", TS, "typesense").write).toBe(
      true,
    );
    expect(validateFor("redis", "SCAN 0 MATCH a:*", [], "redis").write).toBeUndefined();
    expect(validateFor("redis", "GET a\nDEL a", [], "redis").write).toBe(true);
    expect(
      validateFor(
        "partiQl",
        'SELECT * FROM "Orders" WHERE pk = 1',
        [{ name: "Orders", columns: [], indexes: [] }],
        "dynamodb",
      ).unknown,
    ).toEqual([]);
    const SHOP: SchemaTable[] = [{ name: "ShopApp", columns: ["PK", "SK", "GSI1PK"], indexes: [] }];
    const dq = `SELECT * FROM "ShopApp" WHERE PK = "USER#U-1006" AND SK = "PROFILE"`;
    expect(validateFor("partiQl", dq, SHOP, "dynamodb").parseError).toMatch(/'USER#U-1006'/);
    const sq = `SELECT * FROM "ShopApp" WHERE PK = 'USER#U-1006' AND SK = 'PROFILE'`;
    expect(validateFor("partiQl", sq, SHOP, "dynamodb").parseError).toBeUndefined();
    const fn = `SELECT * FROM "ShopApp" WHERE PK = 'USER' AND begins_with(SK, "ORDER#")`;
    expect(validateFor("partiQl", fn, SHOP, "dynamodb").parseError).toMatch(/'ORDER#'/);
    const attr = `SELECT * FROM "ShopApp" WHERE PK = "GSI1PK"`;
    expect(validateFor("partiQl", attr, SHOP, "dynamodb").parseError).toBeUndefined();
    expect(validateFor("partiQl", 'SELECT * FROM "Nope"', [], "dynamodb").unknown).toEqual([
      "Nope",
    ]);
  });

  it("offers Redis key patterns as starters", () => {
    expect(startersFor([{ name: "user:*:session", columns: [], indexes: [] }], "redis")).toEqual([
      { kind: "keys", table: "user:*:session" },
    ]);
    expect(startersFor(MONGO, "mongo")[0]).toEqual({ kind: "latest", table: "orders" });
  });
});

describe("settings merge", () => {
  it("ships the assistant off and repairs bad values", () => {
    expect(DEFAULTS.aiEnabledFor).toEqual({});
    const m = mergeSettings({
      aiAllowed: null,
      aiEnabledFor: { c1: true },
      aiSample: 7,
      aiRuntime: "nope",
    });
    expect(m.aiAllowed).toEqual({});
    expect(m.aiSample).toBe(5);
    expect(m.aiRuntime).toBe("ollama");
    expect(m.aiEnabledFor).toEqual({ c1: true });
    expect(mergeSettings({ aiEnabledFor: null }).aiEnabledFor).toEqual({});
  });
});

describe("aiIntent", () => {
  it("routes questions about the editor's query", () => {
    expect(aiIntent("why is this slow?", true)).toBe("plan");
    expect(aiIntent("would an index help?", true)).toBe("index");
    expect(aiIntent("explain this query", true)).toBe("explain");
    expect(aiIntent("only Germany", true)).toBe("ask");
    expect(aiIntent("why is this slow?", false)).toBe("ask");
  });
});

describe("answers", () => {
  it("lifts -- assume: lines into chips", () => {
    const a = parseSqlAnswer(
      "Here you go:\n```sql\n-- assume: customers → users\n-- assume: revenue = SUM(total)\nSELECT 1;\n```",
    );
    expect(a.sql).toBe("SELECT 1;");
    expect(a.assumptions).toEqual(["customers → users", "revenue = SUM(total)"]);
    expect(a.note).toBe("Here you go:");
  });

  it("reads the shapes models and gateways actually send", () => {
    const sql = "SELECT al.id\nFROM cms_audit_logs al\nORDER BY al.created_at DESC;";
    // A gateway that strips the fence leaves the tag line behind.
    expect(parseSqlAnswer("sql\n" + sql).sql).toBe(sql);
    expect(parseSqlAnswer("sql\n-- assume: sign-in = action 'login'\n" + sql)).toMatchObject({
      sql,
      assumptions: ["sign-in = action 'login'"],
    });
    // No tag at all, with a remark after a blank line.
    expect(parseSqlAnswer(sql + "\n\nNewest first.")).toMatchObject({ sql, note: "Newest first." });
    // Tag and statement on the fence's own line.
    expect(parseSqlAnswer("```sql SELECT 1;```").sql).toBe("SELECT 1;");
    expect(parseSqlAnswer("```postgresql\nSELECT 1;\n```").sql).toBe("SELECT 1;");
    // Assumptions first, a blank line, then a stripped fence's tag + statement.
    const split = parseSqlAnswer(
      '-- assume: "latest" implies ordering by created_at in descending order\n\nsql\nSELECT * FROM accounts ORDER BY created_at DESC LIMIT 20;',
    );
    expect(split).toMatchObject({
      sql: "SELECT * FROM accounts ORDER BY created_at DESC LIMIT 20;",
      assumptions: ['"latest" implies ordering by created_at in descending order'],
      note: "",
    });
    expect(parseSqlAnswer("-- assume: x means y\n```sql\nSELECT 1;\n```")).toMatchObject({
      sql: "SELECT 1;",
      assumptions: ["x means y"],
      note: "",
    });
    // Prose before the statement stays the note.
    expect(parseSqlAnswer("Here you go:\n\nSELECT 1;")).toMatchObject({
      sql: "SELECT 1;",
      note: "Here you go:",
    });
    // Prose that merely starts like SQL stays prose.
    expect(parseSqlAnswer("With this schema I can't tell which rows are noise.").sql).toBeNull();
    expect(parseSqlAnswer("Select a table first, then ask again").sql).toBeNull();
    expect(parseSqlAnswer("With this schema:\nselect a table first").sql).toBeNull();
    // A bare fix and a bare index DDL are read too.
    expect(parseFixAnswer("SELECT full_name FROM users;", "SELECT full_nam FROM users;").ok).toBe(
      true,
    );
    expect(parseIndexAnswer("CREATE INDEX i ON orders (status);", SCHEMA).outcome).toBe("ddl");
  });

  it("reads a streaming, unterminated block", () => {
    expect(parseSqlAnswer("```sql\nSELECT *\nFROM us").sql).toBe("SELECT *\nFROM us");
  });

  it("compares drafts ignoring whitespace", () => {
    expect(sameSql("SELECT 1\nFROM t;", "select 1 from t")).toBe(true);
  });

  it("reads the three index outcomes", () => {
    expect(
      parseIndexAnswer("```sql\nCREATE INDEX i ON orders (status);\n```\nEquality first.", SCHEMA),
    ).toMatchObject({ outcome: "ddl" });
    expect(
      parseIndexAnswer("`idx_orders_status` already covers this filter.", SCHEMA),
    ).toMatchObject({ outcome: "exists", index: "idx_orders_status" });
    expect(parseIndexAnswer("There is no filter to index.", SCHEMA).outcome).toBe("none");
  });

  it("proposes a fix only when the SQL changed", () => {
    const f = parseFixAnswer(
      "```sql\nSELECT full_name FROM users;\n```\nTypo.",
      "SELECT full_nam FROM users;",
    );
    expect(f).toMatchObject({
      ok: true,
      lines: [{ n: 1, old: "SELECT full_nam FROM users;", now: "SELECT full_name FROM users;" }],
    });
    expect(parseFixAnswer("I can't fix that safely.", "SELECT 1").ok).toBe(false);
    expect(parseFixAnswer("```sql\nSELECT 1\n```", "SELECT 1").ok).toBe(false);
  });

  it("diffs line by line", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([{ n: 2, old: "b", now: "B" }]);
    expect(lineDiff("a", "a\nb")).toHaveLength(1);
  });

  it("splits bullets and rich text", () => {
    expect(bullets("- one\n- two")).toEqual(["one", "two"]);
    expect(bullets("Just a paragraph.")).toBeNull();
    expect(richSegments("reads `orders` **fast**")).toEqual([
      { k: "text", t: "reads " },
      { k: "code", t: "orders" },
      { k: "text", t: " " },
      { k: "bold", t: "fast" },
    ]);
  });
});

describe("validate", () => {
  const v = (sql: string) => validate(sql, SCHEMA, "postgres");

  it("passes a query whose tables and columns all exist", () => {
    const r = v(
      "SELECT u.full_name, COUNT(*) AS orders, SUM(o.total) AS revenue\nFROM orders o\nJOIN users u ON o.user_id = u.id\nWHERE o.status IN ('paid', 'shipped')\n  AND o.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'\nGROUP BY u.full_name\nORDER BY revenue DESC\nLIMIT 10;",
    );
    expect(r.unknown).toEqual([]);
    expect(r.tables).toBe(2);
  });

  it("names a misspelt column", () => {
    expect(v("SELECT full_nam FROM users").unknown).toEqual(["full_nam"]);
    expect(v("SELECT u.emial FROM users u").unknown).toEqual(["u.emial"]);
  });

  it("names an unknown table", () => {
    expect(v("SELECT * FROM customers").unknown).toEqual(["customers"]);
  });

  it("classifies writes", () => {
    expect(v("UPDATE users SET is_active = false").write).toBe(true);
    expect(v("WITH x AS (SELECT 1) DELETE FROM users").write).toBe(true);
  });

  it("reports what doesn't parse", () => {
    expect(v("SELEC * FRM users").parseError).toBeTruthy();
    expect(v("SELECT (1 FROM users").parseError).toBeTruthy();
  });

  it("handles comma joins, EXTRACT and CTEs without false alarms", () => {
    expect(v("SELECT u.email FROM users u, orders o WHERE o.user_id = u.id").unknown).toEqual([]);
    expect(v("SELECT EXTRACT(YEAR FROM created_at) AS y FROM orders").unknown).toEqual([]);
    expect(
      v("WITH t AS (SELECT user_id, SUM(total) AS s FROM orders GROUP BY user_id) SELECT s FROM t")
        .unknown,
    ).toEqual([]);
    expect(v("SELECT id FROM users -- a comment with full_nam\n").unknown).toEqual([]);
    expect(v("SELECT 'full_nam' AS x FROM users").unknown).toEqual([]);
  });
});
