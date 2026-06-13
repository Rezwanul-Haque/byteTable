// Virtualized data grid (spec §3.5, MILESTONES M4) — ported behavior from the
// prototype's grid.jsx, with the real backend's LIMIT/OFFSET paging behind it.
//
// VIRTUALIZATION + PAGING (see report for tradeoffs):
//   - Row axis is virtualized with @tanstack/react-virtual: the scroll
//     container is sized to `totalRows × rowHeight`, so the scrollbar reflects
//     the true table size, but only the visible rows (+ overscan) are in the
//     DOM. This is what makes a 1M-row table scroll at 60fps without holding a
//     million <div>s.
//   - Rows are loaded in PAGES of PAGE_SIZE into a SPARSE cache keyed by
//     absolute row index. As the viewport moves, we fetch the page(s)
//     overlapping the visible range (+ a small page overscan). Rows whose page
//     has not yet arrived render a shimmer skeleton. We never load all rows.
//   - Sort and refresh reset the cache and re-fetch from offset 0.
//
// EXTENSIBILITY SEAMS (commented inline, NOT built this milestone):
//   - M5  filters → a `where`/filter param threads into FetchRowsRequest and
//          resets the window like sort does.
//   - M10 FK hop + column insights → the header hosts an insights icon on
//          hover; FK cells become accent links opening a peek popover. The
//          header/cell structure is kept so those slot in without a rewrite.
//   - M11 inline edit → double-click a cell → in-cell input (.cell-input /
//          .cell-editing CSS already ported). onDoubleClick seam left on td.

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  CellValue,
  ColumnMeta,
  FilterSpec,
  FkRef,
  PkPredicate,
  SortSpec,
} from "../../../shared/api/engine";
import { rowsFetch, rowUpdate } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { useTabMetaStore } from "../../workspaces/tabMeta";
import { ColumnInsights, type InsightsAnchor } from "./ColumnInsights";
import { FkPeek, type FkPeekAnchor } from "./FkPeek";
import { CellContent } from "./GridCell";
import "./DataGrid.css";

/** Per-column metadata the grid keeps from tableMeta: pk/fk drive icons + FK
 *  hop (M10); dataType/nullable drive M11 inline-edit type coercion + the
 *  pk-predicate / editability gate. */
interface ColCellMeta {
  pk: boolean;
  fk: FkRef | null;
  /** Declared DDL type (may be empty); used for edit-commit type coercion. */
  dataType: string;
  /** True when the column has no NOT NULL constraint (empty input → NULL). */
  nullable: boolean;
}

/** The in-flight inline edit: which cell, and the draft text in the input. */
interface EditState {
  /** Absolute row index in the sparse cache. */
  row: number;
  /** Column index into `columns`. */
  col: number;
  /** The text the borderless input currently holds. */
  draft: string;
}

/** A commit awaiting the production-confirm modal: everything `commitEdit`
 *  computed, parked so Confirm/Cancel can finish (or abort) it. */
interface PendingConfirm {
  row: number;
  col: number;
  column: string;
  value: CellValue;
  prior: CellValue;
  pk: PkPredicate[];
  /** Cosmetic SQL shown in the confirm dialog (built from the coerced value). */
  display: string;
}

/** SQLite type-affinity buckets we coerce edit input into. Keyword-based, the
 *  same heuristic the engine's affinity rules use — declared type is a free
 *  string, so we match substrings (case-insensitive). */
function affinityOf(dataType: string): "integer" | "real" | "boolean" | "text" {
  const t = dataType.toUpperCase();
  if (t.includes("BOOL")) return "boolean";
  if (t.includes("INT")) return "integer";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("DEC") || t.includes("NUM"))
    return "real";
  return "text";
}

/**
 * Coerce the input string to the JSON value the backend binds by type.
 * - empty input → null when the column is nullable (else fall through to text,
 *   so a NOT NULL column surfaces the engine's rejection on commit).
 * - integer/real columns → a Number when the trimmed text parses; otherwise
 *   the raw string (the engine validates / rejects).
 * - boolean columns → 1/0 (SQLite stores booleans as integers; the grid shows
 *   true/false) for "true"/"false"/"1"/"0"; otherwise the raw string. We send
 *   the integer rather than a JS bool because the wire `CellValue` is
 *   string|number|null (SQLite has no native bool) — the engine binds the
 *   integer exactly as SQLite stores it.
 * - everything else → the string verbatim.
 */
function coerceForColumn(draft: string, meta: ColCellMeta | undefined): CellValue {
  const affinity = meta ? affinityOf(meta.dataType) : "text";
  const trimmed = draft.trim();
  if (trimmed === "" && (meta?.nullable ?? true)) return null;
  if (affinity === "integer" || affinity === "real") {
    if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
    return draft;
  }
  if (affinity === "boolean") {
    const low = trimmed.toLowerCase();
    if (low === "true" || low === "1") return 1;
    if (low === "false" || low === "0") return 0;
    return draft;
  }
  return draft;
}

/** Single-quote-escape a value for the *cosmetic* confirm-dialog SQL. The real
 *  query is parameterized server-side; this is display only (mirrors the
 *  backend's UpdateResult.statement rendering). */
function sqlLiteral(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Rows fetched per page. Small enough that a single page is cheap, large
 *  enough that a viewport rarely spans more than two. */
const PAGE_SIZE = 200;
/** Extra pages to prefetch on either side of the visible range. */
const PAGE_OVERSCAN = 1;
/** Row overscan handed to the virtualizer (DOM rows beyond the viewport). */
const ROW_OVERSCAN = 12;
/** Fallback row height before the CSS var is measured (compact default). */
const FALLBACK_ROW_H = 26;

/** Sort state cycles asc → desc → none (null) on repeated header clicks. */
function cycleSort(current: SortSpec | null, column: string): SortSpec | null {
  if (!current || current.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

interface DataGridProps {
  /** Live backend handle from the active workspace. */
  handleId: string;
  /** Tab identity — drives meta reporting, scroll + refetch seams. */
  tabId: string;
  schema: string;
  table: string;
  /**
   * The applied row filter (M5), or `null` for the whole table. Threads into
   * every `rowsFetch` and the reset machinery: changing it re-windows to
   * offset 0, re-fetches, and re-counts — exactly like a sort change. When a
   * raw-mode filter fails, `onFilterError` is called with the backend message
   * (the panel surfaces it) and the grid keeps its prior rows.
   */
  filter: FilterSpec | null;
  /** A stable identity for `filter`, so the reset effect can depend on it. */
  filterKey: string;
  /** Called with the §5 message when the first page of a filtered fetch fails. */
  onFilterError?: (message: string) => void;
  /** Called when a filtered fetch's first page succeeds (clears panel error). */
  onFilterOk?: () => void;
}

export function DataGrid({
  handleId,
  tabId,
  schema,
  table,
  filter,
  filterKey,
  onFilterError,
  onFilterOk,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- column header meta (pk/fk/type) ---------------------------------
  // Reuse the introspection cache (sidebar already warms it); falls back to a
  // tableMeta fetch via loadColumns. Drives the pk key / fk link icons.
  const loadColumns = useIntrospectionStore((s) => s.loadColumns);
  const [colMeta, setColMeta] = useState<Map<string, ColCellMeta>>(new Map());

  // --- result state ----------------------------------------------------
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);

  // --- M11 inline edit -------------------------------------------------
  const toast = useToast();
  // The active in-cell edit (null when not editing). Auto-focus + select on
  // mount is handled by an effect on this value.
  const [editing, setEditing] = useState<EditState | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  // A commit parked on the production-confirm modal (null when no confirm is
  // pending). Confirm fires the update; Cancel restores the cell.
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // Production gate (§ M11 safety): this connection's deployment env. An edit
  // on a `production` connection requires the confirm dialog before firing.
  const isProduction = useWorkspacesStore(
    (s) => s.workspaces.find((ws) => ws.handleId === handleId)?.saved.env === "production",
  );
  // A blur fires when an edit commits — but a commit that opens the confirm
  // modal moves focus into the modal, which would re-fire blur and double-fire
  // the commit. This flag makes commit/cancel idempotent for one edit session.
  const committingRef = useRef(false);

  // --- M10 popovers (FK peek + column insights) ------------------------
  // Each holds the anchor (clicked cell / header rect + target) for an open
  // popover, or null when closed. Only one of each is open at a time.
  const [fkPeek, setFkPeek] = useState<FkPeekAnchor | null>(null);
  const [insights, setInsights] = useState<InsightsAnchor | null>(null);
  const closeFkPeek = useCallback(() => setFkPeek(null), []);
  const closeInsights = useCallback(() => setInsights(null), []);

  // Sparse row cache keyed by absolute row index. A page write fills
  // [offset, offset+rows). Rows absent here render a shimmer.
  const rowCacheRef = useRef<Map<number, CellValue[]>>(new Map());
  const pendingPagesRef = useRef<Set<number>>(new Set());
  // For the count-unknown fallback (totalRows === null): the highest loaded
  // row index + 1, and whether a short page proved we hit the end.
  const maxLoadedRef = useRef(0);
  const reachedEndRef = useRef(false);
  // Bumped whenever the cache changes so the virtual rows re-render.
  const [cacheVersion, setCacheVersion] = useState(0);
  // Incremented on every reset (sort/refresh/identity change) so late page
  // responses from a stale generation are discarded.
  const generationRef = useRef(0);

  // Refresh nonce + restored scroll, from the tabMeta seam.
  const refetchNonce = useTabMetaStore((s) => s.refetchNonce[tabId] ?? 0);

  // Filter-result callbacks kept in a ref so fetchPage stays stable (it must
  // not re-create — and reset the window — when the parent re-renders with a
  // new callback identity; the only reset trigger is filterKey below).
  const filterCbRef = useRef({ onFilterError, onFilterOk });
  filterCbRef.current = { onFilterError, onFilterOk };
  // The live filter, read inside fetchPage without making it a dep (filterKey
  // is its stable identity and drives the reset effect).
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // Reset everything for a fresh load (mount, sort change, refresh).
  const resetAndLoadFirstPage = useCallback(() => {
    generationRef.current += 1;
    rowCacheRef.current = new Map();
    pendingPagesRef.current = new Set();
    maxLoadedRef.current = 0;
    reachedEndRef.current = false;
    setCacheVersion((v) => v + 1);
    setLoadingInitial(true);
    setInitialError(null);
    setSelected(null);
  }, []);

  // --- page fetcher ----------------------------------------------------
  const fetchPage = useCallback(
    (pageIndex: number) => {
      if (pageIndex < 0) return;
      if (pendingPagesRef.current.has(pageIndex)) return;
      const offset = pageIndex * PAGE_SIZE;
      // Skip if the whole page is already cached.
      if (rowCacheRef.current.has(offset)) return;
      const generation = generationRef.current;
      pendingPagesRef.current.add(pageIndex);
      void rowsFetch(handleId, {
        schema,
        table,
        sort,
        filter: filterRef.current,
        offset,
        limit: PAGE_SIZE,
      })
        .then((page) => {
          if (generation !== generationRef.current) return; // stale
          // Each page echoes the column list; keep the latest (stable across
          // pages within a generation). Clears the initial-loading state.
          setColumns(page.columns);
          setTotalRows(page.totalRows);
          for (let i = 0; i < page.rows.length; i++) {
            rowCacheRef.current.set(page.offset + i, page.rows[i]!);
          }
          // Track the loaded extent for the count-unknown fallback (when the
          // backend returns totalRows: null). A full page implies there may be
          // more; a short page is the end.
          maxLoadedRef.current = Math.max(maxLoadedRef.current, page.offset + page.rows.length);
          if (page.rows.length < PAGE_SIZE) reachedEndRef.current = true;
          pendingPagesRef.current.delete(pageIndex);
          setCacheVersion((v) => v + 1);
          setLoadingInitial(false);
          // The first page of a (re)load succeeded — clear any stale filter
          // error the panel was showing (e.g. a fixed raw-mode clause).
          if (pageIndex === 0) filterCbRef.current.onFilterOk?.();

          // Report to the tabMeta seam: total count, timing, and how many rows
          // are loaded so far (shown-of-total while a big table pages in).
          useTabMetaStore.getState().setTabMeta(tabId, {
            totalRows: page.totalRows,
            elapsedMs: page.elapsedMs,
            shownRows:
              page.totalRows === null
                ? undefined
                : Math.min(rowCacheRef.current.size, page.totalRows),
          });
        })
        .catch((err: unknown) => {
          if (generation !== generationRef.current) return;
          pendingPagesRef.current.delete(pageIndex);
          if (pageIndex !== 0) return; // later pages failing just leave shimmer
          const message = appErrorMessage(err, "Could not load rows.");
          // A filtered fetch that fails is almost always a bad raw WHERE — keep
          // the prior rows visible and route the §5 message to the filter panel
          // (it stays open so the user can fix the clause). Without a filter,
          // it is a genuine load failure → the full-screen error state.
          if (filterRef.current !== null && filterCbRef.current.onFilterError) {
            filterCbRef.current.onFilterError(message);
            setLoadingInitial(false);
          } else {
            setInitialError(message);
            setLoadingInitial(false);
          }
        });
    },
    [handleId, schema, table, sort, tabId],
  );

  // Initial load + reload on identity / sort / refresh changes. A reset flips
  // loadingInitial true, which unmounts the scroll canvas, so a sort/refresh
  // naturally returns to row 1 on the fresh mount — and `restoredRef` is
  // already set, so we do not re-apply the old saved scroll. The first mount
  // keeps loadingInitial true until the first page lands, then the scroll
  // restore effect runs.
  useEffect(() => {
    resetAndLoadFirstPage();
    // A reset re-keys the row cache: any open edit / parked production confirm
    // points at a now-stale row index, so drop them (M11) — committing them
    // against a re-windowed cache would target the wrong row.
    committingRef.current = false;
    setEditing(null);
    setPendingConfirm(null);
    fetchPage(0);
    // fetchPage closes over sort/identity + reads the live filter via a ref;
    // filterKey is the filter's stable identity, so an applied-filter change
    // re-windows + re-counts here exactly like a sort change.
    // resetAndLoadFirstPage is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, schema, table, sort, filterKey, refetchNonce]);

  // Load the column header meta (pk/fk) once per identity. Independent of the
  // row pages — the prototype shows the icons from table metadata, not the
  // row result's column list.
  useEffect(() => {
    let alive = true;
    void loadColumns(handleId, schema, table).then((cols) => {
      if (!alive || !cols) return;
      const map = new Map<string, ColCellMeta>();
      for (const c of cols)
        map.set(c.name, { pk: c.pk, fk: c.fk, dataType: c.dataType, nullable: c.nullable });
      setColMeta(map);
    });
    return () => {
      alive = false;
    };
  }, [handleId, schema, table, loadColumns]);

  // --- virtualizer -----------------------------------------------------
  // Row height is the live CSS var (--grid-row-h: 26/32 by density). Measure
  // it from the scroll container so density changes are honored.
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_H);
  useLayoutEffect(() => {
    // Read --grid-row-h from :root (where the density tokens live) — it always
    // exists, unlike the scroll element which is absent during loading.
    const read = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--grid-row-h").trim();
      const px = parseFloat(v);
      if (!Number.isNaN(px) && px > 0) setRowHeight((prev) => (prev === px ? prev : px));
    };
    read();
    // Re-measure when density (a data-attr on :root) flips live (preferences).
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    return () => obs.disconnect();
  }, []);

  // Virtual row count: the exact total when known; otherwise (totalRows null)
  // the loaded extent, extended by one page until a short page proves the end,
  // so the user can keep scrolling and pulling pages. These refs are read on
  // each re-render, which `cacheVersion` (used in the JSX below) guarantees
  // happens whenever a page lands.
  const rowCount =
    totalRows ?? (reachedEndRef.current ? maxLoadedRef.current : maxLoadedRef.current + PAGE_SIZE);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: ROW_OVERSCAN,
  });

  // When the row height changes (density), re-measure all virtual items.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  const virtualRows = rowVirtualizer.getVirtualItems();

  // Fetch pages overlapping the visible range (+ page overscan).
  useEffect(() => {
    if (virtualRows.length === 0) return;
    const first = virtualRows[0]!.index;
    const last = virtualRows[virtualRows.length - 1]!.index;
    const firstPage = Math.max(0, Math.floor(first / PAGE_SIZE) - PAGE_OVERSCAN);
    const lastPage = Math.floor(last / PAGE_SIZE) + PAGE_OVERSCAN;
    for (let p = firstPage; p <= lastPage; p++) fetchPage(p);
    // virtualRows identity changes each scroll; fetchPage is memoized.
  }, [virtualRows, fetchPage]);

  // --- scroll persistence (per-tab, across workspace switches) ---------
  // The grid remounts on every workspace switch (WorkspaceContent mounts only
  // the active workspace's active tab), so we save scrollTop on unmount and
  // restore it once the canvas exists AND has its full height — the scroll
  // container is not rendered during the loading state, and the browser clamps
  // scrollTop to the content height, so restoring before totalRows is known
  // would snap to 0. `restoredRef` makes restore one-shot per mount.
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    if (restoredRef.current || loadingInitial) return;
    const el = scrollRef.current;
    if (!el) return;
    restoredRef.current = true;
    const saved = useTabMetaStore.getState().scrollTop[tabId];
    if (saved && saved > 0) el.scrollTop = saved;
  }, [loadingInitial, totalRows, tabId]);

  // Commit scrollTop on unmount (the churn rule: only on switch, never per
  // frame). We intentionally read scrollRef.current *at cleanup time* (not a
  // value captured at mount): during the loading state the element is null, so
  // a captured value would be stale — we want the live element that exists by
  // the time the tab is switched away. Hence the rule is disabled here.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const el = scrollRef.current;
      if (el) useTabMetaStore.getState().setTabScrollTop(tabId, el.scrollTop);
    };
  }, [tabId]);

  // --- render ----------------------------------------------------------
  const onHeaderClick = useCallback((column: string) => {
    setSort((prev) => cycleSort(prev, column));
  }, []);

  // FK hop (M10 §3.5): clicking an FK cell link opens the peek popover for the
  // column's referenced table, anchored at the clicked cell. The referenced
  // schema is the same as the source for SQLite (one db, one schema). Closing
  // any prior insights popover keeps a single popover open at a time.
  // M11 coexistence: the hop is *deferred* on a short timer so a double-click
  // on an FK cell enters edit (the td's onDoubleClick clears the timer first)
  // rather than navigating. A lone single click runs the hop once the timer
  // elapses. The browser's dblclick threshold (~250–500ms) bounds the wait.
  const onFkClick = useCallback(
    (fk: FkRef, value: CellValue, event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      if (fkHopTimer.current !== null) window.clearTimeout(fkHopTimer.current);
      fkHopTimer.current = window.setTimeout(() => {
        fkHopTimer.current = null;
        setInsights(null);
        setFkPeek({ rect, refSchema: schema, refTable: fk.table, refColumn: fk.column, value });
      }, 250);
    },
    [schema],
  );

  // "Open in {refTable}": open/focus that table's data tab seeded with the
  // referenced `refColumn = value` filter (so the grid shows the row(s)), then
  // close the peek.
  const onOpenInTable = useCallback((anchor: FkPeekAnchor) => {
    useWorkspacesStore
      .getState()
      .openTableTabWithFilter(anchor.refSchema, anchor.refTable, anchor.refColumn, anchor.value);
    setFkPeek(null);
  }, []);

  // Column insights (M10 §3.5): the header's chart icon opens the insights
  // popover for that column, anchored at the icon. stopPropagation keeps the
  // header's sort handler from firing on the same click.
  const onInsightClick = useCallback(
    (column: string, event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setFkPeek(null);
      setInsights({ rect, column });
    },
    [],
  );

  // --- M11 inline edit: editability gating + commit flow ---------------
  // The table's primary-key columns, in `columns` order (so the pk predicate
  // is built deterministically). A table with no pk → empty → read-only cells.
  const pkColumns = useMemo(
    () => columns.filter((c) => colMeta.get(c.name)?.pk).map((c) => c.name),
    [columns, colMeta],
  );
  const hasPk = pkColumns.length > 0;

  // Build the full-pk predicate for a row from its loaded values. Returns null
  // if any pk value is missing (a row not fully present can't be safely keyed).
  const buildPk = useCallback(
    (row: CellValue[]): PkPredicate[] | null => {
      const preds: PkPredicate[] = [];
      for (const pkName of pkColumns) {
        const ci = columns.findIndex((c) => c.name === pkName);
        if (ci < 0) return null;
        preds.push({ column: pkName, value: row[ci] ?? null });
      }
      return preds.length > 0 ? preds : null;
    },
    [columns, pkColumns],
  );

  // A cell is editable when the table has a pk, the cell's own column is NOT a
  // pk column (editing a pk changes row identity — read-only, recommended safe
  // default), and the row's pk values are all present. Returns a reason string
  // for the read-only tooltip, or null when editable.
  const readOnlyReason = useCallback(
    (rowIndex: number, ci: number): string | null => {
      if (!hasPk) return "Read-only: table has no primary key";
      const colName = columns[ci]?.name;
      if (colName && colMeta.get(colName)?.pk) return "Read-only: primary key column";
      const row = rowCacheRef.current.get(rowIndex);
      if (!row || buildPk(row) === null) return "Read-only: row key unavailable";
      return null;
    },
    [hasPk, columns, colMeta, buildPk],
  );

  // Begin editing a cell: prefill with the current value as text (NULL → empty
  // input). No-op on a read-only cell (the td shows the reason as a tooltip).
  const startEdit = useCallback(
    (rowIndex: number, ci: number) => {
      if (readOnlyReason(rowIndex, ci) !== null) return;
      const row = rowCacheRef.current.get(rowIndex);
      if (!row) return;
      const cur = row[ci] ?? null;
      committingRef.current = false;
      setEditing({ row: rowIndex, col: ci, draft: cur === null ? "" : String(cur) });
    },
    [readOnlyReason],
  );

  // Discard the active edit without writing.
  const cancelEdit = useCallback(() => {
    committingRef.current = false;
    setEditing(null);
  }, []);

  // Auto-focus + select the input when an edit starts.
  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editing]);

  // Apply a coerced value to the page cache at (row, col) and re-render. Used
  // for the optimistic write and for the rollback on error.
  const writeCache = useCallback((rowIndex: number, ci: number, value: CellValue) => {
    const row = rowCacheRef.current.get(rowIndex);
    if (!row) return;
    const next = row.slice();
    next[ci] = value;
    rowCacheRef.current.set(rowIndex, next);
    setCacheVersion((v) => v + 1);
  }, []);

  // Fire the backend update with optimistic write + rollback-on-error. The
  // cache is mutated to `value` immediately and edit mode exits; on success a
  // toast shows the executed statement; on error the prior value is restored
  // and the §5 message is shown. `prior` is the value to roll back to.
  const runUpdate = useCallback(
    (rowIndex: number, ci: number, column: string, value: CellValue, prior: CellValue, pk: PkPredicate[]) => {
      // Optimistic: apply now, exit edit mode.
      writeCache(rowIndex, ci, value);
      const generation = generationRef.current;
      void rowUpdate(handleId, { schema, table, column, value, pk })
        .then((result) => {
          // A reset (sort/filter/refresh) since we fired invalidated the cache;
          // the toast is still truthful (the row was updated server-side).
          toast(result.statement + " — " + result.affected + " row affected", "ok");
        })
        .catch((err: unknown) => {
          // Roll back the optimistic write if the cache is still the same
          // generation (otherwise the row is gone / re-fetched anyway).
          if (generation === generationRef.current) writeCache(rowIndex, ci, prior);
          toast(appErrorMessage(err, "Could not update the cell."), "err");
        });
    },
    [writeCache, handleId, schema, table, toast],
  );

  // Commit the active edit: coerce by column type, no-op if unchanged, build
  // the pk predicate, then either fire immediately or (on a production
  // connection) park the commit on the confirm modal. Idempotent per session
  // via committingRef (Enter then blur must not double-fire).
  const commitEdit = useCallback(() => {
    if (!editing || committingRef.current) return;
    const { row: rowIndex, col: ci, draft } = editing;
    const row = rowCacheRef.current.get(rowIndex);
    const colName = columns[ci]?.name;
    if (!row || !colName) {
      cancelEdit();
      return;
    }
    const prior = row[ci] ?? null;
    const value = coerceForColumn(draft, colMeta.get(colName));
    // No-op: the coerced value is unchanged — don't fire an update.
    if (value === prior) {
      cancelEdit();
      return;
    }
    const pk = buildPk(row);
    if (pk === null) {
      // Should not happen (startEdit gated on this), but never fire without a
      // full pk — restore and bail.
      cancelEdit();
      return;
    }
    committingRef.current = true;
    setEditing(null);
    if (isProduction) {
      // Park on the confirm modal; the cache is NOT yet mutated (Cancel must
      // leave the cell as it was).
      const display =
        'UPDATE "' + schema + '"."' + table + '" SET "' + colName + '" = ' + sqlLiteral(value) +
        " WHERE " + pk.map((p) => '"' + p.column + '" = ' + sqlLiteral(p.value)).join(" AND ");
      setPendingConfirm({ row: rowIndex, col: ci, column: colName, value, prior, pk, display });
      return;
    }
    runUpdate(rowIndex, ci, colName, value, prior, pk);
  }, [editing, columns, colMeta, buildPk, isProduction, schema, table, runUpdate, cancelEdit]);

  // Confirm dialog (production): proceed with the parked commit, or cancel it
  // (the cell was never mutated, so cancel just drops the pending state).
  const confirmProceed = useCallback(() => {
    const p = pendingConfirm;
    if (!p) return;
    setPendingConfirm(null);
    committingRef.current = false;
    runUpdate(p.row, p.col, p.column, p.value, p.prior, p.pk);
  }, [pendingConfirm, runUpdate]);

  const confirmCancel = useCallback(() => {
    setPendingConfirm(null);
    committingRef.current = false;
  }, []);

  // --- M11 FK coexistence: defer the single-click hop so a double-click on
  // an FK cell enters edit instead of navigating. The FK link's onClick
  // schedules the hop on a short timer; the td's onDoubleClick clears it
  // before starting the edit, so the hop never fires on a double-click.
  const fkHopTimer = useRef<number | null>(null);
  const clearPendingHop = useCallback(() => {
    if (fkHopTimer.current !== null) {
      window.clearTimeout(fkHopTimer.current);
      fkHopTimer.current = null;
    }
  }, []);
  useEffect(() => () => clearPendingHop(), [clearPendingHop]);

  // Grid column template: row-number gutter + one min/max track per column.
  const gridCols = useMemo(
    () => "38px " + columns.map(() => "minmax(90px, max-content)").join(" "),
    [columns],
  );

  if (initialError) {
    return (
      <div className="dg-state">
        <Icon name="error" size={28} style={{ color: "#e06c75" }} />
        <div className="dg-error">
          Could not load rows.
          <code>{initialError}</code>
        </div>
        <button
          type="button"
          className="dg-retry"
          onClick={() => useTabMetaStore.getState().requestRefetch(tabId)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (loadingInitial) {
    return (
      <div className="dg-state">
        <Icon name="table" size={28} style={{ opacity: 0.5 }} />
        <span>Loading {schema + "." + table}…</span>
      </div>
    );
  }

  // Empty when the count is a known 0, or the count was unknown and the first
  // (terminal) page came back with no rows.
  if (totalRows === 0 || rowCount === 0) {
    return (
      <>
        <div className="dg-state">
          <Icon name="table_rows" size={28} style={{ opacity: 0.5 }} />
          <span>
            {filter
              ? "No rows match the filter in " + schema + "." + table
              : "Empty table — no rows in " + schema + "." + table}
          </span>
        </div>
        <GridHint />
      </>
    );
  }

  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <>
      <div className="datagrid-wrap" ref={scrollRef}>
        <div className="dg-canvas" style={{ "--grid-cols": gridCols } as React.CSSProperties}>
          {/* sticky header */}
          <div className="dg-header dg-row">
            <div className="dg-rownum-h">#</div>
            {columns.map((c) => {
              const meta = colMeta.get(c.name);
              const active = sort?.column === c.name;
              return (
                <div
                  key={c.name}
                  className="dg-th sortable"
                  onClick={() => onHeaderClick(c.name)}
                  title={c.typeHint ? c.name + " · " + c.typeHint : c.name}
                >
                  <span className="dg-head">
                    {meta?.pk ? (
                      <Icon
                        name="key"
                        size={12}
                        style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
                      />
                    ) : null}
                    {meta?.fk ? (
                      <Icon name="link" size={12} style={{ color: "var(--text-faint)" }} />
                    ) : null}
                    <span className="dg-colname">{c.name}</span>
                    {c.typeHint ? (
                      <span className="dg-coltype">{c.typeHint.toLowerCase()}</span>
                    ) : null}
                    {active ? (
                      <Icon
                        name={sort!.direction === "asc" ? "arrow_upward" : "arrow_downward"}
                        size={13}
                        style={{ color: "var(--accent)" }}
                      />
                    ) : null}
                    {/* M10: column-insights chart icon, shown on th hover
                        (.dg-th:hover .insight-btn). stopPropagation keeps the
                        header's sort click from firing. */}
                    <button
                      type="button"
                      className="insight-btn"
                      title={"Insights: " + c.name}
                      onClick={(e) => onInsightClick(c.name, e)}
                    >
                      <Icon name="monitoring" size={13} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>

          {/* virtualized body. `cacheVersion` is read here only to re-run this
              render when a page lands (the rows live in a ref, not state). */}
          <div
            style={{ height: totalHeight, position: "relative" }}
            data-cache-version={cacheVersion}
          >
            {virtualRows.map((vr) => {
              const rowIndex = vr.index;
              const row = rowCacheRef.current.get(rowIndex);
              const isSelectedRow = selected?.row === rowIndex;
              return (
                <div
                  key={rowIndex}
                  className={"dg-tr dg-row" + (isSelectedRow ? " row-selected" : "")}
                  style={{ height: vr.size, transform: `translateY(${vr.start}px)` }}
                >
                  <div className="dg-rownum">{rowIndex + 1}</div>
                  {columns.map((c, ci) => {
                    if (!row) {
                      // Page not yet loaded — shimmer skeleton.
                      return (
                        <div key={c.name} className="dg-td cell-loading">
                          <span className="dg-cell-skeleton" />
                        </div>
                      );
                    }
                    const isSel = isSelectedRow && selected?.col === ci;
                    // Only hop when the fk target column resolved (engine may
                    // report an empty `column` for an unresolvable implicit fk);
                    // otherwise the cell renders as plain text (no link).
                    const fkMeta = colMeta.get(c.name)?.fk ?? null;
                    const fk = fkMeta && fkMeta.column ? fkMeta : null;
                    // M11: edit state + editability for this cell.
                    const isEditing = editing?.row === rowIndex && editing?.col === ci;
                    const roReason = readOnlyReason(rowIndex, ci);
                    return (
                      <div
                        key={c.name}
                        className={
                          "dg-td" + (isSel ? " cell-selected" : "") + (isEditing ? " cell-editing" : "")
                        }
                        // Read-only cells explain why on hover (per M11); editable
                        // cells fall back to the value-as-string title.
                        title={roReason ?? undefined}
                        onClick={() => setSelected({ row: rowIndex, col: ci })}
                        onDoubleClick={() => {
                          // A double-click on an FK cell must edit, not hop:
                          // cancel any pending deferred hop first.
                          clearPendingHop();
                          startEdit(rowIndex, ci);
                        }}
                      >
                        {isEditing ? (
                          <input
                            ref={editInputRef}
                            className="cell-input"
                            aria-label={"Edit " + c.name}
                            value={editing.draft}
                            onChange={(e) =>
                              setEditing((prev) => (prev ? { ...prev, draft: e.target.value } : prev))
                            }
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitEdit();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                          />
                        ) : (
                          <CellContent
                            value={row[ci] ?? null}
                            column={c.name}
                            fk={fk}
                            onFkClick={fk ? (value, e) => onFkClick(fk, value, e) : undefined}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <GridHint />
      {fkPeek ? (
        <FkPeek
          handleId={handleId}
          anchor={fkPeek}
          onClose={closeFkPeek}
          onOpenInTable={onOpenInTable}
        />
      ) : null}
      {insights ? (
        <ColumnInsights
          handleId={handleId}
          schema={schema}
          table={table}
          filter={filter}
          anchor={insights}
          onClose={closeInsights}
        />
      ) : null}
      {/* Production-edit confirm (§ M11 safety): only reached when the
          connection's env is `production`. Confirm fires the update (with the
          optimistic write + rollback); Cancel leaves the cell untouched. */}
      {pendingConfirm ? (
        <Modal onClose={confirmCancel} label="Confirm update" width={460}>
          <ModalTitle>
            <Icon name="warning" size={18} style={{ color: "#e2b340" }} /> Update a row on a
            production connection?
          </ModalTitle>
          <p className="dg-confirm-body">
            This connection points at <b>production</b>. The following update will run:
          </p>
          <code className="dg-confirm-sql">{pendingConfirm.display}</code>
          <ModalActions>
            <Btn variant="text" onClick={confirmCancel}>
              Cancel
            </Btn>
            <Btn variant="filled" onClick={confirmProceed}>
              Confirm
            </Btn>
          </ModalActions>
        </Modal>
      ) : null}
    </>
  );
}

/** Hint footer — exact copy from spec §3.5 (features land M5/M10/M11). */
function GridHint() {
  return (
    <div className="grid-hint">
      Double-click a cell to edit · click a header to sort · stack conditions under Filters · click
      a linked value to hop the FK · <Icon name="change_history" size={11} /> for column insights
    </div>
  );
}
