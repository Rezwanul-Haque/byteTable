// The schemaless DynamoDB item grid (M17 §17.2): attribute-union columns with
// keys first, nested maps/lists shown compactly (click any row to open the item
// editor). Ported from the prototype's `DynamoItemGrid` in `dynamo.jsx`.

import { Icon } from "../../../shared/ui/Icon";
import type { DynamoItem, KeySchema } from "../api";
import { attributeUnion, dynamoFmt } from "../helpers";

interface DynamoItemGridProps {
  items: DynamoItem[];
  keySchema: KeySchema;
  onOpenItem?: (item: DynamoItem) => void;
}

export function DynamoItemGrid({ items, keySchema, onOpenItem }: DynamoItemGridProps) {
  const cols = attributeUnion(items);
  // Keys first, then the remaining attributes in first-seen order.
  const ordered = [keySchema.pk, keySchema.sk]
    .filter((c): c is string => Boolean(c))
    .concat(cols.filter((c) => c !== keySchema.pk && c !== keySchema.sk));

  if (!items.length) return <div className="ddb-grid-empty">No items</div>;

  return (
    <div className="ddb-datagrid-wrap">
      <table className="ddb-datagrid">
        <thead>
          <tr>
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
              className="ddb-row"
              onClick={() => onOpenItem?.(it)}
              style={onOpenItem ? undefined : { cursor: "default" }}
            >
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
