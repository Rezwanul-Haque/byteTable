// Virtualized data grid (spec §3.5, MILESTONES M4) — ported behavior from the
// prototype's grid.jsx, with the real backend's LIMIT/OFFSET paging behind it.
//
// VIRTUALIZATION + EXPLICIT PAGING (Bug 2 — the prototype's `.table-footer`
// pager):
//   - The table tab owns `offset`/`pageSize` and drives them from the footer
//     pager. The grid fetches EXACTLY the current page —
//     `rowsFetch(..., { offset, limit: pageSize })` — and virtualizes WITHIN
//     that page with @tanstack/react-virtual. The scroll container is sized to
//     `pageRowCount × rowHeight` (the page's rows, not the whole table), so the
//     scrollbar reflects the page; the footer's prev/next move the window.
//   - The page's rows live in a cache keyed by ABSOLUTE row index
//     (`offset + i`) so the inline-edit pk logic + row-number gutter stay
//     correct across pages. A page in flight renders a shimmer skeleton.
//   - `totalRows` (the fetch's COUNT, filtered when a filter is applied) is
//     reported to the tabMeta seam; the footer reads it for the range readout
//     and next-enabled, and the toolbar's "N rows" stays consistent with it.
//   - Sort / filter / refresh / page change all reset the cache and re-fetch.
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
import { BinaryEditorModal } from "./BinaryEditorModal";
import { isBinaryType } from "./binaryCell";
import { ColumnInsights, type InsightsAnchor } from "./ColumnInsights";
import { FkPeek, type FkPeekAnchor } from "./FkPeek";
import { CellContent } from "./GridCell";
import { JsonEditorModal } from "./JsonEditorModal";
import { isJsonType } from "./jsonCell";
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
  // Booleans (M12 Postgres) render unquoted, matching the backend's cosmetic
  // `sql_literal`.
  if (typeof value === "boolean") return value ? "true" : "false";
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Row overscan handed to the virtualizer (DOM rows beyond the viewport). */
const ROW_OVERSCAN = 12;
/** Fallback row height before the CSS var is measured (compact default). */
const FALLBACK_ROW_H = 26;

// --- Bug 1: explicit per-column pixel widths (shared by header + all rows) ---
// Each `.dg-row` is its own CSS grid (the body rows are absolutely positioned
// by the virtualizer, so a single shared grid is impossible). With
// `max-content` tracks, every row resolved its own track widths from its own
// content → the header and body computed DIFFERENT widths and columns drifted.
// Fix: measure one explicit pixel width per visible column ONCE (max of the
// header's intrinsic width and the widest loaded cell, clamped), and build the
// template from those fixed px tracks so every row uses identical tracks.

/** Min/max column track width (px). MAX bounds one long value from blowing out
 *  the layout — the cell ellipsizes/scrolls within it. */
const COL_MIN_PX = 90;
const COL_MAX_PX = 400;
/** Row-number gutter width (px) — matches `.dg-rownum` min-width. */
const ROWNUM_PX = 38;
/** Horizontal cell/header padding (px) — `.dg-td`/`.dg-th` are `0 12px`. */
const CELL_PAD_PX = 24;
/** Cheap mono-font width estimates (JetBrains Mono ≈ 0.6em advance). The body
 *  cell font is `--grid-fs` (~12px → ~7.3px/char); the header name is 11.5px
 *  (~7px/char) and the type label is 9.5px (~5.7px/char). Estimates only —
 *  clamp + ellipsis absorb the slack. */
const CELL_CHAR_PX = 7.3;
const HEAD_NAME_CHAR_PX = 7;
const HEAD_TYPE_CHAR_PX = 5.7;
/** Allowance for header icons (pk/fk badge, sort arrow) + the inter-item gap. */
const HEAD_ICON_PX = 40;
/** Rows sampled when measuring cell widths — enough to be representative
 *  without scanning a 5000-row page on every recompute. */
const WIDTH_SAMPLE_ROWS = 200;

/** Render width of one cell value, mirroring GridCell's text output (numbers
 *  print compact; everything else its string form). */
function cellTextLength(value: CellValue): number {
  if (value === null) return 4; // "null"
  if (typeof value === "number")
    return (Number.isInteger(value) ? String(value) : value.toFixed(2)).length;
  return String(value).length;
}

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
  /**
   * Columns hidden by the table tab's Columns popover (M15 Task 2). Display-
   * only: the grid still FETCHES every column (the row cache stays aligned to
   * the full `columns`), it just skips rendering the hidden ones in the header
   * + body and drops their tracks from the grid template.
   */
  hiddenColumns?: ReadonlySet<string>;
  /**
   * Explicit paging (Bug 2 — the prototype's `.table-footer` pager). The table
   * tab owns `offset`/`pageSize`; the grid fetches exactly that page
   * (`rowsFetch(..., { offset, limit: pageSize })`) and virtualizes within it.
   * This replaces the old scroll-driven sparse-window model for the table view.
   * Changing either re-fetches the page. `pageSize` is already clamped by the
   * caller to the backend ceiling (`MAX_PAGE_ROWS`) for the "All" option.
   */
  offset: number;
  pageSize: number;
  /**
   * Called when the user changes the sort (header click). The table tab resets
   * `offset` to 0 on sort change (matches the prototype's paging reset), since
   * a re-sort invalidates the current page window.
   */
  onSortChange?: () => void;
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
  hiddenColumns,
  offset,
  pageSize,
  onSortChange,
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

  // --- JSON / binary cell editor modals (ported design) ----------------
  // Double-clicking a JSON or binary cell opens a dedicated modal instead of
  // the inline input. Holds the target cell + its declared type, or null.
  const [cellModal, setCellModal] = useState<{
    kind: "json" | "binary";
    row: number;
    col: number;
    column: string;
    type: string;
    value: CellValue;
  } | null>(null);

  // --- M10 popovers (FK peek + column insights) ------------------------
  // Each holds the anchor (clicked cell / header rect + target) for an open
  // popover, or null when closed. Only one of each is open at a time.
  const [fkPeek, setFkPeek] = useState<FkPeekAnchor | null>(null);
  const [insights, setInsights] = useState<InsightsAnchor | null>(null);
  const closeFkPeek = useCallback(() => setFkPeek(null), []);
  const closeInsights = useCallback(() => setInsights(null), []);

  // The current page's rows, keyed by ABSOLUTE row index (`offset + i`). Keyed
  // absolutely (not 0-based) so the inline-edit pk logic + the row-number
  // gutter stay correct across pages. Rows absent here (page in flight) render
  // a shimmer.
  const rowCacheRef = useRef<Map<number, CellValue[]>>(new Map());
  // How many rows the current page actually returned (≤ pageSize; the last
  // page is short). Drives the virtualizer's row count for THIS page.
  const [pageRowCount, setPageRowCount] = useState(0);
  // Bumped whenever the cache changes so the virtual rows re-render.
  const [cacheVersion, setCacheVersion] = useState(0);
  // Incremented on every reset (sort/refresh/identity change) so late page
  // responses from a stale generation are discarded.
  const generationRef = useRef(0);

  // Refresh nonce + restored scroll, from the tabMeta seam.
  const refetchNonce = useTabMetaStore((s) => s.refetchNonce[tabId] ?? 0);

  // Filter-result callbacks kept in a ref so fetchCurrentPage stays stable (it
  // must not re-create — and re-fetch — when the parent re-renders with a new
  // callback identity; the reset triggers are the identity/sort/filter/page
  // deps below).
  const filterCbRef = useRef({ onFilterError, onFilterOk });
  filterCbRef.current = { onFilterError, onFilterOk };
  // The live filter, read inside fetchCurrentPage without making it a dep
  // (filterKey is its stable identity and drives the reset effect).
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // Reset everything for a fresh page load (mount, sort/filter/page change,
  // refresh).
  const resetForLoad = useCallback(() => {
    generationRef.current += 1;
    rowCacheRef.current = new Map();
    setPageRowCount(0);
    setCacheVersion((v) => v + 1);
    setLoadingInitial(true);
    setInitialError(null);
    setSelected(null);
  }, []);

  // --- page fetcher ----------------------------------------------------
  // Fetch EXACTLY the current page [offset, offset+pageSize). One request per
  // (sort/filter/identity/offset/pageSize/refresh) generation.
  const fetchCurrentPage = useCallback(() => {
    const generation = generationRef.current;
    void rowsFetch(handleId, {
      schema,
      table,
      sort,
      filter: filterRef.current,
      offset,
      limit: pageSize,
    })
      .then((page) => {
        if (generation !== generationRef.current) return; // stale
        // The page echoes the column list; keep the latest.
        setColumns(page.columns);
        setTotalRows(page.totalRows);
        rowCacheRef.current = new Map();
        for (let i = 0; i < page.rows.length; i++) {
          rowCacheRef.current.set(page.offset + i, page.rows[i]!);
        }
        setPageRowCount(page.rows.length);
        setCacheVersion((v) => v + 1);
        setLoadingInitial(false);
        // A successful (re)load clears any stale filter error the panel showed
        // (e.g. a fixed raw-mode clause).
        filterCbRef.current.onFilterOk?.();

        // Report to the tabMeta seam: total count + timing. The toolbar's
        // "N rows" reads totalRows (the filtered total when a filter applies);
        // no shownRows — the footer pager shows the page range instead.
        useTabMetaStore.getState().setTabMeta(tabId, {
          totalRows: page.totalRows,
          elapsedMs: page.elapsedMs,
          shownRows: undefined,
        });
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        const message = appErrorMessage(err, "Could not load rows.");
        // A filtered fetch that fails is almost always a bad raw WHERE — keep
        // the prior rows visible and route the §5 message to the filter panel
        // (it stays open so the user can fix the clause). Without a filter, it
        // is a genuine load failure → the full-screen error state.
        if (filterRef.current !== null && filterCbRef.current.onFilterError) {
          filterCbRef.current.onFilterError(message);
          setLoadingInitial(false);
        } else {
          setInitialError(message);
          setLoadingInitial(false);
        }
      });
  }, [handleId, schema, table, sort, tabId, offset, pageSize]);

  // Initial load + reload on identity / sort / filter / page / refresh changes.
  // A reset flips loadingInitial true, which unmounts the scroll canvas, so a
  // sort/filter/page change naturally returns to row 1 on the fresh mount.
  useEffect(() => {
    resetForLoad();
    // A reset re-keys the row cache: any open edit / parked production confirm
    // points at a now-stale row index, so drop them (M11) — committing them
    // against a re-windowed cache would target the wrong row.
    committingRef.current = false;
    setEditing(null);
    setPendingConfirm(null);
    fetchCurrentPage();
    // fetchCurrentPage closes over sort/identity/offset/pageSize + reads the
    // live filter via a ref; filterKey is the filter's stable identity, so an
    // applied-filter change re-fetches + re-counts here like a sort change.
    // resetForLoad is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, schema, table, sort, filterKey, refetchNonce, offset, pageSize]);

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

  // Virtual row count: the rows in the CURRENT PAGE (the grid only holds one
  // page at a time now). The virtualizer indexes the page 0-based; the body map
  // adds `offset` to recover the absolute row index (gutter shows index+1, and
  // the cache is keyed absolutely). `cacheVersion` (read in the JSX below)
  // re-renders when the page lands.
  const rowCount = pageRowCount;
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
  // Keep the sort-change callback in a ref so onHeaderClick stays stable.
  const onSortChangeRef = useRef(onSortChange);
  onSortChangeRef.current = onSortChange;
  const onHeaderClick = useCallback((column: string) => {
    // A re-sort invalidates the current page window — reset paging to page 1
    // (the table tab owns offset). Fired before the local sort flips so the
    // parent's offset reset and our sort change land in the same render pass.
    onSortChangeRef.current?.();
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
    // No-op: the coerced value is unchanged — don't fire an update. Compare by
    // string form too: big integers (>2^53) arrive as strings but coerce to a
    // number for INT columns, so `value === prior` would miss an unchanged edit
    // and fire a precision-losing write. String-equal means "no real change".
    if (value === prior || (value !== null && prior !== null && String(value) === String(prior))) {
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

  // Open the JSON / binary editor for a cell (only when editable — the caller
  // gates on readOnlyReason). Snapshots the cell's identity + current value.
  const openCellModal = useCallback(
    (kind: "json" | "binary", rowIndex: number, ci: number, col: ColumnMeta) => {
      const row = rowCacheRef.current.get(rowIndex);
      if (!row) return;
      setCellModal({ kind, row: rowIndex, col: ci, column: col.name, type: col.typeHint, value: row[ci] ?? null });
    },
    [],
  );

  // Apply a final value chosen in a cell modal: no-op if unchanged, then either
  // fire immediately or (on a production connection) park on the confirm modal —
  // the same safety path as inline edits, minus the draft coercion.
  const commitCellValue = useCallback(
    (rowIndex: number, ci: number, colName: string, value: CellValue) => {
      const row = rowCacheRef.current.get(rowIndex);
      if (!row) return;
      const prior = row[ci] ?? null;
      if (value === prior || (value !== null && prior !== null && String(value) === String(prior))) {
        return;
      }
      const pk = buildPk(row);
      if (pk === null) return;
      if (isProduction) {
        const display =
          'UPDATE "' + schema + '"."' + table + '" SET "' + colName + '" = ' + sqlLiteral(value) +
          " WHERE " + pk.map((p) => '"' + p.column + '" = ' + sqlLiteral(p.value)).join(" AND ");
        setPendingConfirm({ row: rowIndex, col: ci, column: colName, value, prior, pk, display });
        return;
      }
      runUpdate(rowIndex, ci, colName, value, prior, pk);
    },
    [buildPk, isProduction, schema, table, runUpdate],
  );

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

  // Visibility predicate for the Columns popover (M15 Task 2). Hiding is
  // display-only — `columns` (and therefore the row cache's `ci` indexing)
  // stays the full set; we only skip rendering + drop the track.
  const isHidden = useCallback(
    (name: string) => hiddenColumns?.has(name) ?? false,
    [hiddenColumns],
  );

  // Grid column template (Bug 1): row-number gutter + one EXPLICIT pixel track
  // per VISIBLE column, shared by the header and every body row so columns line
  // up exactly. Each track = clamp(max(header intrinsic, widest sampled cell),
  // MIN, MAX). Recomputes only when the columns, hidden set, header meta, or
  // the loaded page changes (cacheVersion/offset/pageRowCount) — NOT per
  // scroll. Hidden columns drop their track so the layout closes up.
  const gridCols = useMemo(() => {
    const widths: string[] = [];
    for (const c of columns) {
      if (isHidden(c.name)) continue;
      // Header intrinsic width: name + (smaller) type label + icons + padding.
      const typeLen = c.typeHint ? c.typeHint.length : 0;
      const headerPx =
        c.name.length * HEAD_NAME_CHAR_PX +
        typeLen * HEAD_TYPE_CHAR_PX +
        HEAD_ICON_PX +
        CELL_PAD_PX;
      // Widest sampled cell value in the current page.
      let maxCellLen = 0;
      let sampled = 0;
      const ci = columns.indexOf(c);
      for (const row of rowCacheRef.current.values()) {
        const len = cellTextLength(row[ci] ?? null);
        if (len > maxCellLen) maxCellLen = len;
        if (++sampled >= WIDTH_SAMPLE_ROWS) break;
      }
      const cellPx = maxCellLen * CELL_CHAR_PX + CELL_PAD_PX;
      const w = Math.round(Math.min(COL_MAX_PX, Math.max(COL_MIN_PX, headerPx, cellPx)));
      widths.push(w + "px");
    }
    return ROWNUM_PX + "px " + widths.join(" ");
    // rowCacheRef is a ref; cacheVersion/pageRowCount/offset stand in for its
    // contents changing (a page landed / the window moved).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, isHidden, cacheVersion, pageRowCount, offset]);

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

  // Empty when the filtered count is a known 0, or the current page came back
  // with no rows (e.g. an empty table). The footer pager (TableTab) still
  // renders below this in either case.
  if (totalRows === 0 || rowCount === 0) {
    return (
      <div className="dg-state">
        <Icon name="table_rows" size={28} style={{ opacity: 0.5 }} />
        <span>
          {filter
            ? "No rows match the filter in " + schema + "." + table
            : "Empty table — no rows in " + schema + "." + table}
        </span>
      </div>
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
              if (isHidden(c.name)) return null;
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
              // vr.index is 0-based within the page; recover the absolute row
              // index so the gutter, cache key, and pk/edit logic stay correct.
              const rowIndex = offset + vr.index;
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
                    if (isHidden(c.name)) return null;
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
                    const editable = roReason === null;
                    // JSON / binary columns get their own editor modal (ported
                    // design) instead of the inline input.
                    const json = isJsonType(c.typeHint);
                    const bin = isBinaryType(c.typeHint);
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
                          if (editable && json) openCellModal("json", rowIndex, ci, c);
                          else if (editable && bin) openCellModal("binary", rowIndex, ci, c);
                          else startEdit(rowIndex, ci);
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
                            type={c.typeHint}
                            fk={fk}
                            onFkClick={fk ? (value, e) => onFkClick(fk, value, e) : undefined}
                            onJsonClick={
                              editable && json ? () => openCellModal("json", rowIndex, ci, c) : undefined
                            }
                            onBinClick={
                              editable && bin ? () => openCellModal("binary", rowIndex, ci, c) : undefined
                            }
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
            <Icon name="warning" size={18} style={{ color: "#e06c75" }} /> Update a row on a
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
      {cellModal?.kind === "json" ? (
        <JsonEditorModal
          schemaName={schema}
          table={table}
          column={cellModal.column}
          type={cellModal.type}
          value={cellModal.value}
          onClose={() => setCellModal(null)}
          onSave={(next) => {
            commitCellValue(cellModal.row, cellModal.col, cellModal.column, next);
            setCellModal(null);
          }}
        />
      ) : null}
      {cellModal?.kind === "binary" ? (
        <BinaryEditorModal
          schemaName={schema}
          table={table}
          column={cellModal.column}
          type={cellModal.type}
          value={cellModal.value}
          onClose={() => setCellModal(null)}
          onSave={(next) => {
            commitCellValue(cellModal.row, cellModal.col, cellModal.column, next);
            setCellModal(null);
          }}
        />
      ) : null}
    </>
  );
}
