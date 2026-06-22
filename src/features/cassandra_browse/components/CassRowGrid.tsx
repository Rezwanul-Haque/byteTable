// Cassandra wide-column grid (ported from cassandra.jsx CassRowGrid):
// kind-coloured headers + key badges, hybrid inline editing (regular scalars
// inline; key columns locked; complex types route to the row modal via an
// open_in_full affordance), edited-cell highlight, and a row-number cell that
// opens the full row editor.

import { useState } from "react";

import { Icon } from "../../../shared/ui/Icon";
import type { CassColumn } from "../api";
import { cassIsComplex } from "../cqlTypes";
import { CassValue, KeyBadge } from "./CassValue";

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
    <div className="cass-grid-wrap">
      <table className="cass-grid">
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
