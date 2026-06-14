// SQL-results grid (M6, spec §3.7). UNLIKE the browse DataGrid (which pages a
// table from the backend), this renders a one-shot in-memory QueryResult:
// every row queryRun returned (up to the backend row_limit) is already in
// `result.rows`. We still virtualize the row axis with @tanstack/react-virtual
// so a large result (hundreds–thousands of rows) renders at 60fps without
// thousands of DOM nodes. Cells reuse the shared `CellContent` so visuals match
// the browse grid exactly. No header sort / no FK links here (FK is M10).

import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { QueryResult } from "../../../shared/api/engine";
import { CellContent } from "../../browse/components/GridCell";

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
/** Row-number gutter width (px) — matches `.dg-rownum` min-width. */
const ROWNUM_PX = 38;
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

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: ROW_OVERSCAN,
  });

  // Grid column template: row-number gutter + one EXPLICIT pixel track per
  // column, shared by the header and every body row so columns line up exactly.
  // Each track = clamp(max(header intrinsic, widest sampled cell), MIN, MAX).
  const gridCols = useMemo(() => {
    const widths = columns.map((c, ci) => {
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
      return Math.round(Math.min(COL_MAX_PX, Math.max(COL_MIN_PX, headerPx, cellPx))) + "px";
    });
    return ROWNUM_PX + "px " + widths.join(" ");
  }, [columns, rows]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <div className="datagrid-wrap" ref={scrollRef}>
      <div className="dg-canvas" style={{ "--grid-cols": gridCols } as React.CSSProperties}>
        <div className="dg-header dg-row">
          <div className="dg-rownum-h">#</div>
          {columns.map((c, ci) => (
            <div
              key={c.name + ":" + ci}
              className="dg-th"
              title={c.typeHint ? c.name + " · " + c.typeHint : c.name}
            >
              <span className="dg-head">
                <span className="dg-colname">{c.name}</span>
                {c.typeHint ? <span className="dg-coltype">{c.typeHint.toLowerCase()}</span> : null}
              </span>
            </div>
          ))}
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
                <div className="dg-rownum">{vr.index + 1}</div>
                {columns.map((c, ci) => (
                  <div key={c.name + ":" + ci} className="dg-td">
                    <CellContent value={row[ci] ?? null} column={c.name} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
