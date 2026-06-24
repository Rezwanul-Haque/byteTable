// SchemaEditCanvas — the HTML overlay that schema-map edit mode renders in
// place of the read-mode SVG (Schema_Visual_Edit.md Views 4–5).
//
// Deliberate divergence from the read-mode renderer: read mode is SVG-native
// (so it exports to PNG/SVG), but edit mode needs native form controls — type
// <select>s, name <input>s, toggles, draggable FK ports — which are painful in
// pure SVG. So edit mode renders absolutely-positioned HTML cards (the
// prototype's substrate) over an SVG edge layer, all inside one `scale(zoom)`
// wrapper. Card positions live in the host (world coords); pointer deltas are
// divided by zoom. Navigation is by scrolling the canvas (no pan in edit mode).

import { useRef, useState } from "react";

import { Icon } from "../../../shared/ui/Icon";
import type { EditCol, EditSchema } from "../editModel";
import type { SchemaEditor, XY } from "../useSchemaEditor";

const CARD_W = 340;
const HEAD_H = 36;
const ROW_H = 30;

type Positions = Record<string, XY>;

/** Edit-mode card height: header + every column row + bottom pad. */
function cardHeight(meta: EditSchema["meta"][string]): number {
  return HEAD_H + meta.columns.length * ROW_H + 8;
}

/** Resolve every FK in the editable schema to an edge, tagging same-target
 *  edges with their stagger index so parallel curves fan out. */
function buildEditEdges(schema: EditSchema): EditEdge[] {
  const out: EditEdge[] = [];
  for (const table of schema.order) {
    const meta = schema.meta[table];
    if (!meta) continue;
    for (const fk of meta.foreignKeys) {
      const refMeta = schema.meta[fk.refTable];
      if (!refMeta) continue;
      const colIdx = meta.columns.findIndex((c) => c.name === fk.columns[0]);
      const toColIdx = refMeta.columns.findIndex((c) => c.name === fk.refColumns[0]);
      out.push({
        from: table,
        to: fk.refTable,
        colIdx: Math.max(0, colIdx),
        toColIdx: Math.max(0, toColIdx),
        name: fk.name,
        fk,
        inIdx: 0,
        inCount: 1,
      });
    }
  }
  const byTarget: Record<string, EditEdge[]> = {};
  out.forEach((e) => {
    (byTarget[e.to] = byTarget[e.to] || []).push(e);
  });
  Object.values(byTarget).forEach((list) => {
    list.forEach((e, i) => {
      e.inIdx = i;
      e.inCount = list.length;
    });
  });
  return out;
}

/** One resolved FK edge for the edit canvas. */
interface EditEdge {
  from: string;
  to: string;
  colIdx: number;
  toColIdx: number;
  name: string;
  fk: EditSchema["meta"][string]["foreignKeys"][number];
  inIdx: number;
  inCount: number;
}

/** Inline-editable text: double-click to edit, Enter/blur commits, Esc cancels.
 *  Used for table + column names. */
function MapEditText({
  value,
  onCommit,
  className,
  title,
}: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  title?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing) {
    const commit = () => {
      setEditing(false);
      onCommit(draft);
    };
    return (
      <input
        className="map-edit-input"
        autoFocus
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <span
      className={className}
      title={title || "Double-click to rename"}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}

export function SchemaEditCanvas({
  editor,
  positions,
  setPositions,
  zoom,
  wrapRef,
}: {
  editor: SchemaEditor;
  positions: Positions;
  setPositions: (fn: (p: Positions | null) => Positions | null) => void;
  zoom: number;
  wrapRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { schema, editTypes, armedDrop, arm, disarm } = editor;
  const [fkDrag, setFkDrag] = useState<string | null>(null);
  const dragRef = useRef<{ table: string; ox: number; oy: number; x: number; y: number } | null>(
    null,
  );
  const fkRef = useRef<{ fromT: string; fromCol: string } | null>(null);

  const names = schema.order.filter((n) => schema.meta[n] && positions[n]);

  // Edges from FK metadata, with same-target stagger so parallel curves fan
  // out. Recomputed every render (the editable schema mutates in place; the
  // table count is small, so memoising buys nothing).
  const edges = buildEditEdges(schema);

  // Canvas extent (world coords) for sizing the scroll area.
  let maxX = 0;
  let maxY = 0;
  for (const n of names) {
    const p = positions[n];
    const meta = schema.meta[n];
    if (!p || !meta) continue;
    maxX = Math.max(maxX, p.x + CARD_W);
    maxY = Math.max(maxY, p.y + cardHeight(meta));
  }

  // --- card drag (header) ---------------------------------------------
  const onCardMouseDown = (e: React.MouseEvent, table: string) => {
    if (e.button !== 0) return;
    const origin = positions[table];
    if (!origin) return;
    e.preventDefault();
    dragRef.current = {
      table,
      ox: origin.x,
      oy: origin.y,
      x: e.clientX,
      y: e.clientY,
    };
    const onMove = (me: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPositions((p) =>
        p
          ? {
              ...p,
              [d.table]: {
                x: Math.max(0, d.ox + (me.clientX - d.x) / zoom),
                y: Math.max(0, d.oy + (me.clientY - d.y) / zoom),
              },
            }
          : p,
      );
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // --- FK port drag → connect to another table's column row -----------
  const worldPoint = (cx: number, cy: number): XY => {
    const wrap = wrapRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const r = wrap.getBoundingClientRect();
    return {
      x: (cx - r.left + wrap.scrollLeft) / zoom,
      y: (cy - r.top + wrap.scrollTop) / zoom,
    };
  };
  const onPortDown = (e: React.MouseEvent, table: string, col: EditCol, ci: number) => {
    e.stopPropagation();
    e.preventDefault();
    const src = positions[table];
    if (!src) return;
    const sx = src.x + CARD_W;
    const sy = src.y + HEAD_H + ci * ROW_H + ROW_H / 2;
    fkRef.current = { fromT: table, fromCol: col.name };
    const onMove = (me: MouseEvent) => {
      const w = worldPoint(me.clientX, me.clientY);
      const dx = Math.max(40, Math.abs(w.x - sx) / 2);
      setFkDrag(`M ${sx} ${sy} C ${sx + dx} ${sy}, ${w.x - dx} ${w.y}, ${w.x} ${w.y}`);
    };
    const onUp = (me: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setFkDrag(null);
      const el = document.elementFromPoint(me.clientX, me.clientY);
      const row = el && "closest" in el ? (el as Element).closest(".map-card-col") : null;
      const d = fkRef.current;
      fkRef.current = null;
      if (row && d) {
        const tt = row.getAttribute("data-table");
        const tc = row.getAttribute("data-col");
        if (tt && tc && tt !== d.fromT) editor.addForeignKey(d.fromT, d.fromCol, tt, tc);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const edgePath = (e: EditEdge) => {
    const a = positions[e.from];
    const b = positions[e.to];
    if (!a || !b) return null;
    const sy = a.y + HEAD_H + e.colIdx * ROW_H + ROW_H / 2;
    const stagger = e.inCount > 1 ? (e.inIdx - (e.inCount - 1) / 2) * 12 : 0;
    const ty = b.y + HEAD_H + e.toColIdx * ROW_H + ROW_H / 2 + stagger;
    const aRight = a.x + CARD_W;
    let sx: number;
    let tx: number;
    if (b.x > aRight + 20) {
      sx = aRight;
      tx = b.x;
    } else if (a.x > b.x + CARD_W + 20) {
      sx = a.x;
      tx = b.x + CARD_W;
    } else {
      sx = aRight;
      tx = b.x + CARD_W;
    }
    const dx = Math.max(40, Math.abs(tx - sx) / 2);
    const c1 = sx + (tx >= sx ? dx : -dx);
    const c2 = tx + (tx >= sx ? -dx : dx);
    return { d: `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ty}, ${tx} ${ty}`, sx, sy, tx, ty };
  };

  return (
    <div className="map-canvas" style={{ width: (maxX + 100) * zoom, height: (maxY + 100) * zoom }}>
      <div
        className="map-inner"
        style={{ transform: `scale(${zoom})`, width: maxX + 100, height: maxY + 100 }}
      >
        <svg className="map-edges" width={maxX + 100} height={maxY + 100}>
          {edges.map((e) => {
            const p = edgePath(e);
            if (!p) return null;
            return (
              <g key={e.from + "." + e.name} className="map-edge-g">
                <path d={p.d} className="map-edge-path" />
                <circle cx={p.sx} cy={p.sy} r={3.5} className="map-edge-dot" />
                <circle cx={p.tx} cy={p.ty} r={5} className="map-edge-arrow" />
                <circle cx={p.tx} cy={p.ty} r={2} className="map-edge-dot" />
                <foreignObject
                  x={(p.sx + p.tx) / 2 - 9}
                  y={(p.sy + p.ty) / 2 - 9}
                  width={18}
                  height={18}
                >
                  <button
                    type="button"
                    className="map-fk-del"
                    title={"Drop " + e.name}
                    onClick={() => editor.dropForeignKey(e.from, e.name)}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </foreignObject>
              </g>
            );
          })}
          {fkDrag ? <path d={fkDrag} className="map-edge-path pending" /> : null}
        </svg>

        {names.map((n) => {
          const meta = schema.meta[n];
          const p = positions[n];
          if (!meta || !p) return null;
          return (
            <div key={n} className="map-card" style={{ left: p.x, top: p.y, width: CARD_W }}>
              <div className="map-card-head" onMouseDown={(e) => onCardMouseDown(e, n)}>
                <Icon name="table" size={14} style={{ color: "var(--accent)" }} />
                <MapEditText
                  value={n}
                  className="map-card-name"
                  onCommit={(v) => editor.renameTable(n, v)}
                  title="Double-click to rename table"
                />
                <span className="map-card-count">{meta.columns.length}</span>
                <button
                  type="button"
                  className="map-card-act"
                  title="Add column"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => editor.addColumn(n)}
                >
                  <Icon name="add" size={14} />
                </button>
                <button
                  type="button"
                  className={"map-card-act danger" + (armedDrop === "tbl:" + n ? " armed" : "")}
                  title={armedDrop === "tbl:" + n ? "Click again to drop table" : "Drop table " + n}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    const id = "tbl:" + n;
                    if (armedDrop === id) {
                      disarm();
                      editor.dropTable(n);
                    } else arm(id);
                  }}
                >
                  <Icon name={armedDrop === "tbl:" + n ? "delete_forever" : "delete"} size={13} />
                </button>
              </div>
              <div className="map-card-cols">
                {meta.columns.map((c, ci) => {
                  const colDropId = "col:" + n + "." + c.name;
                  const typeInList = editTypes.includes(c.type);
                  return (
                    <div
                      key={c.name}
                      className="map-card-col editable"
                      style={{ height: ROW_H }}
                      data-table={n}
                      data-col={c.name}
                    >
                      <span className="map-col-icon">
                        <button
                          type="button"
                          className={"map-pk-btn" + (c.pk ? " on" : "")}
                          title={c.pk ? "Primary key — click to remove" : "Set as primary key"}
                          onClick={() => editor.togglePk(n, c.name)}
                        >
                          <Icon name="key" size={11} style={{ transform: "rotate(45deg)" }} />
                        </button>
                      </span>
                      <MapEditText
                        value={c.name}
                        className={"map-col-name" + (c.fk ? " is-fk" : "")}
                        onCommit={(v) => editor.renameColumn(n, c.name, v)}
                      />
                      <select
                        className="map-type-sel"
                        value={typeInList ? c.type : ""}
                        onChange={(e) => editor.changeType(n, c.name, e.target.value)}
                        onMouseDown={(e) => e.stopPropagation()}
                        title="Column type"
                      >
                        {!typeInList ? <option value="">{c.type.toLowerCase()}</option> : null}
                        {editTypes.map((t) => (
                          <option key={t} value={t}>
                            {t.toLowerCase()}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className={"map-null-btn" + (c.nullable ? "" : " notnull")}
                        title={
                          c.nullable
                            ? "Nullable — click for NOT NULL"
                            : "NOT NULL — click to allow null"
                        }
                        onClick={() => editor.toggleNullable(n, c.name)}
                        disabled={c.pk}
                      >
                        {c.nullable ? "NULL" : "NN"}
                      </button>
                      <button
                        type="button"
                        className={"map-col-drop" + (armedDrop === colDropId ? " armed" : "")}
                        title={
                          armedDrop === colDropId
                            ? "Click again to drop column"
                            : "Drop column " + c.name
                        }
                        onClick={() => {
                          if (armedDrop === colDropId) {
                            disarm();
                            editor.dropColumn(n, c.name);
                          } else arm(colDropId);
                        }}
                      >
                        <Icon
                          name={armedDrop === colDropId ? "delete_forever" : "close"}
                          size={12}
                        />
                      </button>
                      <span
                        className="map-fk-port"
                        title="Drag to another column to add a foreign key"
                        onMouseDown={(e) => onPortDown(e, n, c, ci)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
