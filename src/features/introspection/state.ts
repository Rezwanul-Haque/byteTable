// Renderer side of the introspection slice (ARCHITECTURE §2): a cache of
// what the backend's introspection commands returned, keyed by
// (handleId, schema) for table lists and (handleId, schema, table) for
// column lists.
//
// The cache deliberately lives outside the workspaces store so it survives
// workspace switches — switching back to a workspace re-renders its sidebar
// instantly from cache. It is invalidated explicitly: the sidebar's refresh
// force-refetches a schema's tables (which drops that schema's column
// entries — they may be stale for the same reason the table list was), and
// closing a workspace drops everything under its handle.
//
// Cross-slice note: `connectionTables` comes from the connections slice's
// public contract (api.ts) — the backend keeps the `connection_tables`
// command there; `tableMeta` is the engine-shared `table_meta` wrapper.

import { create } from "zustand";

import { tableMeta, type ColumnInfo, type TableInfo } from "../../shared/api/engine";
import { appErrorMessage } from "../../shared/api/error";
import { connectionTables } from "../connections/api";

/**
 * Composite-key separator. NUL cannot appear in a handle id (UUID) and is
 * not meaningful in schema/table identifiers, so keys never collide.
 */
const SEP = "\u0000";

/** Cache key for a schema's table list. */
export function tablesKey(handleId: string, schema: string): string {
  return handleId + SEP + schema;
}

/** Cache key for a table's column list. */
export function columnsKey(handleId: string, schema: string, table: string): string {
  return handleId + SEP + schema + SEP + table;
}

export interface TablesEntry {
  tables: TableInfo[];
  /** Epoch ms of the fetch — bumped by force refetches (refresh). */
  fetchedAt: number;
}

export interface ColumnsEntry {
  columns: ColumnInfo[];
  fetchedAt: number;
}

interface IntrospectionFeatureState {
  /** Table lists by `tablesKey`. */
  tables: Record<string, TablesEntry>;
  /** Column lists by `columnsKey`. */
  columns: Record<string, ColumnsEntry>;
  /** True while a fetch for the key (either kind) is in flight. */
  loading: Record<string, boolean>;
  /** Human error message for the key's last failed fetch (§5 style). */
  errors: Record<string, string>;
  /**
   * Fetch a schema's tables (cache-first; `force` refetches and overwrites).
   * Resolves with the table list, or null when the fetch failed — the error
   * text is in `errors` under the same key; this never rejects. A successful
   * forced refetch also drops the schema's cached column lists (stale for
   * the same reason the table list was).
   */
  loadTables: (
    handleId: string,
    schema: string,
    opts?: { force?: boolean },
  ) => Promise<TableInfo[] | null>;
  /** Fetch one table's columns (cache-first). Same error contract. */
  loadColumns: (handleId: string, schema: string, table: string) => Promise<ColumnInfo[] | null>;
  /**
   * Drop everything cached for a handle (workspace closed), or for one of
   * its schemas when `schema` is given.
   */
  invalidate: (handleId: string, schema?: string) => void;
}

/** Record minus one key (same reference when absent). */
function omit<V>(record: Record<string, V>, key: string): Record<string, V> {
  if (!(key in record)) return record;
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/** Record minus every key starting with `prefix`. */
function omitPrefixed<V>(record: Record<string, V>, prefix: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith(prefix)));
}

// In-flight promises by key, for de-duping concurrent non-force loads
// (e.g. StrictMode's doubled dev effects). Module-local — promises are not
// renderable state, so they stay out of the store.
const inflightTables = new Map<string, Promise<TableInfo[] | null>>();
const inflightColumns = new Map<string, Promise<ColumnInfo[] | null>>();

export const useIntrospectionStore = create<IntrospectionFeatureState>((set, get) => ({
  tables: {},
  columns: {},
  loading: {},
  errors: {},

  loadTables: (handleId, schema, opts) => {
    const key = tablesKey(handleId, schema);
    if (!opts?.force) {
      const cached = get().tables[key];
      if (cached) return Promise.resolve(cached.tables);
      const pending = inflightTables.get(key);
      if (pending) return pending;
    }
    const promise = (async (): Promise<TableInfo[] | null> => {
      set((state) => ({ loading: { ...state.loading, [key]: true } }));
      try {
        const tables = await connectionTables(handleId, schema);
        set((state) => ({
          tables: { ...state.tables, [key]: { tables, fetchedAt: Date.now() } },
          // A fresh table list invalidates the schema's column caches —
          // refresh exists to pick up out-of-band DDL, which affects
          // columns as much as tables. Expanded rows refetch lazily.
          columns: opts?.force ? omitPrefixed(state.columns, key + SEP) : state.columns,
          loading: omit(state.loading, key),
          errors: omit(state.errors, key),
        }));
        return tables;
      } catch (err) {
        set((state) => ({
          loading: omit(state.loading, key),
          errors: { ...state.errors, [key]: appErrorMessage(err, "Could not load tables.") },
        }));
        return null;
      }
    })();
    inflightTables.set(key, promise);
    void promise.finally(() => {
      if (inflightTables.get(key) === promise) inflightTables.delete(key);
    });
    return promise;
  },

  loadColumns: (handleId, schema, table) => {
    const key = columnsKey(handleId, schema, table);
    const cached = get().columns[key];
    if (cached) return Promise.resolve(cached.columns);
    const pending = inflightColumns.get(key);
    if (pending) return pending;
    const promise = (async (): Promise<ColumnInfo[] | null> => {
      set((state) => ({ loading: { ...state.loading, [key]: true } }));
      try {
        const meta = await tableMeta(handleId, schema, table);
        set((state) => ({
          columns: { ...state.columns, [key]: { columns: meta.columns, fetchedAt: Date.now() } },
          loading: omit(state.loading, key),
          errors: omit(state.errors, key),
        }));
        return meta.columns;
      } catch (err) {
        set((state) => ({
          loading: omit(state.loading, key),
          errors: { ...state.errors, [key]: appErrorMessage(err, "Could not load columns.") },
        }));
        return null;
      }
    })();
    inflightColumns.set(key, promise);
    void promise.finally(() => {
      if (inflightColumns.get(key) === promise) inflightColumns.delete(key);
    });
    return promise;
  },

  invalidate: (handleId, schema) =>
    set((state) => {
      // tablesKey(handle, schema) is itself a prefix of that schema's
      // column keys, so one prefix covers both maps; without a schema the
      // handle prefix covers every schema.
      const prefix = schema === undefined ? handleId + SEP : tablesKey(handleId, schema) + SEP;
      const exactTables = schema === undefined ? null : tablesKey(handleId, schema);
      const drop = <V>(record: Record<string, V>): Record<string, V> => {
        const pruned = omitPrefixed(record, prefix);
        return exactTables === null ? pruned : omit(pruned, exactTables);
      };
      return {
        tables: drop(state.tables),
        columns: drop(state.columns),
        errors: drop(state.errors),
      };
    }),
}));
