// Cassandra wide-column grid (ported from cassandra.jsx CassRowGrid):
// kind-coloured headers + key badges, hybrid inline editing (regular scalars
// inline; key columns locked; complex types route to the row modal via an
// open_in_full affordance), edited-cell highlight, and a row-number cell that
// opens the full row editor.

import { useCallback, useMemo, useRef, useState } from "react";

import { Icon } from "../../../../shared/ui/Icon";
import type { CassColumn } from "../api";
import { cassIsComplex } from "../cqlTypes";
import { CassValue, KeyBadge } from "./CassValue";
// Shared column-resize handle styling (.dg-col-resize / body.dg-col-resizing).
import "../../shared/DataGrid.css";

// Column-width estimate (sample a few rows, clamp). Cassandra results are
// bounded (no virtualization), so measuring across a small sample is cheap.
const CHAR_PX = 7;
const PAD_PX = 30; // cell padding (24) + a little slack for the type/badge chrome
const COL_MIN_PX = 90;
const COL_MAX_PX = 400;
/** Max width for a MANUALLY resized column (drag) — higher than the auto cap. */
const COL_MANUAL_MAX_PX = 1200;
/** Fixed leading-gutter widths (match the checkbox + row-number cells). */
const CHECK_PX = 34;
const IDX_PX = 40;
const WIDTH_SAMPLE_ROWS = 60;

/** Display length of a cell value (objects → JSON), for width estimation. */
function valLen(v: unknown): number {
  if (v === null || v === undefined) return 1;
  return typeof v === "object" ? JSON.stringify(v).length : String(v).length;
}

type Row = Record<string, unknown>;

interface GridTable {
  columns: CassColumn[];
}

interface CassRowGridProps {
  table: GridTable;
  rows: Row[];
  onOpenRow?: (row: Row) => void;
  editable?: boolean;
  onEditCell?: (row: Row, col: string, value: unknown) => void;
  isCellEdited?: (row: Row, col: string) => boolean;
  onComplexEdit?: (row: Row) => void;
  keyCols?: Set<string>;
  /** Multi-select by row index. When omitted, the checkbox column is hidden. */
  selected?: Set<number>;
  onToggleRow?: (i: number) => void;
  onToggleAll?: () => void;
}

interface EditingState {
  row: number;
  col: string;
  draft: string;
}

export function CassRowGrid({
  table,
  rows,
  onOpenRow,
  editable,
  onEditCell,
  isCellEdited,
  onComplexEdit,
  keyCols,
  selected,
  onToggleRow,
  onToggleAll,
}: CassRowGridProps) {
  const [editing, setEditing] = useState<EditingState | null>(null);
  // Manual column-width overrides (px) by column name (session-only). A value
  // wins over the auto estimate; cleared per column by double-clicking its
  // handle. `draggingCol` drives the live `--cass-col-w` var resize.
  const [colWidthOverrides, setColWidthOverrides] = useState<Record<string, number>>({});
  const [draggingCol, setDraggingCol] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Per-column px width — a manual override, else estimated from the header +
  // a sample of cell lengths. Drives the <colgroup> tracks (table-layout: fixed).
  const colWidths = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of table.columns) {
      const override = colWidthOverrides[c.name];
      if (override != null) {
        map[c.name] = Math.round(Math.min(COL_MANUAL_MAX_PX, Math.max(COL_MIN_PX, override)));
        continue;
      }
      let maxLen = c.name.length + c.type.length + 4;
      for (let i = 0; i < rows.length && i < WIDTH_SAMPLE_ROWS; i++) {
        const len = valLen(rows[i]?.[c.name]);
        if (len > maxLen) maxLen = len;
      }
      map[c.name] = Math.round(
        Math.min(COL_MAX_PX, Math.max(COL_MIN_PX, maxLen * CHAR_PX + PAD_PX)),
      );
    }
    return map;
  }, [table.columns, rows, colWidthOverrides]);

  // Drag a header's right-edge handle to set a manual width. During the drag the
  // width is written to the `--cass-col-w` var on the scroll wrap (pure CSS
  // repaint — no re-render), committed to state on release. Mirrors the other
  // grids; here the var feeds the dragged column's <col> width.
  const startColResize = useCallback((e: React.MouseEvent, colName: string, startWidth: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const wrap = wrapRef.current;
    const startX = e.clientX;
    let finalW = startWidth;
    setDraggingCol(colName);
    wrap?.style.setProperty("--cass-col-w", startWidth + "px");
    document.body.classList.add("dg-col-resizing");
    const onMove = (me: MouseEvent) => {
      finalW = Math.min(
        COL_MANUAL_MAX_PX,
        Math.max(COL_MIN_PX, startWidth + (me.clientX - startX)),
      );
      wrap?.style.setProperty("--cass-col-w", finalW + "px");
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dg-col-resizing");
      setColWidthOverrides((prev) => ({ ...prev, [colName]: finalW }));
      setDraggingCol(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const autofitCol = useCallback((colName: string) => {
    setColWidthOverrides((prev) => {
      if (!(colName in prev)) return prev;
      const next = { ...prev };
      delete next[colName];
      return next;
    });
  }, []);

  if (!rows.length) return <div className="grid-empty">No rows</div>;
  const keys = keyCols ?? new Set<string>();
  const selectable = !!onToggleRow;
  const sel = selected ?? new Set<number>();
  const allChecked = rows.length > 0 && sel.size === rows.length;

  const startEdit = (ri: number, col: string, val: unknown) =>
    setEditing({ row: ri, col, draft: val === null || val === undefined ? "" : String(val) });

  const commit = () => {
    if (!editing) return;
    const row = rows[editing.row];
    const original = row?.[editing.col];
    let v: unknown = editing.draft;
    if (typeof original === "number" && v !== "" && !isNaN(Number(v))) v = Number(v);
    else if (typeof original === "boolean") v = (v as string).trim().toLowerCase() === "true";
    else if (v === "" && (original === null || original === undefined)) v = null;
    if (v !== original && onEditCell && row) onEditCell(row, editing.col, v);
    setEditing(null);
  };

  return (
    <div className="cass-grid-wrap" ref={wrapRef}>
      <table className="cass-grid">
        {/* Fixed-layout column tracks: measured widths (the dragged column reads
            the live --cass-col-w var). table-layout:fixed makes these authoritative. */}
        <colgroup>
          {selectable ? <col style={{ width: CHECK_PX }} /> : null}
          <col style={{ width: IDX_PX }} />
          {table.columns.map((c) => (
            <col
              key={c.name}
              style={{
                width:
                  c.name === draggingCol
                    ? `var(--cass-col-w, ${colWidths[c.name]}px)`
                    : colWidths[c.name] + "px",
              }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {selectable ? (
              <th className="cass-grid-check">
                <input
                  type="checkbox"
                  className="cass-check"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = sel.size > 0 && !allChecked;
                  }}
                  onChange={() => onToggleAll?.()}
                  aria-label="Select all rows"
                />
              </th>
            ) : null}
            <th className="cass-grid-idx">#</th>
            {table.columns.map((c) => (
              <th key={c.name} className={"cass-col-" + c.kind}>
                <span className="cass-th-name">{c.name}</span>
                <KeyBadge kind={c.kind} />
                <span className="cass-th-type">{c.type}</span>
                {/* Right-edge resize handle (shared .dg-col-resize styling). */}
                <span
                  className={"dg-col-resize" + (draggingCol === c.name ? " active" : "")}
                  title="Drag to resize · double-click to auto-fit"
                  onMouseDown={(e) => startColResize(e, c.name, colWidths[c.name]!)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    autofitCol(c.name);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={"cass-row" + (sel.has(i) ? " selected" : "")}>
              {selectable ? (
                <td className="cass-grid-check" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="dg-check"
                    checked={sel.has(i)}
                    onChange={() => onToggleRow?.(i)}
                    aria-label={"Select row " + (i + 1)}
                  />
                </td>
              ) : null}
              <td
                className="cass-grid-idx cass-grid-open"
                onClick={() => onOpenRow?.(r)}
                title="Open full row editor"
              >
                {i + 1}
              </td>
              {table.columns.map((c) => {
                const isKey = keys.has(c.name);
                const complex = cassIsComplex(c.type);
                const isEditing = editing && editing.row === i && editing.col === c.name;
                const edited = isCellEdited?.(r, c.name);
                const cls =
                  "cass-cell cass-col-" +
                  c.kind +
                  (edited ? " cass-cell-edited" : "") +
                  (isEditing ? " cass-cell-editing" : "") +
                  (editable && isKey ? " cass-cell-locked" : "");
                const onDbl = () => {
                  if (!editable) {
                    onOpenRow?.(r);
                    return;
                  }
                  if (isKey) return;
                  if (complex) onComplexEdit?.(r);
                  else startEdit(i, c.name, r[c.name]);
                };
                return (
                  <td
                    key={c.name}
                    className={cls}
                    onDoubleClick={onDbl}
                    title={
                      editable
                        ? isKey
                          ? "Primary-key column — locked (delete + re-insert to change)"
                          : complex
                            ? "Double-click to edit in row editor"
                            : "Double-click to edit"
                        : ""
                    }
                  >
                    {isEditing ? (
                      <input
                        className="cass-cell-input mg-mono"
                        autoFocus
                        value={editing.draft}
                        onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                        onBlur={commit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commit();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                          }
                        }}
                      />
                    ) : (
                      <>
                        <CassValue v={r[c.name]} type={c.type} />
                        {editable && !isKey && complex ? (
                          <button
                            className="cass-cell-expand"
                            title="Edit in row editor"
                            onClick={(e) => {
                              e.stopPropagation();
                              onComplexEdit?.(r);
                            }}
                          >
                            <Icon name="open_in_full" size={11} />
                          </button>
                        ) : null}
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
