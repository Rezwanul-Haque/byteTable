// The "This workspace" live schema (M37 Task 7): introspect every table in the
// schema and hand the board a {@link LiveSchema} to diff against.
//
// Loaded LAZILY — only while that source is selected. A board compared against
// the sample DB, or standalone, must not introspect a 400-table schema it has no
// use for. The introspection store de-duplicates and caches per
// (handle, schema, table), so this also warms the sidebar and the schema map;
// there is no bulk meta command, so the per-table fetches go out in parallel
// (the same approach SchemaMap takes).
//
// `loading` and the returned schema are DERIVED from one piece of state — the
// result, tagged with the request it answered. That is what keeps every
// `setState` inside the async callback, where it belongs, instead of in the
// effect body: a disabled hook simply has no result for the current request, and
// needs no state change to say so.
//
// A table whose structure can't be read is dropped rather than failing the whole
// diff: the board is sketch work, and comparing against 39 of 40 tables is far
// more useful than comparing against none.

import { useEffect, useState } from "react";

import type { TableMeta } from "../../../shared/api/engine";
import { useIntrospectionStore } from "../../introspection/state";
import { liveFromMetas } from "../live";
import type { LiveSchema } from "../model";

/** Stable empty schema, so a disabled hook does not hand out a fresh object on
 *  every render and invalidate its consumers' memos. */
const EMPTY: LiveSchema = {};

export interface BoardLiveState {
  live: LiveSchema;
  loading: boolean;
}

export function useBoardLive(handleId: string, schema: string, enabled: boolean): BoardLiveState {
  const loadTables = useIntrospectionStore((s) => s.loadTables);
  const loadTableMeta = useIntrospectionStore((s) => s.loadTableMeta);
  /** The last completed load, tagged with the request it answered. */
  const [result, setResult] = useState<{ key: string; live: LiveSchema } | null>(null);

  // null while this source isn't selected — the effect then has nothing to do.
  // Only ever compared, never parsed, so the join needs no escaping.
  const key = enabled ? handleId + "/" + schema : null;

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    void (async () => {
      const tables = await loadTables(handleId, schema);
      if (cancelled) return;
      if (!tables) {
        setResult({ key, live: EMPTY });
        return;
      }
      const results = await Promise.all(
        tables.map(async (t) => [t.name, await loadTableMeta(handleId, schema, t.name)] as const),
      );
      if (cancelled) return;
      const metas: Record<string, TableMeta> = {};
      for (const [name, meta] of results) if (meta) metas[name] = meta;
      setResult({ key, live: liveFromMetas(metas) });
    })();
    return () => {
      cancelled = true;
    };
  }, [key, handleId, schema, loadTables, loadTableMeta]);

  const fresh = key !== null && result?.key === key;
  return { live: fresh ? result.live : EMPTY, loading: key !== null && !fresh };
}
