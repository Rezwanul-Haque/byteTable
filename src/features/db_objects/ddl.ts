// DDL helpers for the object editor/viewer: engine-aware identifier quoting,
// `CREATE …` starter templates for new objects, the `DROP …` prefix used to
// "replace" objects that have no `CREATE OR REPLACE`, and the browse-as-data
// SELECT. All produce a SINGLE statement (or, for `dropPrefix`, one DROP) so
// the backend never has to split — see `runObjectDdl`.

import type { Engine } from "../../shared/types";
import type { DbObjectKind } from "./api";

/** Quote one identifier for `engine` (MySQL backticks; others double quotes),
 *  doubling any embedded quote char. */
export function quoteIdent(engine: Engine, ident: string): string {
  if (engine === "mysql") return "`" + ident.replace(/`/g, "``") + "`";
  return '"' + ident.replace(/"/g, '""') + '"';
}

/** `schema.name`, both identifiers quoted. */
export function qualified(engine: Engine, schema: string, name: string): string {
  return quoteIdent(engine, schema) + "." + quoteIdent(engine, name);
}

/** Whether a `CREATE OR REPLACE …` exists for this (engine, kind) — if not, an
 *  alter must `DROP` then `CREATE` (two statements). */
export function hasOrReplace(engine: Engine, kind: DbObjectKind): boolean {
  if (engine === "sqlite") return false;
  switch (kind) {
    case "view":
      return true; // Postgres + MySQL both support CREATE OR REPLACE VIEW
    case "function":
    case "procedure":
      return engine === "postgres"; // MySQL has no OR REPLACE for routines
    case "materialized_view":
    case "trigger":
      return false;
  }
}

/** A precise `DROP …;` for one object — mirrors the backend `drop_object_sql`.
 *  Used to prepend a replace (alter without OR REPLACE) and to preview it. */
export function dropPrefix(
  engine: Engine,
  kind: DbObjectKind,
  schema: string,
  name: string,
  detail: string | null,
): string {
  const q = (i: string) => quoteIdent(engine, i);
  const qn = qualified(engine, schema, name);
  if (engine === "postgres") {
    switch (kind) {
      case "view":
        return `DROP VIEW IF EXISTS ${qn};`;
      case "materialized_view":
        return `DROP MATERIALIZED VIEW IF EXISTS ${qn};`;
      case "function":
        return `DROP FUNCTION IF EXISTS ${qn}(${detail ?? ""});`;
      case "procedure":
        return `DROP PROCEDURE IF EXISTS ${qn}(${detail ?? ""});`;
      case "trigger":
        return `DROP TRIGGER IF EXISTS ${q(name)} ON ${qualified(engine, schema, detail ?? "")};`;
    }
  }
  if (engine === "mysql") {
    const kw =
      kind === "view"
        ? "VIEW"
        : kind === "function"
          ? "FUNCTION"
          : kind === "procedure"
            ? "PROCEDURE"
            : "TRIGGER";
    return `DROP ${kw} IF EXISTS ${qn};`;
  }
  // sqlite
  return `DROP ${kind === "view" ? "VIEW" : "TRIGGER"} IF EXISTS ${qn};`;
}

/** A runnable, editable form of an object's DDL for the SQL editor (design
 *  Prompt 5). Starts from the authoritative `ddl`; keeps `CREATE OR REPLACE`
 *  where the dialect supports it, otherwise prepends a `DROP … IF EXISTS` so
 *  re-running cleanly replaces the object. View/matview statements end with `;`. */
export function editableObjectDDL(
  engine: Engine,
  kind: DbObjectKind,
  schema: string,
  name: string,
  detail: string | null,
  ddl: string,
): string {
  let body = ddl.trimEnd();
  if ((kind === "view" || kind === "materialized_view") && !/;\s*$/.test(body)) body += ";";
  if (hasOrReplace(engine, kind)) return body;
  return dropPrefix(engine, kind, schema, name, detail) + "\n\n" + body;
}

/** `SELECT * FROM schema.name LIMIT n` for browse-as-data (views/matviews). */
export function browseSql(engine: Engine, schema: string, name: string, limit = 200): string {
  return `SELECT * FROM ${qualified(engine, schema, name)} LIMIT ${limit}`;
}

/** `REFRESH MATERIALIZED VIEW schema.name` (Postgres). */
export function refreshMatviewSql(engine: Engine, schema: string, name: string): string {
  return `REFRESH MATERIALIZED VIEW ${qualified(engine, schema, name)}`;
}
