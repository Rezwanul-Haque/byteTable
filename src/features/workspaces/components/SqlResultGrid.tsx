// SQL-results grid (M6, spec §3.7). UNLIKE the browse DataGrid (which pages a
// table from the backend), this renders a one-shot in-memory QueryResult:
// every row queryRun returned (up to the backend row_limit) is already in
// `result.rows`. We still virtualize the row axis with @tanstack/react-virtual
// so a large result (hundreds–thousands of rows) renders at 60fps without
// thousands of DOM nodes. Cells reuse the shared `CellContent` so visuals match
// the browse grid exactly. No header sort / no FK links here (FK is M10).

import { useVirtualizer } from "@tanstack/react-virtual";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { exportSave } from "../../../shared/api/engine";
import type { CellValue, QueryResult } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { useToast } from "../../../shared/ui/toastContext";
import { CellContent } from "../../browse/shared/GridCell";

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
/** Column overscan for the horizontal virtualizer; above the threshold columns
 *  are windowed too (a wide result no longer renders every column per row). */
const COL_OVERSCAN = 3;
const COL_VIRT_THRESHOLD = 30;
/** Minimum row-number gutter width (px) — matches `.dg-rownum` min-width. The
 *  track grows with the digit count so large row numbers aren't clipped. */
const ROWNUM_PX = 30;
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

export function SqlResultGrid({ result }: { result: QueryResult }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { columns, rows } = result;
  const toast = useToast();

  // Multi-select (by row index into the in-memory result). Cleared when a new
  // result lands (the component is keyed/remounted per run upstream).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [result]);
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

  // Export the selected rows (or all rows when none are checked) to CSV.
  const exportCsv = async () => {
    const idxs = selected.size > 0 ? [...selected].sort((a, b) => a - b) : rows.map((_, i) => i);
    if (!idxs.length) return;
    const esc = (v: CellValue) => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [columns.map((c) => c.name).join(",")]
      .concat(idxs.map((i) => columns.map((_, ci) => esc(rows[i]![ci] ?? null)).join(",")))
      .join("\n");
    try {
      const path = await save({
        defaultPath: "query-result.csv",
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
        return Math.round(Math.min(COL_MAX_PX, Math.max(COL_MIN_PX, headerPx, cellPx)));
      }),
    [columns, rows],
  );

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
    const tracks = winIdx.map((i) => colWidths[i] + "px").join(" ");
    if (!virtualizeCols) return lead + " " + tracks;
    return lead + " " + padL + "px " + tracks + " " + padR + "px";
  }, [rownumPx, colWidths, winIdx, virtualizeCols, padL, padR]);

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
              return (
                <div
                  key={c.name + ":" + ci}
                  className="dg-th"
                  title={c.typeHint ? c.name + " · " + c.typeHint : c.name}
                >
                  <span className="dg-head">
                    <span className="dg-colname">{c.name}</span>
                    {c.typeHint ? (
                      <span className="dg-coltype">{c.typeHint.toLowerCase()}</span>
                    ) : null}
                  </span>
                </div>
              );
            })}
            {virtualizeCols ? <div className="dg-pad" aria-hidden /> : null}
          </div>

          <div style={{ height: totalHeight, position: "relative" }}>
            {virtualRows.map((vr) => {
              const row = rows[vr.index]!;
              return (
                <div
                  key={vr.index}
                  className="dg-tr dg-row"
                  style={{ height: vr.size, transform: `translateY(${vr.start}px)` }}
                >
                  <div className="dg-check-c">
                    <input
                      type="checkbox"
                      className="dg-check"
                      checked={selected.has(vr.index)}
                      onChange={() => toggleRow(vr.index)}
                      aria-label={"Select row " + (vr.index + 1)}
                    />
                  </div>
                  <div className="dg-rownum">{vr.index + 1}</div>
                  {virtualizeCols ? <div className="dg-pad" aria-hidden /> : null}
                  {winIdx.map((ci) => {
                    const c = columns[ci]!;
                    return (
                      <div key={c.name + ":" + ci} className="dg-td">
                        <CellContent value={row[ci] ?? null} column={c.name} type={c.typeHint} />
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
