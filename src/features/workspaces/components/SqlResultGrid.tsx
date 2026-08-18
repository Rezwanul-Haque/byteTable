// SQL-results grid (M6, spec §3.7). UNLIKE the browse DataGrid (which pages a
// table from the backend), this renders a one-shot in-memory QueryResult:
// every row queryRun returned (up to the backend row_limit) is already in
// `result.rows`. We still virtualize the row axis with @tanstack/react-virtual
// so a large result (hundreds–thousands of rows) renders at 60fps without
// thousands of DOM nodes. Cells reuse the shared `CellContent` so visuals match
// the browse grid exactly. No FK links here (FK is M10).
//
// Header sort mirrors the browse DataGrid's affordance (a header click cycles
// asc → desc → none) but is CLIENT-side: there is no query to re-run and no
// backend paging here, so the already-materialized rows are reordered in
// memory. It sorts what the query RETURNED — with a backend row_limit in play
// that is the returned page, not the whole table.

import { useVirtualizer } from "@tanstack/react-virtual";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { exportSave } from "../../../shared/api/engine";
import type { CellValue, QueryResult, SortSpec } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { CopyButton } from "../../../shared/ui/CopyButton";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { CellContent } from "../../browse/shared/GridCell";

import { cycleSort, sortedOrder } from "./resultSort";

/** Row overscan handed to the virtualizer (DOM rows beyond the viewport). */
const ROW_OVERSCAN = 12;
/** Fallback row height before the CSS var is measured (compact default). */
const FALLBACK_ROW_H = 26;

// --- explicit per-column pixel widths (shared by header + every body row) ---
// Each `.dg-row` is its own CSS grid (the body rows are absolutely positioned
// by the virtualizer, so a single shared grid is impossible). With `max-content`
// tracks, every row resolved its own track widths from its own content → the
// header and body computed DIFFERENT widths and columns drifted. Fix (mirrors
// the browse DataGrid): measure one explicit pixel width per column ONCE (max of
// the header's intrinsic width and the widest sampled cell, clamped) and build
// the template from those fixed px tracks so every row uses identical tracks.

/** Min/max column track width (px). MAX bounds one long value from blowing out
 *  the layout — the cell ellipsizes/scrolls within it. */
const COL_MIN_PX = 90;
const COL_MAX_PX = 400;
/** Max width for a MANUALLY resized column (drag) — higher than the auto cap so
 *  the user can widen a column past what auto-fit would pick (mirrors the browse
 *  DataGrid). */
const COL_MANUAL_MAX_PX = 1200;
/** Column overscan for the horizontal virtualizer; above the threshold columns
 *  are windowed too (a wide result no longer renders every column per row). */
const COL_OVERSCAN = 3;
const COL_VIRT_THRESHOLD = 30;
/** Minimum row-number gutter width (px) — MUST match `.dg-rownum`'s CSS
 *  `min-width: 40px`. If the track is narrower than that, the sticky gutter
 *  overflows its grid track and paints over the first data cell's left padding
 *  (the "first column hugs the left edge" bug). The track grows with the digit
 *  count so large row numbers aren't clipped. */
const ROWNUM_PX = 40;
/** Per-digit width of the row number (12.5px tabular-nums) + gutter padding. */
const ROWNUM_DIGIT_PX = 7.5;
const ROWNUM_PAD_PX = 14;
/** Multi-select checkbox gutter width (px) — matches `.dg-check-c`. */
const CHECK_PX = 34;
/** Horizontal cell/header padding (px) — `.dg-td`/`.dg-th` are `0 12px`. */
const CELL_PAD_PX = 24;
/** Cheap mono-font width estimates (JetBrains Mono ≈ 0.6em advance). Body cell
 *  ~12px (~7.3px/char); header name 11.5px (~7px/char); type label 9.5px
 *  (~5.7px/char). Estimates only — clamp + ellipsis absorb the slack. */
const CELL_CHAR_PX = 7.3;
const HEAD_NAME_CHAR_PX = 7;
const HEAD_TYPE_CHAR_PX = 5.7;
/** Small slack for the header name↔type gap (this grid has no header icons). */
const HEAD_GAP_PX = 10;
/** Rows sampled when measuring cell widths — enough to be representative without
 *  scanning a multi-thousand-row result on every recompute. */
const WIDTH_SAMPLE_ROWS = 200;

/** Render width of one cell value, mirroring CellContent's text output (numbers
 *  print compact — integer as-is, else `toFixed(2)`; everything else its string
 *  form; NULL → "null"). */
function cellTextLength(value: unknown): number {
  if (value === null || value === undefined) return 4; // "null"
  if (typeof value === "number")
    return (Number.isInteger(value) ? String(value) : value.toFixed(2)).length;
  return String(value).length;
}

/** A cell value as clipboard text: objects → JSON (same as the CSV export),
 *  everything else its string form. */
function cellText(value: CellValue): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

interface SqlResultGridProps {
  result: QueryResult;
  /**
   * Controlled sort. When `onSort` is given the PARENT owns ordering — it hands
   * over rows already in display order — and this grid only draws the indicator
   * and reports header clicks. Used by the data-file viewer (M35), which sorts
   * the whole file and then pages it, so a header click cannot be allowed to
   * reorder just the visible page. Omit both props for the default behaviour:
   * the grid sorts the result it was given, in place.
   */
  sort?: SortSpec | null;
  onSort?: (next: SortSpec | null) => void;
  /** Default file name the CSV export offers. */
  exportName?: string;
  /**
   * Every row behind `result`, in display order, when `result` holds only the
   * visible PAGE of a larger set — the data-file viewer pages in the parent.
   * "Export all CSV" writes these, so the button means what it says; exporting
   * a selection still uses the page, which is the only place a row can be
   * checked. Omit when `result` already is the whole thing.
   */
  allRows?: CellValue[][];
  /**
   * Opt-in inline editing (the M35 data-file editor). Absent — the default for
   * SQL results, which have no row identity to write back to — the grid stays
   * read-only exactly as before.
   *
   * Nothing here writes anything: a commit is reported to the owner, which
   * STAGES it. The classes are the browse grid's, so a staged cell looks
   * identical whether the row lives in a table or a file.
   */
  editing?: GridEditing;
  /**
   * Extra controls for the selection bar, given the checked row indexes. Lets an
   * owner add row-scoped actions (the data-file editor's Delete) without this
   * component having to know about them, or selection having to be lifted out.
   */
  selectionActions?: (selected: number[]) => ReactNode;
  /**
   * Opt-in row inspector. Given it, the row-number gutter gains the browse
   * grid's eye button and a single click on a cell opens the drawer on that
   * field. Absent, the gutter is a plain number as before.
   */
  inspecting?: GridInspecting;
}

/** The row-inspector seam: which row is open, and how to open one. */
export interface GridInspecting {
  /** Open the drawer on a row, optionally focused on a column. */
  onOpen: (rowIdx: number, colIdx: number | null) => void;
  /** The row currently in the drawer, so its gutter can mark itself. */
  openRow: number | null;
  /**
   * True while the drawer holds un-staged drafts. A cell click then only moves
   * the selection — re-targeting the drawer would discard what the user is
   * part-way through typing (the browse grid's `inspectDirty` gate).
   */
  dirty?: boolean;
}

/** The editing seam: what is staged, and where a commit goes. */
export interface GridEditing {
  /** Double-click a cell → edit. Reported as `(rowIdx, colIdx, newText)`. */
  onCommit: (rowIdx: number, colIdx: number, value: string) => void;
  /** Staged cells as `"row:col"`, for the accent tint + left bar. */
  dirty: Set<string>;
  /** Rows staged as NEW (accent row + gutter mark). */
  stagedRows?: Set<number>;
  /** Rows staged for DELETION (struck through). */
  deletedRows?: Set<number>;
}

export function SqlResultGrid({
  result,
  sort: controlledSort,
  onSort,
  exportName = "query-result.csv",
  allRows,
  editing,
  selectionActions,
  inspecting,
}: SqlResultGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { columns, rows } = result;
  const toast = useToast();
  const controlled = onSort !== undefined;

  // The focused cell (single click). Purely presentational — it draws the
  // accent outline and tells the inspector which field to land on.
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  // The cell currently under an inline editor, and its working text. Local:
  // an in-progress edit is not staged until it commits.
  const [editCell, setEditCell] = useState<{ row: number; col: number } | null>(null);
  const [editText, setEditText] = useState("");
  const beginEdit = (row: number, col: number, value: CellValue) => {
    if (!editing) return;
    setEditCell({ row, col });
    setEditText(value === null ? "" : String(value));
  };
  const commitEdit = () => {
    if (!editCell || !editing) return;
    editing.onCommit(editCell.row, editCell.col, editText);
    setEditCell(null);
  };

  // Multi-select (by row index into the in-memory result). Cleared when a new
  // result lands (the component is keyed/remounted per run upstream).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Manual column-width overrides (px), keyed by column name. Session-only (no
  // persistence, matching the browse DataGrid); a value here wins over the
  // auto-measured width. Cleared per column by double-clicking its handle.
  const [colOverrides, setColOverrides] = useState<Record<string, number>>({});
  // The column being drag-resized (null when idle). While dragging, its width is
  // driven by the `--dg-col-w` CSS var (pure repaint, no re-render / re-window);
  // the final px value commits to `colOverrides` on release.
  const [draggingCol, setDraggingCol] = useState<string | null>(null);
  // Client-side header sort; null = the query's own row order. Ignored (and
  // never written) when the parent controls the sort.
  const [localSort, setLocalSort] = useState<SortSpec | null>(null);
  const sort = controlled ? (controlledSort ?? null) : localSort;
  useEffect(() => {
    setSelected(new Set());
    setLocalSort(null);
  }, [result]);
  const clickHeader = (column: string) => {
    if (onSort) onSort(cycleSort(sort, column));
    else setLocalSort((s) => cycleSort(s, column));
  };
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && !allSelected;
  const toggleRow = (i: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((_, i) => i))));

  // Display order as row indexes INTO `rows` — sorting reorders this, never the
  // result itself, so selection (keyed by the original index) and the measured
  // column widths survive a sort untouched.
  const order = useMemo(() => {
    // Controlled: the rows arrived in display order already.
    if (controlled || !sort) return rows.map((_, i) => i);
    return sortedOrder(
      rows,
      columns.findIndex((c) => c.name === sort.column),
      sort.direction,
    );
  }, [rows, columns, sort, controlled]);

  // Export the selected rows (or every row when none are checked) to CSV, in
  // the order they're displayed — a sorted grid exports sorted. With no
  // selection and an `allRows` set behind the page, "all" really is all.
  const exportCsv = async () => {
    const selecting = selected.size > 0;
    const source = !selecting && allRows ? allRows : rows;
    const idxs = selecting ? order.filter((i) => selected.has(i)) : source.map((_, i) => i);
    if (!idxs.length) return;
    const esc = (v: CellValue) => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [columns.map((c) => c.name).join(",")]
      .concat(idxs.map((i) => columns.map((_, ci) => esc(source[i]![ci] ?? null)).join(",")))
      .join("\n");
    try {
      const path = await save({
        defaultPath: exportName,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await exportSave(path, csv);
      toast(`Exported ${idxs.length} row${idxs.length === 1 ? "" : "s"} to CSV`, "ok");
    } catch (e) {
      toast(appErrorMessage(e, "Could not export CSV"), "err");
    }
  };

  // Row height tracks the live density token (--grid-row-h: 26/32), same as
  // the browse grid, so SQL results match the rest of the app.
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_H);
  useLayoutEffect(() => {
    const read = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--grid-row-h").trim();
      const px = parseFloat(v);
      if (!Number.isNaN(px) && px > 0) setRowHeight((prev) => (prev === px ? prev : px));
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    return () => obs.disconnect();
  }, []);

  // React Compiler bails out of memoizing this component because
  // `useVirtualizer()` returns non-memoizable functions. Safe here: its outputs
  // (`virtualRows`/`totalHeight`) are consumed in this component's own render
  // and never passed to a memoized child, so there's no stale-UI risk.
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: ROW_OVERSCAN,
  });

  // Measured px width per column (shared by the CSS grid tracks and the
  // horizontal virtualizer). Each = clamp(max(header intrinsic, widest sampled
  // cell), MIN, MAX).
  const colWidths = useMemo(
    () =>
      columns.map((c, ci) => {
        const typeLen = c.typeHint ? c.typeHint.length : 0;
        const headerPx =
          c.name.length * HEAD_NAME_CHAR_PX +
          typeLen * HEAD_TYPE_CHAR_PX +
          HEAD_GAP_PX +
          CELL_PAD_PX;
        let maxCellLen = 0;
        const sampleN = Math.min(rows.length, WIDTH_SAMPLE_ROWS);
        for (let r = 0; r < sampleN; r++) {
          const len = cellTextLength(rows[r]![ci] ?? null);
          if (len > maxCellLen) maxCellLen = len;
        }
        const cellPx = maxCellLen * CELL_CHAR_PX + CELL_PAD_PX;
        const auto = Math.round(Math.min(COL_MAX_PX, Math.max(COL_MIN_PX, headerPx, cellPx)));
        // A manual override (drag) wins over the auto-measured width.
        return colOverrides[c.name] ?? auto;
      }),
    [columns, rows, colOverrides],
  );

  // Drag a header's right-edge handle to set a manual column width (session
  // only). During the drag the width is written to the `--dg-col-w` CSS var on
  // the scroll container — a pure repaint, so there is NO React re-render and NO
  // virtualizer re-window per frame. The final width commits to state on release.
  const startColResize = (e: React.MouseEvent, colName: string, startWidth: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const wrap = scrollRef.current;
    const startX = e.clientX;
    let finalW = startWidth;
    setDraggingCol(colName);
    wrap?.style.setProperty("--dg-col-w", startWidth + "px");
    document.body.classList.add("dg-col-resizing");
    const onMove = (me: MouseEvent) => {
      finalW = Math.min(
        COL_MANUAL_MAX_PX,
        Math.max(COL_MIN_PX, startWidth + (me.clientX - startX)),
      );
      wrap?.style.setProperty("--dg-col-w", finalW + "px");
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dg-col-resizing");
      setColOverrides((prev) => ({ ...prev, [colName]: finalW }));
      setDraggingCol(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Double-click the handle → drop the override, auto-fit back to measured.
  const autofitCol = (colName: string) => {
    setColOverrides((prev) => {
      if (!(colName in prev)) return prev;
      const next = { ...prev };
      delete next[colName];
      return next;
    });
  };

  // Row-number gutter sized to the largest row number (see the browse DataGrid).
  const rownumPx = useMemo(() => {
    const digits = Math.max(2, String(Math.max(1, rows.length)).length);
    return Math.max(ROWNUM_PX, Math.ceil(digits * ROWNUM_DIGIT_PX + ROWNUM_PAD_PX));
  }, [rows.length]);

  // Column (horizontal) virtualization: a wide result renders only the columns in
  // view, bracketed by two pad tracks summing the off-screen columns' widths so
  // the canvas width and every row's tracks stay identical to the full layout.
  // Below the threshold every column renders (windowing gains nothing).
  const virtualizeCols = columns.length > COL_VIRT_THRESHOLD;

  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colWidths[i] ?? COL_MIN_PX,
    overscan: COL_OVERSCAN,
  });
  const colWidthSig = colWidths.join(",");
  useEffect(() => {
    colVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colWidthSig]);

  const colItems = colVirtualizer.getVirtualItems();
  let padL = 0;
  let padR = 0;
  let winIdx = columns.map((_, i) => i);
  if (virtualizeCols && colItems.length > 0) {
    const last = colItems[colItems.length - 1]!;
    padL = colItems[0]!.start;
    padR = colVirtualizer.getTotalSize() - (last.start + last.size);
    winIdx = colItems.map((vi) => vi.index);
  }

  // Grid column template: gutters + [pad] + visible tracks + [pad].
  const gridCols = useMemo(() => {
    const lead = CHECK_PX + "px " + rownumPx + "px";
    // The actively-resized column's track reads the live `--dg-col-w` var (with
    // its current width as the fallback) so the drag repaints via CSS alone.
    const tracks = winIdx
      .map((i) =>
        columns[i]!.name === draggingCol
          ? `var(--dg-col-w, ${colWidths[i]}px)`
          : colWidths[i] + "px",
      )
      .join(" ");
    if (!virtualizeCols) return lead + " " + tracks;
    return lead + " " + padL + "px " + tracks + " " + padR + "px";
  }, [rownumPx, colWidths, columns, winIdx, virtualizeCols, padL, padR, draggingCol]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <>
      <div className="dg-selbar dg-result-selbar">
        <span className="dg-selbar-count">
          {selected.size > 0
            ? `${selected.size} selected`
            : `${rows.length} row${rows.length === 1 ? "" : "s"}`}
        </span>
        <div style={{ flex: 1 }} />
        {selectionActions?.([...selected])}
        <Btn icon="download" variant="tonal" small onClick={() => void exportCsv()}>
          {selected.size > 0 ? "Export CSV" : "Export all CSV"}
        </Btn>
      </div>
      <div className="datagrid-wrap" ref={scrollRef}>
        <div className="dg-canvas" style={{ "--grid-cols": gridCols } as React.CSSProperties}>
          <div className="dg-header dg-row">
            <div className="dg-check-c dg-check-h">
              <input
                type="checkbox"
                className="dg-check"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={toggleAll}
                aria-label="Select all rows"
              />
            </div>
            <div className="dg-rownum-h">#</div>
            {virtualizeCols ? <div className="dg-pad" aria-hidden /> : null}
            {winIdx.map((ci) => {
              const c = columns[ci]!;
              const active = sort?.column === c.name;
              return (
                <div
                  key={c.name + ":" + ci}
                  className="dg-th sortable"
                  onClick={() => clickHeader(c.name)}
                  title={
                    (c.typeHint ? c.name + " · " + c.typeHint : c.name) +
                    " · click to sort these results"
                  }
                >
                  <span className="dg-head">
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
                  </span>
                  {/* Right-edge resize handle: drag to set a manual width,
                      double-click to auto-fit. */}
                  <span
                    className={"dg-col-resize" + (draggingCol === c.name ? " active" : "")}
                    title="Drag to resize · double-click to auto-fit"
                    onMouseDown={(e) => startColResize(e, c.name, colWidths[ci]!)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      autofitCol(c.name);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              );
            })}
            {virtualizeCols ? <div className="dg-pad" aria-hidden /> : null}
          </div>

          <div style={{ height: totalHeight, position: "relative" }}>
            {virtualRows.map((vr) => {
              // `vr.index` is the DISPLAY position; `rowIdx` the row's index in
              // the untouched result (what selection is keyed by).
              const rowIdx = order[vr.index]!;
              const row = rows[rowIdx]!;
              const staged = editing?.stagedRows?.has(rowIdx) ?? false;
              const dropped = editing?.deletedRows?.has(rowIdx) ?? false;
              return (
                <div
                  key={rowIdx}
                  className={
                    "dg-tr dg-row" + (staged ? " row-staged" : "") + (dropped ? " row-deleted" : "")
                  }
                  style={{ height: vr.size, transform: `translateY(${vr.start}px)` }}
                >
                  <div className="dg-check-c">
                    <input
                      type="checkbox"
                      className="dg-check"
                      checked={selected.has(rowIdx)}
                      onChange={() => toggleRow(rowIdx)}
                      aria-label={"Select row " + (vr.index + 1)}
                    />
                  </div>
                  <div
                    className={"dg-rownum" + (inspecting?.openRow === rowIdx ? " inspecting" : "")}
                    title={inspecting ? "Inspect row (⌘E / Ctrl+E)" : undefined}
                    onClick={inspecting ? () => inspecting.onOpen(rowIdx, null) : undefined}
                  >
                    {inspecting ? (
                      <>
                        {/* The same two layers as the browse grid: the number,
                            which the CSS swaps on hover for the accent reader
                            pill, and a staged row's ✱ marker. */}
                        <span className="dg-rownum-n">{staged ? "✱" : vr.index + 1}</span>
                        <span className="dg-rownum-eye">
                          <Icon name="chrome_reader_mode" size={13} />
                        </span>
                      </>
                    ) : (
                      vr.index + 1
                    )}
                  </div>
                  {virtualizeCols ? <div className="dg-pad" aria-hidden /> : null}
                  {winIdx.map((ci) => {
                    const c = columns[ci]!;
                    const cellVal = row[ci] ?? null;
                    const isEditing = editCell?.row === rowIdx && editCell.col === ci;
                    const isDirty = editing?.dirty.has(rowIdx + ":" + ci) ?? false;
                    const isSelected = selectedCell?.row === rowIdx && selectedCell.col === ci;
                    return (
                      <div
                        key={c.name + ":" + ci}
                        className={
                          "dg-td" +
                          (isSelected ? " cell-selected" : "") +
                          (isDirty ? " cell-edited" : "") +
                          (isEditing ? " cell-editing" : "")
                        }
                        // Single click focuses the cell and lands the inspector
                        // on that field; double click edits it. The same split
                        // as the browse grid, so the two feel identical.
                        onClick={() => {
                          setSelectedCell({ row: rowIdx, col: ci });
                          if (inspecting && !inspecting.dirty) inspecting.onOpen(rowIdx, ci);
                        }}
                        onDoubleClick={() => beginEdit(rowIdx, ci, cellVal)}
                        title={editing && !isEditing ? "Double-click to edit" : undefined}
                      >
                        {isEditing ? (
                          <input
                            className="cell-input"
                            autoFocus
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitEdit();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                // Abandon the edit; the staged value (if any)
                                // stays as it was.
                                setEditCell(null);
                              }
                            }}
                            aria-label={"Edit " + c.name}
                          />
                        ) : (
                          <>
                            <CellContent value={cellVal} column={c.name} type={c.typeHint} />
                            {/* Hover copy button — copies the raw value. */}
                            {cellVal !== null ? (
                              <CopyButton
                                className="dg-copy"
                                label={"Copy " + c.name + " value"}
                                text={cellText(cellVal)}
                              />
                            ) : null}
                          </>
                        )}
                      </div>
                    );
                  })}
                  {virtualizeCols ? <div className="dg-pad" aria-hidden /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
