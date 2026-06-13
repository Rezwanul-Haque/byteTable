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

import type { CellValue, ColumnMeta, FkRef, SortSpec } from "../../../shared/api/engine";
import { rowsFetch } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Icon } from "../../../shared/ui/Icon";
import { useIntrospectionStore } from "../../introspection/state";
import { useTabMetaStore } from "../../workspaces/tabMeta";
import "./DataGrid.css";

/** Rows fetched per page. Small enough that a single page is cheap, large
 *  enough that a viewport rarely spans more than two. */
const PAGE_SIZE = 200;
/** Extra pages to prefetch on either side of the visible range. */
const PAGE_OVERSCAN = 1;
/** Row overscan handed to the virtualizer (DOM rows beyond the viewport). */
const ROW_OVERSCAN = 12;
/** Fallback row height before the CSS var is measured (compact default). */
const FALLBACK_ROW_H = 26;

/** Enum→color map for status/method-like string pills (prototype ui.jsx). */
const STATUS_COLORS: Record<string, string> = {
  delivered: "#34d39e",
  paid: "#34d39e",
  succeeded: "#34d39e",
  shipped: "#61afef",
  pending: "#e2b340",
  cancelled: "#e06c75",
  failed: "#e06c75",
  refunded: "#c678dd",
};

/** Columns whose string values render as tinted enum pills (prototype). */
const PILL_COLUMNS = new Set(["status", "method"]);

/** One cell's rendered value, typed per spec §1.3 / §3.5. */
function CellContent({ value, column }: { value: CellValue; column: string }) {
  if (value === null) {
    // NULL → italic faint small-caps "null".
    return <span className="cell-null">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className={value ? "cell-true" : "cell-false"}>{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="cell-num">{Number.isInteger(value) ? value : value.toFixed(2)}</span>;
  }
  const s = value;
  if (PILL_COLUMNS.has(column) && STATUS_COLORS[s]) {
    return (
      <span
        className="cell-pill"
        style={{ color: STATUS_COLORS[s], background: STATUS_COLORS[s] + "1a" }}
      >
        {s}
      </span>
    );
  }
  // M10 seam: FK columns become accent links here (the peek popover hops the
  // reference). This milestone renders FK values as plain text.
  return <span className="cell-text">{s}</span>;
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
}

export function DataGrid({ handleId, tabId, schema, table }: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- column header meta (pk/fk/type) ---------------------------------
  // Reuse the introspection cache (sidebar already warms it); falls back to a
  // tableMeta fetch via loadColumns. Drives the pk key / fk link icons.
  const loadColumns = useIntrospectionStore((s) => s.loadColumns);
  const [colMeta, setColMeta] = useState<Map<string, { pk: boolean; fk: FkRef | null }>>(new Map());

  // --- result state ----------------------------------------------------
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);

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
      void rowsFetch(handleId, { schema, table, sort, offset, limit: PAGE_SIZE })
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
          // Surface the first-page failure as the inline error state; later
          // pages failing just leave shimmer (a transient scroll fetch).
          if (pageIndex === 0) {
            setInitialError(appErrorMessage(err, "Could not load rows."));
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
    fetchPage(0);
    // fetchPage closes over sort/identity; resetAndLoadFirstPage is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, schema, table, sort, refetchNonce]);

  // Load the column header meta (pk/fk) once per identity. Independent of the
  // row pages — the prototype shows the icons from table metadata, not the
  // row result's column list.
  useEffect(() => {
    let alive = true;
    void loadColumns(handleId, schema, table).then((cols) => {
      if (!alive || !cols) return;
      const map = new Map<string, { pk: boolean; fk: FkRef | null }>();
      for (const c of cols) map.set(c.name, { pk: c.pk, fk: c.fk });
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
          <span>Empty table — no rows in {schema + "." + table}</span>
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
                    {/* M10 seam: column-insights chart icon, shown on th hover. */}
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
                    return (
                      <div
                        key={c.name}
                        className={"dg-td" + (isSel ? " cell-selected" : "")}
                        onClick={() => setSelected({ row: rowIndex, col: ci })}
                        // M11 seam: onDoubleClick → start inline edit.
                      >
                        <CellContent value={row[ci] ?? null} column={c.name} />
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
