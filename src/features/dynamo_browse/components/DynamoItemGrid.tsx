// The schemaless DynamoDB item grid (M17 §17.2): attribute-union columns with
// keys first, nested maps/lists shown compactly (click any row to open the item
// editor). Ported from the prototype's `DynamoItemGrid` in `dynamo.jsx`.
//
// Optional multi-select: when `onToggleRow` is supplied a checkbox column is
// shown (header = select-all, tri-state) so the parent can offer bulk actions
// (delete selected, export selected to CSV).

import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import type { DynamoItem, KeySchema } from "../api";
import { attributeUnion, dynamoFmt } from "../helpers";

/** The raw, copyable text of a cell value (objects → JSON, null → empty). */
function copyText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

interface DynamoItemGridProps {
  items: DynamoItem[];
  keySchema: KeySchema;
  onOpenItem?: (item: DynamoItem) => void;
  /** Row indices currently selected. Presence of `onToggleRow` enables the
   *  checkbox column. */
  selected?: Set<number>;
  onToggleRow?: (index: number) => void;
  onToggleAll?: () => void;
}

export function DynamoItemGrid({
  items,
  keySchema,
  onOpenItem,
  selected,
  onToggleRow,
  onToggleAll,
}: DynamoItemGridProps) {
  const toast = useToast();
  const copy = (v: unknown) =>
    void navigator.clipboard.writeText(copyText(v)).then(
      () => toast("Copied to clipboard", "ok"),
      () => toast("Couldn't copy to clipboard", "err"),
    );

  const cols = attributeUnion(items);
  // Keys first, then the remaining attributes in first-seen order. Keys are only
  // shown when actually present in the returned items — a projection that omits
  // PK/SK must not render empty key columns.
  const ordered = [keySchema.pk, keySchema.sk]
    .filter((c): c is string => !!c && cols.includes(c as string))
    .concat(cols.filter((c) => c !== keySchema.pk && c !== keySchema.sk));

  if (!items.length) return <div className="ddb-grid-empty">No items</div>;

  const selectable = !!onToggleRow;
  const sel = selected ?? new Set<number>();
  const allSelected = selectable && items.length > 0 && sel.size === items.length;
  const someSelected = selectable && sel.size > 0 && !allSelected;

  return (
    <div className="ddb-datagrid-wrap">
      <table className="ddb-datagrid">
        <thead>
          <tr>
            {selectable ? (
              <th className="ddb-dg-check-h">
                <input
                  type="checkbox"
                  className="ddb-dg-check"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={onToggleAll}
                  aria-label="Select all rows"
                />
              </th>
            ) : null}
            <th className="ddb-dg-rownum-h">#</th>
            {ordered.map((c) => (
              <th key={c}>
                <span className="ddb-dg-head">
                  {c === keySchema.pk ? (
                    <span className="ddb-key-badge pk">PK</span>
                  ) : c === keySchema.sk ? (
                    <span className="ddb-key-badge sk">SK</span>
                  ) : null}
                  <span className="ddb-dg-colname">{c}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((it, ri) => (
            <tr
              key={ri}
              className={"ddb-row" + (sel.has(ri) ? " selected" : "")}
              onClick={() => onOpenItem?.(it)}
              style={onOpenItem ? undefined : { cursor: "default" }}
            >
              {selectable ? (
                <td className="ddb-dg-check-c" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="ddb-dg-check"
                    checked={sel.has(ri)}
                    onChange={() => onToggleRow?.(ri)}
                    aria-label={`Select row ${ri + 1}`}
                  />
                </td>
              ) : null}
              <td className="ddb-dg-rownum">{ri + 1}</td>
              {ordered.map((c) => {
                const v = it[c];
                const disp = dynamoFmt(v);
                return (
                  <td key={c} title={typeof v === "object" && v !== null ? JSON.stringify(v) : ""}>
                    {disp === null ? (
                      <span className="ddb-cell-null">—</span>
                    ) : typeof v === "object" ? (
                      <span className="ddb-json-chip">
                        <Icon name="data_object" size={10} /> {disp}
                      </span>
                    ) : typeof v === "number" ? (
                      <span className="ddb-cell-num">{disp}</span>
                    ) : typeof v === "boolean" ? (
                      <span className={v ? "ddb-cell-true" : "ddb-cell-false"}>{disp}</span>
                    ) : (
                      <span className="ddb-cell-text">{disp}</span>
                    )}
                    {/* Hover copy — copies the raw value (off the row-open click). */}
                    <button
                      type="button"
                      className="ddb-cell-copy"
                      title="Copy value"
                      aria-label={"Copy " + c + " value"}
                      onClick={(e) => {
                        e.stopPropagation();
                        copy(v);
                      }}
                    >
                      <Icon name="content_copy" size={12} />
                    </button>
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
