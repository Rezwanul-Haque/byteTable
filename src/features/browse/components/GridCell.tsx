// Shared, type-aware grid cell rendering (spec §1.3 / §3.5). Extracted from
// DataGrid so the M6 SQL-results grid renders cells identically (NULL → faint
// small-caps "null", numbers right-aligned in the number color, booleans
// accent/red, status/method strings as tinted enum pills, everything else
// plain text). Both grids import `CellContent` so there is one source of
// truth for cell visuals — keep this the only place the .cell-* classes are
// produced.
//
// M10: FK columns render as accent underlined links here when the cell is
// given FK metadata + an onFkClick callback (DataGrid threads them from
// tableMeta's columns[].fk; the peek popover then hops the reference). A cell
// without `fk`/`onFkClick` (or a NULL value) renders exactly as before, so the
// SQL-results grid — which has no per-column table origin (see SqlResultGrid)
// — is unchanged until/unless an origin is supplied.

import type { CellValue, FkRef } from "../../../shared/api/engine";
import { Icon } from "../../../shared/ui/Icon";
import { formatBinary, isBinaryType } from "./binaryCell";
import { isJsonType, jsonPreview } from "./jsonCell";
import "./CellEditors.css";

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

interface CellContentProps {
  value: CellValue;
  column: string;
  /**
   * The column's foreign-key target (M10 FK hop). When present *and* the value
   * is non-NULL *and* `onFkClick` is supplied, the cell renders as an accent
   * underlined link button; clicking it hops the reference (DataGrid opens the
   * FK peek popover). NULL values and columns without `fk`/`onFkClick` render
   * normally.
   */
  fk?: FkRef | null;
  /** Called with the cell's value + the click event when an FK link is clicked. */
  onFkClick?: (value: CellValue, event: React.MouseEvent<HTMLButtonElement>) => void;
  /** The column's declared type, used to render JSON/binary cells specially. */
  type?: string;
  /** Opens the JSON editor (DataGrid only); display-only grids omit it. */
  onJsonClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Opens the binary editor (DataGrid only); display-only grids omit it. */
  onBinClick?: (event: React.MouseEvent<HTMLElement>) => void;
}

/** One cell's rendered value, typed per spec §1.3 / §3.5. */
export function CellContent({
  value,
  column,
  fk,
  onFkClick,
  type,
  onJsonClick,
  onBinClick,
}: CellContentProps) {
  if (value === null) {
    // NULL → italic faint small-caps "null" (a NULL FK is not a link).
    return <span className="cell-null">null</span>;
  }
  // Binary (BINARY/VARBINARY/BLOB/BYTEA) → BIN badge + UUID/hex/blob chip; takes
  // precedence over the plain FK link so a binary key shows its UUID. When the
  // column is ALSO an FK, the chip hops on click (single-click → peek, the
  // DataGrid defers it so a double-click edits instead); a non-FK binary chip
  // opens the editor on click. Read-only grids (no handlers) render a span.
  if (type && isBinaryType(type)) {
    const fb = formatBinary(value, type);
    if (fb) {
      const inner = (
        <>
          <span className="bin-badge">BIN</span>
          <span className={"bin-val " + fb.kind}>{fb.text}</span>
        </>
      );
      const hop = fk && onFkClick;
      if (hop || onBinClick) {
        return (
          <button
            type="button"
            className="bin-cell"
            onClick={(e) => {
              e.stopPropagation();
              if (hop) onFkClick!(value, e);
              else onBinClick!(e);
            }}
            title={hop ? "→ " + fk.table + " · double-click to edit" : "BINARY · double-click to edit"}
          >
            {inner}
          </button>
        );
      }
      return <span className="bin-cell">{inner}</span>;
    }
  }
  // JSON / JSONB → data_object icon + one-line preview.
  if (type && isJsonType(type) && typeof value === "string") {
    const inner = (
      <>
        <Icon name="data_object" size={11} style={{ color: "var(--accent)" }} />
        <span className="json-cell-prev">{jsonPreview(value)}</span>
      </>
    );
    return onJsonClick ? (
      <button
        type="button"
        className="json-cell"
        onClick={(e) => {
          e.stopPropagation();
          onJsonClick(e);
        }}
        title="Double-click to edit JSON"
      >
        {inner}
      </button>
    ) : (
      <span className="json-cell">{inner}</span>
    );
  }
  // FK link (M10 §3.5): accent underlined, keyboard-operable button. Only when
  // the column has an FK target and a hop handler — otherwise fall through to
  // the normal type-aware rendering below.
  if (fk && onFkClick) {
    return (
      <button
        type="button"
        className="fk-link"
        onClick={(e) => onFkClick(value, e)}
        title={"→ " + fk.table + (fk.column ? "." + fk.column : "")}
      >
        {typeof value === "number" && !Number.isInteger(value) ? value.toFixed(2) : String(value)}
      </button>
    );
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
