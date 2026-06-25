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

import {
  listObjects,
  objectDefinition,
  tableMeta,
  type ColumnInfo,
  type DbObjectDefinition,
  type DbObjectInfo,
  type DbObjectKind,
  type TableInfo,
  type TableMeta,
} from "../../shared/api/engine";
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

/**
 * Cache key for a table's full {@link TableMeta} (M7 structure view §3.6).
 * Distinct from {@link columnsKey} — they share the `loading`/`errors` maps,
 * and the structure fetch's loading/error state is independent of the
 * column-list fetch the sidebar/grid drive. Still starts with the handle and
 * `tablesKey(handle, schema)` prefixes, so `invalidate` drops it like the rest.
 */
export function tableMetaKey(handleId: string, schema: string, table: string): string {
  return handleId + SEP + schema + SEP + table + SEP + "\u0001meta";
}

/** Cache key for one schema's object list of a given kind. Starts with the
 *  `tablesKey(handle, schema) + SEP` prefix so {@link invalidate} drops it too. */
export function objectsKey(handleId: string, schema: string, kind: DbObjectKind): string {
  return handleId + SEP + schema + SEP + "obj" + SEP + kind;
}

/** Cache key for one object's definition (DDL). Same schema prefix as above. */
export function objectDefKey(
  handleId: string,
  schema: string,
  kind: DbObjectKind,
  name: string,
): string {
  return handleId + SEP + schema + SEP + "def" + SEP + kind + SEP + name;
}

export interface TablesEntry {
  tables: TableInfo[];
  /** Epoch ms of the fetch — bumped by force refetches (refresh). */
  fetchedAt: number;
}

export interface ObjectsEntry {
  objects: DbObjectInfo[];
  fetchedAt: number;
}

export interface ObjectDefEntry {
  def: DbObjectDefinition;
  fetchedAt: number;
}

export interface ColumnsEntry {
  columns: ColumnInfo[];
  fetchedAt: number;
}

export interface TableMetaEntry {
  meta: TableMeta;
  fetchedAt: number;
}

interface IntrospectionFeatureState {
  /** Table lists by `tablesKey`. */
  tables: Record<string, TablesEntry>;
  /** Column lists by `columnsKey`. */
  columns: Record<string, ColumnsEntry>;
  /** Full table metadata by `tableMetaKey` (M7 structure view §3.6). */
  tableMetas: Record<string, TableMetaEntry>;
  /** Object lists (views/matviews/routines/triggers) by `objectsKey`. */
  objects: Record<string, ObjectsEntry>;
  /** Object definitions (DDL) by `objectDefKey`. */
  objectDefs: Record<string, ObjectDefEntry>;
  /** True while a fetch for the key (either kind) is in flight. */
  loading: Record<string, boolean>;
  /** Human error message for the key's last failed fetch (§5 style). */
  errors: Record<string, string>;
  /**
   * Fetch a schema's tables (cache-first; `force` refetches and overwrites).
   * Resolves with the table list, or null when the fetch failed — the error
   * text is in `errors` under the same key; this never rejects. A successful
   * forced refetch also drops the schema's cached column lists (stale for
   * the same reason the table list was) UNLESS `keepColumnCaches` is set.
   */
  loadTables: (
    handleId: string,
    schema: string,
    opts?: {
      force?: boolean;
      /**
       * Refetch the table list but KEEP the schema's cached column/meta caches.
       * The settings-driven auto-refresh tick uses this so it picks up new /
       * dropped tables without evicting an open Structure view's meta — which
       * would blank-then-refetch it on every tick. A manual refresh omits this
       * (full reintrospect, to catch out-of-band column DDL too).
       */
      keepColumnCaches?: boolean;
    },
  ) => Promise<TableInfo[] | null>;
  /** Fetch one table's columns (cache-first). Same error contract. */
  loadColumns: (handleId: string, schema: string, table: string) => Promise<ColumnInfo[] | null>;
  /**
   * Fetch one table's full {@link TableMeta} (cache-first) for the M7
   * structure view (§3.6). Same error contract as `loadColumns`: resolves
   * with the meta or null on failure (error text under `tableMetaKey`),
   * never rejects. As a side effect it also warms the `columns` cache from
   * the same payload (one round-trip serves both the structure rows and any
   * column-list reader for the same table).
   */
  loadTableMeta: (handleId: string, schema: string, table: string) => Promise<TableMeta | null>;
  /** Fetch one schema's objects of a kind (cache-first; `force` refetches).
   *  Same error contract as `loadTables` (null on failure, error under the
   *  objects key). */
  loadObjects: (
    handleId: string,
    schema: string,
    kind: DbObjectKind,
    opts?: { force?: boolean },
  ) => Promise<DbObjectInfo[] | null>;
  /** Fetch one object's definition DDL (cache-first). Same error contract. */
  loadObjectDefinition: (
    handleId: string,
    schema: string,
    kind: DbObjectKind,
    name: string,
    detail?: string | null,
  ) => Promise<DbObjectDefinition | null>;
  /** Drop cached object list(s) + the schema's object definitions after a
   *  create/alter/drop/refresh, so a refetch shows the new truth. With `kind`,
   *  only that kind's list is dropped; without, every kind for the schema. */
  invalidateObjects: (handleId: string, schema: string, kind?: DbObjectKind) => void;
  /** Drop only the schema's object LISTS (not the cached definitions), so a
   *  sidebar refresh picks up objects created/dropped out-of-band (e.g. in the
   *  SQL editor) without evicting an open viewer's DDL. */
  invalidateObjectLists: (handleId: string, schema: string) => void;
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
const inflightTableMetas = new Map<string, Promise<TableMeta | null>>();
const inflightObjects = new Map<string, Promise<DbObjectInfo[] | null>>();
const inflightObjectDefs = new Map<string, Promise<DbObjectDefinition | null>>();

export const useIntrospectionStore = create<IntrospectionFeatureState>((set, get) => ({
  tables: {},
  columns: {},
  tableMetas: {},
  objects: {},
  objectDefs: {},
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
          columns:
            opts?.force && !opts?.keepColumnCaches
              ? omitPrefixed(state.columns, key + SEP)
              : state.columns,
          tableMetas:
            opts?.force && !opts?.keepColumnCaches
              ? omitPrefixed(state.tableMetas, key + SEP)
              : state.tableMetas,
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

  loadTableMeta: (handleId, schema, table) => {
    const key = tableMetaKey(handleId, schema, table);
    const cached = get().tableMetas[key];
    if (cached) return Promise.resolve(cached.meta);
    const pending = inflightTableMetas.get(key);
    if (pending) return pending;
    const promise = (async (): Promise<TableMeta | null> => {
      set((state) => ({ loading: { ...state.loading, [key]: true } }));
      try {
        const meta = await tableMeta(handleId, schema, table);
        const colKey = columnsKey(handleId, schema, table);
        const now = Date.now();
        set((state) => ({
          tableMetas: { ...state.tableMetas, [key]: { meta, fetchedAt: now } },
          // One round-trip serves both: warm the column-list cache too, so a
          // later sidebar/grid/filter read does not re-fetch.
          columns: { ...state.columns, [colKey]: { columns: meta.columns, fetchedAt: now } },
          loading: omit(state.loading, key),
          errors: omit(state.errors, key),
        }));
        return meta;
      } catch (err) {
        set((state) => ({
          loading: omit(state.loading, key),
          errors: {
            ...state.errors,
            [key]: appErrorMessage(err, "Could not load table structure."),
          },
        }));
        return null;
      }
    })();
    inflightTableMetas.set(key, promise);
    void promise.finally(() => {
      if (inflightTableMetas.get(key) === promise) inflightTableMetas.delete(key);
    });
    return promise;
  },

  loadObjects: (handleId, schema, kind, opts) => {
    const key = objectsKey(handleId, schema, kind);
    if (!opts?.force) {
      const cached = get().objects[key];
      if (cached) return Promise.resolve(cached.objects);
      const pending = inflightObjects.get(key);
      if (pending) return pending;
    }
    const promise = (async (): Promise<DbObjectInfo[] | null> => {
      set((state) => ({ loading: { ...state.loading, [key]: true } }));
      try {
        const objects = await listObjects(handleId, schema, kind);
        set((state) => ({
          objects: { ...state.objects, [key]: { objects, fetchedAt: Date.now() } },
          loading: omit(state.loading, key),
          errors: omit(state.errors, key),
        }));
        return objects;
      } catch (err) {
        set((state) => ({
          loading: omit(state.loading, key),
          errors: { ...state.errors, [key]: appErrorMessage(err, "Could not load objects.") },
        }));
        return null;
      }
    })();
    inflightObjects.set(key, promise);
    void promise.finally(() => {
      if (inflightObjects.get(key) === promise) inflightObjects.delete(key);
    });
    return promise;
  },

  loadObjectDefinition: (handleId, schema, kind, name, detail) => {
    const key = objectDefKey(handleId, schema, kind, name);
    const cached = get().objectDefs[key];
    if (cached) return Promise.resolve(cached.def);
    const pending = inflightObjectDefs.get(key);
    if (pending) return pending;
    const promise = (async (): Promise<DbObjectDefinition | null> => {
      set((state) => ({ loading: { ...state.loading, [key]: true } }));
      try {
        const def = await objectDefinition(handleId, schema, kind, name, detail);
        set((state) => ({
          objectDefs: { ...state.objectDefs, [key]: { def, fetchedAt: Date.now() } },
          loading: omit(state.loading, key),
          errors: omit(state.errors, key),
        }));
        return def;
      } catch (err) {
        set((state) => ({
          loading: omit(state.loading, key),
          errors: {
            ...state.errors,
            [key]: appErrorMessage(err, "Could not load the object definition."),
          },
        }));
        return null;
      }
    })();
    inflightObjectDefs.set(key, promise);
    void promise.finally(() => {
      if (inflightObjectDefs.get(key) === promise) inflightObjectDefs.delete(key);
    });
    return promise;
  },

  invalidateObjects: (handleId, schema, kind) =>
    set((state) => {
      const objects =
        kind === undefined
          ? omitPrefixed(state.objects, handleId + SEP + schema + SEP)
          : omit(state.objects, objectsKey(handleId, schema, kind));
      // Definitions are cheap to refetch — drop the schema's whole def cache on
      // any object change so a re-opened viewer shows committed truth.
      const objectDefs = omitPrefixed(state.objectDefs, handleId + SEP + schema + SEP);
      return { objects, objectDefs };
    }),

  invalidateObjectLists: (handleId, schema) =>
    set((state) => ({
      objects: omitPrefixed(state.objects, handleId + SEP + schema + SEP),
    })),

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
        tableMetas: drop(state.tableMetas),
        objects: drop(state.objects),
        objectDefs: drop(state.objectDefs),
        errors: drop(state.errors),
      };
    }),
}));
