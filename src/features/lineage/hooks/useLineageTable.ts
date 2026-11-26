// Row lineage (M50): does this table take part in any declared foreign key?
// Read from the introspection cache (the table's `TableMeta` carries both
// directions); the first ask for a table warms it, every later one is free.
// Returns the table's single-column primary key when lineage can open one of
// its rows, else null.

import { useEffect } from "react";

import { tableMetaKey, useIntrospectionStore } from "../../introspection/state";
import { isLinked, shapeOf } from "../model";

export function useLineageTable(
  handleId: string | undefined,
  schema: string,
  table: string | undefined,
): string | null {
  const key = handleId && table ? tableMetaKey(handleId, schema, table) : null;
  const entry = useIntrospectionStore((s) => (key ? s.tableMetas[key] : undefined));
  const failed = useIntrospectionStore((s) => (key ? !!s.errors[key] : false));
  const loadTableMeta = useIntrospectionStore((s) => s.loadTableMeta);
  useEffect(() => {
    if (handleId && table && !entry && !failed) void loadTableMeta(handleId, schema, table);
  }, [handleId, schema, table, entry, failed, loadTableMeta]);
  if (!entry || !table) return null;
  const shape = shapeOf(table, entry.meta);
  return isLinked(shape) ? shape.pk : null;
}
