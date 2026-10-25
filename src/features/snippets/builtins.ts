// Built-in starter snippets — the SELECT / INSERT / UPDATE / DELETE / CREATE
// skeletons every library would otherwise have to be hand-built to contain.
//
// NOT seeded into the user's store. They are merged into the library at READ
// time, so they cost nothing on first run, cannot be corrupted, come back if
// the store file is lost, and gain new entries when ByteTable ships them. The
// same stance as the SQL toolbar's engine starter chips (`snippetsFor` in
// SqlEditorTab), and the reason a built-in has no edit or delete button: it is
// not the user's row to lose. Writing one's own version is a `New snippet`
// away, and a user snippet with the same abbreviation ranks above the built-in.
//
// Per ENGINE rather than one generic set, because a skeleton that does not run
// is worse than no skeleton: ClickHouse mutates with `ALTER TABLE … UPDATE`,
// SQL Server pages with `TOP`, MySQL upserts with `ON DUPLICATE KEY`, and
// Cassandra has no joins, CTEs or `GROUP BY` worth offering. An engine simply
// omits what it cannot do.

import { t, type StringKey } from "../../shared/i18n";
import type { Engine } from "../../shared/types";

import type { Snippet } from "./api";

/**
 * Id prefix marking a snippet as built-in. Ids are opaque to the backend and no
 * built-in is ever saved, so this never collides with a stored UUID.
 */
export const BUILTIN_PREFIX = "builtin:";

/** Whether a library row is a built-in (no edit / delete, "built-in" chip). */
export function isBuiltinSnippet(snippet: Snippet): boolean {
  return snippet.id.startsWith(BUILTIN_PREFIX);
}

/** A built-in before its name is localized. */
interface BuiltinSpec {
  /** Id suffix and completion trigger. */
  key: string;
  abbreviation: string;
  labelKey: StringKey;
  body: string;
}

// Field syntax is `#{n:label}` (see snippets/api.ts): `${…}` is the braced form
// of a RUN-time query parameter, and these are INSERT-time tab stops. Repeating
// a number links the fields, so editing `#{1:column}` in the GROUP BY skeleton
// updates both places at once.

const SELECT_LIMIT: BuiltinSpec = {
  key: "select",
  abbreviation: "sel",
  labelKey: "ws.snip.b.select",
  body: "SELECT #{1:*}\nFROM #{2:table}\nWHERE #{3:condition}\nLIMIT #{4:100};",
};

const INSERT: BuiltinSpec = {
  key: "insert",
  abbreviation: "ins",
  labelKey: "ws.snip.b.insert",
  body: "INSERT INTO #{1:table} (#{2:column})\nVALUES (#{3:value});",
};

const UPDATE: BuiltinSpec = {
  key: "update",
  abbreviation: "upd",
  labelKey: "ws.snip.b.update",
  body: "UPDATE #{1:table}\nSET #{2:column} = #{3:value}\nWHERE #{4:condition};",
};

const DELETE: BuiltinSpec = {
  key: "delete",
  abbreviation: "del",
  labelKey: "ws.snip.b.delete",
  body: "DELETE FROM #{1:table}\nWHERE #{2:condition};",
};

const CREATE_INDEX: BuiltinSpec = {
  key: "createIndex",
  abbreviation: "ci",
  labelKey: "ws.snip.b.createIndex",
  body: "CREATE INDEX #{1:index_name}\nON #{2:table} (#{3:column});",
};

const JOIN: BuiltinSpec = {
  key: "join",
  abbreviation: "join",
  labelKey: "ws.snip.b.join",
  body:
    "SELECT a.#{1:*}, b.#{2:*}\n" +
    "FROM #{3:table_a} AS a\n" +
    "JOIN #{4:table_b} AS b ON b.#{5:a_id} = a.id\n" +
    "WHERE #{6:condition};",
};

const GROUP_BY: BuiltinSpec = {
  key: "groupBy",
  abbreviation: "grp",
  labelKey: "ws.snip.b.groupBy",
  body:
    "SELECT #{1:column}, COUNT(*) AS total\n" +
    "FROM #{2:table}\n" +
    "GROUP BY #{1:column}\n" +
    "ORDER BY total DESC;",
};

const CTE: BuiltinSpec = {
  key: "cte",
  abbreviation: "cte",
  labelKey: "ws.snip.b.cte",
  body:
    "WITH #{1:subset} AS (\n" +
    "  SELECT #{2:*}\n" +
    "  FROM #{3:table}\n" +
    "  WHERE #{4:condition}\n" +
    ")\n" +
    "SELECT *\nFROM #{1:subset};",
};

const ADD_COLUMN: BuiltinSpec = {
  key: "addColumn",
  abbreviation: "addcol",
  labelKey: "ws.snip.b.addColumn",
  body: "ALTER TABLE #{1:table}\nADD COLUMN #{2:column} #{3:text};",
};

/** The ANSI-ish set shared by Postgres, MySQL and SQLite. */
const SHARED: BuiltinSpec[] = [
  SELECT_LIMIT,
  INSERT,
  UPDATE,
  DELETE,
  CREATE_INDEX,
  JOIN,
  GROUP_BY,
  CTE,
  ADD_COLUMN,
];

function createTable(body: string): BuiltinSpec {
  return { key: "createTable", abbreviation: "ct", labelKey: "ws.snip.b.createTable", body };
}

function upsert(body: string): BuiltinSpec {
  return { key: "upsert", abbreviation: "ups", labelKey: "ws.snip.b.upsert", body };
}

/** The built-ins for one engine, in the order the library lists them. */
function specsFor(engine: Engine): BuiltinSpec[] {
  switch (engine) {
    case "postgres":
      return [
        ...SHARED,
        createTable(
          "CREATE TABLE #{1:table} (\n" +
            "  id bigserial PRIMARY KEY,\n" +
            "  #{2:name} text NOT NULL,\n" +
            "  created_at timestamptz NOT NULL DEFAULT now()\n" +
            ");",
        ),
        upsert(
          "INSERT INTO #{1:table} (#{2:id}, #{3:column})\n" +
            "VALUES (#{4:value}, #{5:value})\n" +
            "ON CONFLICT (#{2:id}) DO UPDATE\n" +
            "  SET #{3:column} = EXCLUDED.#{3:column};",
        ),
      ];

    case "sqlite":
      return [
        ...SHARED,
        createTable(
          "CREATE TABLE #{1:table} (\n" +
            "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
            "  #{2:name} TEXT NOT NULL,\n" +
            "  created_at TEXT NOT NULL DEFAULT (datetime('now'))\n" +
            ");",
        ),
        upsert(
          "INSERT INTO #{1:table} (#{2:id}, #{3:column})\n" +
            "VALUES (#{4:value}, #{5:value})\n" +
            "ON CONFLICT (#{2:id}) DO UPDATE\n" +
            "  SET #{3:column} = excluded.#{3:column};",
        ),
      ];

    case "mysql":
      return [
        ...SHARED,
        createTable(
          "CREATE TABLE #{1:table} (\n" +
            "  id bigint UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n" +
            "  #{2:name} varchar(255) NOT NULL,\n" +
            "  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP\n" +
            ");",
        ),
        upsert(
          "INSERT INTO #{1:table} (#{2:id}, #{3:column})\n" +
            "VALUES (#{4:value}, #{5:value})\n" +
            "ON DUPLICATE KEY UPDATE #{3:column} = VALUES(#{3:column});",
        ),
      ];

    case "mssql":
      // T-SQL pages with TOP rather than LIMIT, and ADD takes no COLUMN keyword.
      // No upsert: MERGE is long enough that a half-filled skeleton is a hazard
      // rather than a help.
      return [
        {
          ...SELECT_LIMIT,
          body: "SELECT TOP (#{1:100}) #{2:*}\nFROM #{3:table}\nWHERE #{4:condition};",
        },
        INSERT,
        UPDATE,
        DELETE,
        CREATE_INDEX,
        JOIN,
        GROUP_BY,
        CTE,
        { ...ADD_COLUMN, body: "ALTER TABLE #{1:table}\nADD #{2:column} #{3:nvarchar(255)};" },
        createTable(
          "CREATE TABLE #{1:table} (\n" +
            "  id bigint IDENTITY(1,1) PRIMARY KEY,\n" +
            "  #{2:name} nvarchar(255) NOT NULL,\n" +
            "  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()\n" +
            ");",
        ),
      ];

    case "clickhouse":
      // Mutations are ALTER TABLE statements, indexes are data-skipping
      // indexes, and a table needs an ENGINE + ORDER BY. No upsert.
      return [
        SELECT_LIMIT,
        INSERT,
        {
          ...UPDATE,
          body: "ALTER TABLE #{1:table}\nUPDATE #{2:column} = #{3:value}\nWHERE #{4:condition};",
        },
        { ...DELETE, body: "ALTER TABLE #{1:table}\nDELETE WHERE #{2:condition};" },
        {
          ...CREATE_INDEX,
          body:
            "ALTER TABLE #{1:table}\n" +
            "ADD INDEX #{2:index_name} #{3:column} TYPE minmax GRANULARITY 1;",
        },
        JOIN,
        GROUP_BY,
        CTE,
        ADD_COLUMN,
        createTable(
          "CREATE TABLE #{1:table} (\n" +
            "  id UInt64,\n" +
            "  #{2:name} String,\n" +
            "  created_at DateTime DEFAULT now()\n" +
            ")\n" +
            "ENGINE = MergeTree\n" +
            "ORDER BY id;",
        ),
      ];

    case "cassandra":
      // CQL has no joins, no CTEs and no useful ad-hoc GROUP BY, and every
      // UPDATE/DELETE must name the full primary key. INSERT is already an
      // upsert, so there is no separate one.
      return [
        {
          ...SELECT_LIMIT,
          body:
            "SELECT #{1:*}\n" +
            "FROM #{2:table}\n" +
            "WHERE #{3:partition_key} = #{4:value}\n" +
            "LIMIT #{5:100};",
        },
        INSERT,
        {
          ...UPDATE,
          body:
            "UPDATE #{1:table}\n" +
            "SET #{2:column} = #{3:value}\n" +
            "WHERE #{4:partition_key} = #{5:value};",
        },
        {
          ...DELETE,
          body: "DELETE FROM #{1:table}\nWHERE #{2:partition_key} = #{3:value};",
        },
        CREATE_INDEX,
        ADD_COLUMN,
        createTable(
          "CREATE TABLE #{1:table} (\n" +
            "  id uuid,\n" +
            "  #{2:name} text,\n" +
            "  created_at timestamp,\n" +
            "  PRIMARY KEY (id)\n" +
            ");",
        ),
      ];

    default:
      // A non-SQL engine has no SQL editor to insert into, so it gets none.
      return [];
  }
}

/**
 * The built-in snippets for an engine, as library rows.
 *
 * Names are resolved through `t` on every call (module-level i18n, as in
 * `browse/sql/filter.ts`), so callers must re-derive this when the locale
 * changes — the components do, by listing `t` in their `useMemo` deps.
 */
export function builtinSnippets(engine: Engine): Snippet[] {
  return specsFor(engine).map((spec) => ({
    id: BUILTIN_PREFIX + spec.key,
    name: t(spec.labelKey),
    abbreviation: spec.abbreviation,
    body: spec.body,
    engine,
    savedAt: 0,
  }));
}

/**
 * The whole library for a workspace: the user's snippets for this engine first,
 * then the built-ins.
 *
 * User snippets lead because they are the specific ones — someone who writes
 * their own `sel` means theirs, and the completion list and the drawer should
 * both say so.
 */
export function libraryForEngine(userSnippets: Snippet[], engine: Engine): Snippet[] {
  return [...userSnippets, ...builtinSnippets(engine)];
}
