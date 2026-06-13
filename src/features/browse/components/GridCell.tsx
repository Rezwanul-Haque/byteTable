// Shared, type-aware grid cell rendering (spec §1.3 / §3.5). Extracted from
// DataGrid so the M6 SQL-results grid renders cells identically (NULL → faint
// small-caps "null", numbers right-aligned in the number color, booleans
// accent/red, status/method strings as tinted enum pills, everything else
// plain text). Both grids import `CellContent` so there is one source of
// truth for cell visuals — keep this the only place the .cell-* classes are
// produced.
//
// M10 seam: FK columns become accent links here (the peek popover hops the
// reference). This milestone renders FK values as plain text in both grids.

import type { CellValue } from "../../../shared/api/engine";

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
export function CellContent({ value, column }: { value: CellValue; column: string }) {
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
  return <span className="cell-text">{s}</span>;
}
