// The "get past the foreign keys" option shared by the truncate and drop-table
// confirm modals, and the SQL each of them previews.
//
// Both destructive actions hit the same wall: another table's foreign key points
// at this one, and the engine refuses. There is no portable way through — the
// engines differ enough that a single "disable foreign key checks" label would
// be a lie for most of them (Postgres has no such switch; CASCADE is a different
// promise). So the copy is per engine, and the checkbox sends one `force` flag
// the adapter interprets its own way (see `EngineConnection::truncate_table` /
// `drop_table`).
//
// ClickHouse has no foreign keys at all, so it gets no checkbox: `null`.

import type { Engine } from "../../shared/types";

export interface FkOverride {
  /** Checkbox label — names what the engine actually does. */
  label: string;
  /** One line under the label: what it leaves behind. */
  hint: string;
}

/** The FK-override option for emptying `table`, or null when the engine has none. */
export function truncateFkOverride(engine: Engine | undefined): FkOverride | null {
  switch (engine) {
    case "postgres":
      return {
        label: "Also empty tables that reference this one (CASCADE)",
        hint: "Postgres has no way to skip the check — CASCADE truncates the referencing tables too.",
      };
    case "mysql":
      return {
        label: "Disable foreign key checks (FOREIGN_KEY_CHECKS = 0)",
        hint: "Rows in referencing tables stay, and now point at rows that no longer exist.",
      };
    case "sqlite":
      return {
        label: "Ignore foreign key checks (PRAGMA foreign_keys = OFF)",
        hint: "Rows in referencing tables stay, and now point at rows that no longer exist.",
      };
    case "mssql":
      return {
        label: "Disable the foreign keys that reference this table",
        hint: "They are re-enabled afterwards without re-checking, so they come back untrusted.",
      };
    default:
      return null;
  }
}

/** The FK-override option for dropping `table`, or null when the engine has none. */
export function dropFkOverride(engine: Engine | undefined): FkOverride | null {
  switch (engine) {
    case "postgres":
      return {
        label: "Also drop objects that depend on it (CASCADE)",
        hint: "Referencing foreign keys and views go with the table.",
      };
    case "mysql":
      return {
        label: "Disable foreign key checks (FOREIGN_KEY_CHECKS = 0)",
        hint: "The referencing constraints are left behind, pointing at a table that is gone.",
      };
    case "sqlite":
      return {
        label: "Ignore foreign key checks (PRAGMA foreign_keys = OFF)",
        hint: "The referencing constraints are left behind, pointing at a table that is gone.",
      };
    case "mssql":
      return {
        label: "Drop the foreign keys that reference this table first",
        hint: "A constraint cannot outlive the table it points at, so it is dropped, not disabled.",
      };
    default:
      return null;
  }
}

/** The statement(s) the truncate will run, as previewed in the modal. */
export function truncateSql(engine: Engine | undefined, table: string, force: boolean): string {
  const empty = engine === "sqlite" ? `DELETE FROM ${table};` : `TRUNCATE TABLE ${table};`;
  if (!force) return empty;
  switch (engine) {
    case "postgres":
      return `TRUNCATE TABLE ${table} CASCADE;`;
    case "mysql":
      return `SET FOREIGN_KEY_CHECKS = 0;\n${empty}\nSET FOREIGN_KEY_CHECKS = 1;`;
    case "sqlite":
      return `PRAGMA foreign_keys = OFF;\n${empty}\nPRAGMA foreign_keys = ON;`;
    case "mssql":
      return `ALTER TABLE <referencing> NOCHECK CONSTRAINT <fk>;\n${empty}\nALTER TABLE <referencing> CHECK CONSTRAINT <fk>;`;
    default:
      return empty;
  }
}

/** The statement(s) the drop will run, as previewed in the modal. */
export function dropSql(engine: Engine | undefined, table: string, force: boolean): string {
  const drop = `DROP TABLE ${table};`;
  if (!force) return drop;
  switch (engine) {
    case "postgres":
      return `DROP TABLE ${table} CASCADE;`;
    case "mysql":
      return `SET FOREIGN_KEY_CHECKS = 0;\n${drop}\nSET FOREIGN_KEY_CHECKS = 1;`;
    case "sqlite":
      return `PRAGMA foreign_keys = OFF;\n${drop}\nPRAGMA foreign_keys = ON;`;
    case "mssql":
      return `ALTER TABLE <referencing> DROP CONSTRAINT <fk>;\n${drop}`;
    default:
      return drop;
  }
}
