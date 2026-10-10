// The "This workspace" live source (M37 Task 7): the attached connection's real
// schema, in board column shape.
//
// The board's column model is deliberately smaller than {@link TableMeta} — a
// name, a type, and the three flags the diff and the DDL care about. Narrowing
// here (rather than teaching the diff about engine metadata) is what lets the
// same `diffBoard` run against the sample schema and a real Postgres one.
//
// Types are lower-cased so a comparison against what the board offers in its
// type select ("bigint", "timestamptz") doesn't report a change just because the
// engine reports `BIGINT`.

import type { TableMeta } from "../../shared/api/engine";
import type { LiveSchema } from "./model";

/**
 * Convert introspected table metas into a {@link LiveSchema}. A column's FK
 * target is reduced to the table NAME, matching the board's own
 * {@link BoardColumn.fk} convention, so a relation drawn on the board and one
 * read from the database resolve identically.
 */
export function liveFromMetas(metas: Record<string, TableMeta>): LiveSchema {
  const live: LiveSchema = {};
  for (const [table, meta] of Object.entries(metas)) {
    live[table] = meta.columns.map((column) => ({
      name: column.name,
      type: String(column.dataType || "text").toLowerCase(),
      pk: column.pk,
      fk: column.fk ? column.fk.table : null,
      nullable: column.nullable,
    }));
  }
  return live;
}
