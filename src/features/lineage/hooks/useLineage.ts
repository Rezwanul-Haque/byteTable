// Row lineage (M50): the graph for one row, loaded through the connection and
// streamed into state as each piece returns (see `load.ts`). Table shapes come
// from the introspection cache, so walking between rows of tables already seen
// costs no catalogue queries.

import { useCallback, useEffect, useMemo, useState } from "react";

import { rowLookup, rowsFetch, type CellValue } from "../../../shared/api/engine";
import { useIntrospectionStore } from "../../introspection/state";
import { initialData, loadGroup, loadLineage, type LineageApi, type LineageData } from "../load";
import { shapeOf } from "../model";

export function useLineage(
  handleId: string,
  schema: string,
  table: string,
  key: CellValue,
): { data: LineageData; retryGroup: (i: number) => void } {
  const loadTableMeta = useIntrospectionStore((s) => s.loadTableMeta);
  const api = useMemo<LineageApi>(
    () => ({
      shape: async (name) => {
        const meta = await loadTableMeta(handleId, schema, name);
        return meta ? shapeOf(name, meta) : null;
      },
      rows: (req) => rowsFetch(handleId, { schema, ...req }),
      count: async (name, column, value, binary) =>
        (await rowLookup(handleId, { schema, table: name, column, value, binary })).matchCount,
    }),
    [handleId, schema, loadTableMeta],
  );

  const keyText = JSON.stringify(key);
  // State is tagged with the load it belongs to: a reply from an earlier row
  // (or connection) carries another id and is dropped.
  const id = handleId + "\u0000" + schema + "\u0000" + table + "\u0000" + keyText;
  const [state, setState] = useState(() => ({ id, data: initialData(table, key) }));
  if (state.id !== id) setState({ id, data: initialData(table, key) });
  const updater = useCallback(
    (fn: (d: LineageData) => LineageData) =>
      setState((s) => (s.id === id ? { id, data: fn(s.data) } : s)),
    [id],
  );

  useEffect(() => {
    let live = true;
    void loadLineage(api, table, JSON.parse(keyText) as CellValue, updater, () => live);
    return () => {
      live = false;
    };
  }, [api, table, keyText, updater]);

  const data = state.id === id ? state.data : initialData(table, key);
  const retryGroup = (i: number) => {
    const group = data.groups[i];
    if (!group) return;
    const reset = {
      ...group,
      status: "loading" as const,
      count: null,
      countState: "loading" as const,
    };
    updater((d) => ({ ...d, groups: d.groups.map((g, j) => (j === i ? reset : g)) }));
    void loadGroup(api, reset, i, updater, () => true);
  };

  return { data, retryGroup };
}
