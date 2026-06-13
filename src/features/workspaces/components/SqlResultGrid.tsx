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

  const gridCols = useMemo(
    () => "38px " + columns.map(() => "minmax(90px, max-content)").join(" "),
    [columns],
  );

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
