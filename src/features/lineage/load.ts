// Row lineage (M50): loading the graph for one row. The prototype holds every
// row in memory; here each piece is a bounded query, so the whole thing costs a
// fixed number of round-trips whatever the row counts are:
//
//   - the centre row: one lookup by primary key;
//   - parents: one `WHERE refCol IN (…)` per (target table, column);
//   - each stack: `COUNT(*)` and the first CHILD_LIMIT rows (ordered by key),
//     as two queries run side by side, each with a timeout, so a slow count
//     shows "count unavailable" without holding back the rows;
//   - hops (the second step, drawn as text): one `IN (…)` per target table for
//     all the rows that need it.
//
// Every read goes through `rows_fetch` / `row_lookup`, which bind their values
// — lineage never builds SQL text and never writes.
//
// Results stream into a `LineageData` through `update`, so each stack draws as
// soon as its own queries return.

import type { CellValue, FetchRowsRequest, FilterSpec, RowsPage } from "../../shared/api/engine";
import { appErrorMessage } from "../../shared/api/error";
import { t } from "../../shared/i18n";
import { isBinaryType } from "../browse/shared/binaryCell";
import { rowOf, sameValue, type Fk, type InFk, type Row, type TableShape } from "./model";

/** Rows listed per stack. */
export const CHILD_LIMIT = 8;
/** Per-query timeout. A query that runs past it is abandoned, not cancelled. */
export const QUERY_TIMEOUT_MS = 10_000;
/** Stacks loading at once, so a table referenced from 30 places does not
 *  queue 60 queries on the connection pool in one go. */
const MAX_PARALLEL = 4;
/** Values per `IN (…)` lookup. */
const MAX_IN = 200;

/** The three reads lineage makes; the hook binds them to a connection. */
export interface LineageApi {
  shape(table: string): Promise<TableShape | null>;
  rows(req: Omit<FetchRowsRequest, "schema">): Promise<RowsPage>;
  count(table: string, col: string, value: CellValue, binary: boolean): Promise<number>;
}

export type ParentState = "loading" | "ok" | "null" | "missing" | "error";

/** One foreign key on the centre row (left side). */
export interface ParentNode extends Fk {
  value: CellValue;
  state: ParentState;
}

/** One table (and column) whose rows point at the centre row (right side). */
export interface GroupNode extends InFk {
  value: CellValue;
  status: "loading" | "ready" | "error";
  rows: Row[];
  /** Every matching row; null until known. */
  count: number | null;
  countState: "loading" | "ready" | "unavailable";
  error?: string;
}

export interface LineageData {
  status: "loading" | "ready" | "no-row" | "no-table" | "error";
  error?: string;
  table: string;
  key: CellValue;
  row: Row | null;
  shapes: Record<string, TableShape>;
  parents: ParentNode[];
  groups: GroupNode[];
  /** Rows reached by a foreign key (parents and hops), by `targetKey`; null
   *  means "looked up, no such row". Absent means not looked up (or failed). */
  targets: Record<string, Row | null>;
}

export type Update = (fn: (d: LineageData) => LineageData) => void;

export const targetKey = (table: string, col: string, value: CellValue): string =>
  table + "\u0000" + col + "\u0000" + String(value);

export function initialData(table: string, key: CellValue): LineageData {
  return {
    status: "loading",
    table,
    key,
    row: null,
    shapes: {},
    parents: [],
    groups: [],
    targets: {},
  };
}

export class LineageTimeout extends Error {
  constructor() {
    super(t("lineage.err.timeout"));
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LineageTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function binaryCol(shape: TableShape | undefined, col: string): boolean {
  return isBinaryType(shape?.columns.find((c) => c.name === col)?.dataType);
}

function matchFilter(col: string, values: CellValue[], binary: boolean): FilterSpec {
  const item =
    values.length === 1
      ? { column: col, op: "eq" as const, value: values[0] ?? null, binary }
      : { column: col, op: "inList" as const, value: values, binary };
  return { mode: "conditions", combinator: "and", items: [item] };
}

/** A row a foreign key should reach: `table.col = value`. */
interface Want {
  table: string;
  col: string;
  value: CellValue;
}

/**
 * Look up the rows a set of foreign keys point at, batched: one `IN (…)` per
 * (table, column). Values already in `have` are skipped. A looked-up value
 * with no row comes back as null (a broken reference); a failed lookup leaves
 * its values out, so the caller can tell "missing" from "could not tell".
 */
export async function resolveTargets(
  api: LineageApi,
  wants: Want[],
  have: Record<string, Row | null>,
): Promise<Record<string, Row | null>> {
  const batches = new Map<string, { table: string; col: string; values: Map<string, CellValue> }>();
  for (const w of wants) {
    if (w.value === null || w.value === undefined) continue;
    const k = targetKey(w.table, w.col, w.value);
    if (k in have) continue;
    const bk = w.table + "\u0000" + w.col;
    let b = batches.get(bk);
    if (!b) batches.set(bk, (b = { table: w.table, col: w.col, values: new Map() }));
    b.values.set(String(w.value), w.value);
  }
  const found: Record<string, Row | null> = {};
  await Promise.all(
    [...batches.values()].map(async (b) => {
      const shape = await api.shape(b.table).catch(() => null);
      const values = [...b.values.values()];
      for (let i = 0; i < values.length; i += MAX_IN) {
        const chunk = values.slice(i, i + MAX_IN);
        try {
          const page = await withTimeout(
            api.rows({
              table: b.table,
              sort: null,
              filter: matchFilter(b.col, chunk, binaryCol(shape ?? undefined, b.col)),
              offset: 0,
              limit: chunk.length,
              skipCount: true,
            }),
            QUERY_TIMEOUT_MS,
          );
          const rows = page.rows.map((r) => rowOf(page.columns, r));
          for (const v of chunk) {
            found[targetKey(b.table, b.col, v)] = rows.find((r) => sameValue(r[b.col], v)) ?? null;
          }
        } catch {
          // Left out: the caller shows these as unresolved, not as broken.
        }
      }
    }),
  );
  return found;
}

/** The rows `rows` (in `shape`) point at through their foreign keys, except
 *  through `skipCol` (the key pointing back at the centre). */
function hopWants(shape: TableShape, rows: Row[], skipCol?: string): Want[] {
  const wants: Want[] = [];
  for (const f of shape.fks) {
    if (f.col === skipCol) continue;
    for (const r of rows) wants.push({ table: f.refTable, col: f.refCol, value: r[f.col] ?? null });
  }
  return wants;
}

async function loadHops(
  api: LineageApi,
  shape: TableShape,
  rows: Row[],
  update: Update,
  alive: () => boolean,
  skipCol?: string,
) {
  if (!rows.length || !shape.fks.length) return;
  const wants = hopWants(shape, rows, skipCol);
  // The hop's own table names its label, so its shape is needed too.
  const [shapes, found] = await Promise.all([
    shapesFor(
      api,
      wants.map((w) => w.table),
    ),
    resolveTargets(api, wants, {}),
  ]);
  if (!alive()) return;
  update((d) => ({
    ...d,
    shapes: { ...d.shapes, ...shapes },
    targets: { ...d.targets, ...found },
  }));
}

async function shapesFor(api: LineageApi, names: string[]): Promise<Record<string, TableShape>> {
  const out: Record<string, TableShape> = {};
  await Promise.all(
    [...new Set(names)].map(async (n) => {
      const s = await api.shape(n).catch(() => null);
      if (s) out[n] = s;
    }),
  );
  return out;
}

async function loadParents(
  api: LineageApi,
  parents: ParentNode[],
  update: Update,
  alive: () => boolean,
) {
  const live = parents.filter((p) => p.state === "loading");
  if (!live.length) return;
  const shapes = await shapesFor(
    api,
    live.map((p) => p.refTable),
  );
  const found = await resolveTargets(
    api,
    live.map((p) => ({ table: p.refTable, col: p.refCol, value: p.value })),
    {},
  );
  if (!alive()) return;
  update((d) => ({
    ...d,
    shapes: { ...d.shapes, ...shapes },
    targets: { ...d.targets, ...found },
    parents: d.parents.map((p) => {
      if (p.state !== "loading") return p;
      const k = targetKey(p.refTable, p.refCol, p.value);
      return { ...p, state: !(k in found) ? "error" : found[k] ? "ok" : "missing" };
    }),
  }));
  // One more step on each parent: where does IT point?
  await Promise.all(
    live.map(async (p) => {
      const row = found[targetKey(p.refTable, p.refCol, p.value)];
      const shape = shapes[p.refTable];
      if (row && shape) await loadHops(api, shape, [row], update, alive);
    }),
  );
}

const patchGroup =
  (i: number, patch: Partial<GroupNode>) =>
  (d: LineageData): LineageData => ({
    ...d,
    groups: d.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)),
  });

/** One stack: its first rows and its count, side by side, then its hops. */
export async function loadGroup(
  api: LineageApi,
  group: GroupNode,
  i: number,
  update: Update,
  alive: () => boolean,
): Promise<void> {
  let shape: TableShape | null;
  try {
    shape = await api.shape(group.table);
  } catch (err) {
    shape = null;
    if (alive())
      update(
        patchGroup(i, { status: "error", error: appErrorMessage(err, t("lineage.err.load")) }),
      );
    return;
  }
  if (!alive()) return;
  if (!shape) {
    update(patchGroup(i, { status: "error", error: t("lineage.err.load") }));
    return;
  }
  const s = shape;
  update((d) => ({ ...d, shapes: { ...d.shapes, [s.name]: s } }));
  const binary = binaryCol(s, group.col);
  let exact = false;

  const rows = withTimeout(
    api.rows({
      table: group.table,
      sort: s.pk ? { column: s.pk, direction: "asc" } : null,
      filter: matchFilter(group.col, [group.value], binary),
      offset: 0,
      limit: CHILD_LIMIT,
      skipCount: true,
    }),
    QUERY_TIMEOUT_MS,
  ).then(
    async (page) => {
      if (!alive()) return;
      const list = page.rows.map((r) => rowOf(page.columns, r));
      // Fewer rows than asked for IS the count; no need to wait for it.
      exact = list.length < CHILD_LIMIT;
      update(
        patchGroup(i, {
          status: "ready",
          rows: list,
          ...(exact ? { count: list.length, countState: "ready" as const } : {}),
        }),
      );
      await loadHops(api, s, list, update, alive, group.col);
    },
    (err: unknown) => {
      if (alive()) {
        update(
          patchGroup(i, { status: "error", error: appErrorMessage(err, t("lineage.err.load")) }),
        );
      }
    },
  );

  const count = withTimeout(
    api.count(group.table, group.col, group.value, binary),
    QUERY_TIMEOUT_MS,
  ).then(
    (n) => {
      if (alive() && !exact) update(patchGroup(i, { count: n, countState: "ready" }));
    },
    () => {
      if (alive() && !exact) update(patchGroup(i, { countState: "unavailable" }));
    },
  );

  await Promise.all([rows, count]);
}

/** Run `jobs` with at most `n` in flight. */
async function pool(jobs: (() => Promise<void>)[], n: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) await job();
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
}

/** Load the graph for `table`'s row with primary key `key`. */
export async function loadLineage(
  api: LineageApi,
  table: string,
  key: CellValue,
  update: Update,
  alive: () => boolean,
): Promise<void> {
  const fail = (err: unknown) => {
    if (alive()) {
      update((d) => ({
        ...d,
        status: "error",
        error: appErrorMessage(err, t("lineage.err.load")),
      }));
    }
  };
  let shape: TableShape | null;
  try {
    shape = await api.shape(table);
  } catch (err) {
    fail(err);
    return;
  }
  if (!alive()) return;
  if (!shape) {
    fail(null);
    return;
  }
  if (!shape.pk) {
    update((d) => ({ ...d, status: "no-table", shapes: { [table]: shape } }));
    return;
  }
  let row: Row | null;
  try {
    const page = await withTimeout(
      api.rows({
        table,
        sort: null,
        filter: matchFilter(shape.pk, [key], binaryCol(shape, shape.pk)),
        offset: 0,
        limit: 1,
        skipCount: true,
      }),
      QUERY_TIMEOUT_MS,
    );
    row = page.rows[0] ? rowOf(page.columns, page.rows[0]) : null;
  } catch (err) {
    fail(err);
    return;
  }
  if (!alive()) return;
  if (!row) {
    update((d) => ({ ...d, status: "no-row", shapes: { [table]: shape } }));
    return;
  }

  const r = row;
  const parents: ParentNode[] = shape.fks.map((f) => {
    const value = r[f.col] ?? null;
    return { ...f, value, state: value === null ? "null" : "loading" };
  });
  const groups: GroupNode[] = shape.refs.map((ref) => {
    const value = r[ref.refCol] ?? null;
    // An empty referenced column cannot be pointed at: an empty stack, known now.
    return value === null
      ? { ...ref, value, status: "ready", rows: [], count: 0, countState: "ready" }
      : { ...ref, value, status: "loading", rows: [], count: null, countState: "loading" };
  });
  update((d) => ({
    ...d,
    status: "ready",
    row: r,
    shapes: { ...d.shapes, [table]: shape },
    parents,
    groups,
  }));

  await Promise.all([
    loadParents(api, parents, update, alive),
    pool(
      groups.map(
        (g, i) => () =>
          g.status === "loading" ? loadGroup(api, g, i, update, alive) : Promise.resolve(),
      ),
      MAX_PARALLEL,
    ),
  ]);
}
