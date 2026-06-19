// DynamoDB single-table-design schema map (M17 §17.5): entity-type cards
// derived from sampled item data, item-collection edges (shared partition =
// 1:N), and cross-table reference edges, with draggable cards + pan/zoom.
// Items are sampled via a bounded scan per table (never a full table load).
// Ported from `DynamoSchemaMap` in `dynamo-map.jsx`.

import { useEffect, useMemo, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { dynamoScan, type DynamoItem, type TableDescriptor } from "../api";
import { buildDynamoModel, type DynamoEntity, type DynamoModel } from "../helpers";

const CARD_W = 248;
const HEAD_H = 36;
const ROW_H = 21;
const MAX_ATTRS = 7;
const SAMPLE_LIMIT = 200;

interface DynamoSchemaMapProps {
  handleId: string;
  tables: TableDescriptor[];
  onOpenTable: (name: string) => void;
}

function cardHeight(e: DynamoEntity): number {
  const attrsShown = Math.min(e.attrs.length, MAX_ATTRS);
  const more = e.attrs.length > MAX_ATTRS ? 1 : 0;
  const rows = 2 + attrsShown + more + e.gsis.length;
  return HEAD_H + 8 + rows * ROW_H;
}

export function DynamoSchemaMap({ handleId, tables, onOpenTable }: DynamoSchemaMapProps) {
  const [model, setModel] = useState<DynamoModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [zoom, setZoom] = useState(1);
  const dragRef = useRef<{
    id: string;
    start: { x: number; y: number; ox: number; oy: number };
  } | null>(null);

  // Sample items per table (bounded), then build the model once.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const sampled = await Promise.all(
          tables.map(async (t) => {
            let items: DynamoItem[] = [];
            try {
              const page = await dynamoScan(handleId, t.name, { limit: SAMPLE_LIMIT });
              items = page.items;
            } catch {
              items = [];
            }
            return { descriptor: t, items };
          }),
        );
        if (!alive) return;
        const m = buildDynamoModel(sampled);
        setModel(m);
        // Seed initial positions in a grid.
        const p: Record<string, { x: number; y: number }> = {};
        m.entities.forEach((e, i) => {
          p[e.id] = { x: 70 + (i % 3) * 400, y: 80 + Math.floor(i / 3) * 380 };
        });
        setPositions(p);
      } catch (e) {
        if (alive) setError(isAppErrorPayload(e) ? e.message : "Could not build the schema map");
      }
    })();
    return () => {
      alive = false;
    };
  }, [handleId, tables]);

  const byId = useMemo(() => {
    const m: Record<string, DynamoEntity> = {};
    model?.entities.forEach((e) => {
      m[e.id] = e;
    });
    return m;
  }, [model]);

  const onHeadDown = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = positions[id];
    if (!pos) return;
    dragRef.current = { id, start: { x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y } };
    const onMove = (me: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPositions((p) => ({
        ...p,
        [d.id]: {
          x: Math.max(0, d.start.ox + (me.clientX - d.start.x) / zoom),
          y: Math.max(0, d.start.oy + (me.clientY - d.start.y) / zoom),
        },
      }));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (error) {
    return (
      <div className="ddb-tab-error">
        <Icon name="error" size={16} /> {error}
      </div>
    );
  }
  if (!model) {
    return <div className="ddb-dash-empty">Building schema map…</div>;
  }

  const { entities, rels, refs } = model;
  let maxX = 0;
  let maxY = 0;
  entities.forEach((e) => {
    const p = positions[e.id];
    if (!p) return;
    maxX = Math.max(maxX, p.x + CARD_W);
    maxY = Math.max(maxY, p.y + cardHeight(e));
  });

  const edgePath = (from: string, to: string) => {
    const a = positions[from];
    const b = positions[to];
    if (!a || !b) return null;
    const ay = a.y + HEAD_H + ROW_H / 2;
    const by = b.y + HEAD_H + ROW_H / 2;
    const aR = a.x + CARD_W;
    const bR = b.x + CARD_W;
    let sx: number;
    let tx: number;
    if (b.x > aR - 20) {
      sx = aR;
      tx = b.x;
    } else if (a.x > bR - 20) {
      sx = a.x;
      tx = bR;
    } else {
      sx = aR;
      tx = bR;
    }
    const dx = Math.max(40, Math.abs(tx - sx) / 2);
    const c1 = sx + (tx >= sx ? dx : -dx);
    const c2 = tx + (tx >= sx ? -dx : dx);
    return { d: `M ${sx} ${ay} C ${c1} ${ay}, ${c2} ${by}, ${tx} ${by}`, sx, sy: ay, tx, ty: by };
  };

  const resetLayout = () => {
    const p: Record<string, { x: number; y: number }> = {};
    entities.forEach((e, i) => {
      p[e.id] = { x: 70 + (i % 3) * 400, y: 80 + Math.floor(i / 3) * 380 };
    });
    setPositions(p);
    setZoom(1);
  };

  return (
    <div className="ddb-schema-map">
      <div className="ddb-map-toolbar">
        <Icon name="hub" size={16} style={{ color: "var(--accent)" }} />
        <span className="ddb-map-title">single-table design map</span>
        <span className="ddb-map-sub">
          {entities.length} entities · {rels.length} item collections · {refs.length} references
        </span>
        <div style={{ flex: 1 }} />
        <span className="ddb-map-hint">drag entities to rearrange</span>
        <IconBtn
          icon="zoom_out"
          title="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
        />
        <span className="ddb-map-zoom">{Math.round(zoom * 100)}%</span>
        <IconBtn
          icon="zoom_in"
          title="Zoom in"
          onClick={() => setZoom((z) => Math.min(1.5, Math.round((z + 0.1) * 10) / 10))}
        />
        <IconBtn icon="fit_screen" title="Reset layout" onClick={resetLayout} />
      </div>
      <div className="ddb-map-canvas-wrap">
        <div
          className="ddb-map-canvas"
          style={{ width: (maxX + 120) * zoom, height: (maxY + 120) * zoom }}
        >
          <div
            className="ddb-map-inner"
            style={{ transform: "scale(" + zoom + ")", width: maxX + 120, height: maxY + 120 }}
          >
            <svg className="ddb-map-edges" width={maxX + 120} height={maxY + 120}>
              {refs.map((r, i) => {
                const p = edgePath(r.from, r.to);
                if (!p) return null;
                return (
                  <g key={"ref" + i}>
                    <path d={p.d} className="ddb-map-edge-path ref" />
                    <circle cx={p.sx} cy={p.sy} r="3" className="ddb-map-edge-dot ref" />
                    <circle cx={p.tx} cy={p.ty} r="4.5" className="ddb-map-edge-arrow ref" />
                  </g>
                );
              })}
              {rels.map((r, i) => {
                const p = edgePath(r.from, r.to);
                if (!p) return null;
                return (
                  <g key={"rel" + i}>
                    <path d={p.d} className="ddb-map-edge-path" />
                    <circle cx={p.sx} cy={p.sy} r="3.5" className="ddb-map-edge-dot" />
                    <circle cx={p.tx} cy={p.ty} r="5" className="ddb-map-edge-arrow" />
                  </g>
                );
              })}
            </svg>
            {entities.map((e) => {
              const p = positions[e.id];
              if (!p) return null;
              const extra = e.attrs.length - MAX_ATTRS;
              void byId;
              return (
                <div
                  key={e.id}
                  className="ddb-map-card"
                  style={{ left: p.x, top: p.y, width: CARD_W }}
                >
                  <div className="ddb-map-card-head" onMouseDown={(ev) => onHeadDown(ev, e.id)}>
                    <Icon
                      name={e.single ? "table" : "category"}
                      size={14}
                      style={{ color: "var(--accent)" }}
                    />
                    <span className="ddb-map-card-name">{e.name}</span>
                    {e.single ? null : <span className="ddb-map-card-sub">{e.table}</span>}
                    <span className="ddb-map-card-count">{e.count}</span>
                    <button
                      type="button"
                      className="ddb-map-card-open"
                      title={"Open " + e.table}
                      onMouseDown={(ev) => ev.stopPropagation()}
                      onClick={() => onOpenTable(e.table)}
                    >
                      <Icon name="open_in_new" size={13} />
                    </button>
                  </div>
                  <div className="ddb-map-card-cols">
                    <div className="ddb-map-card-col" style={{ height: ROW_H }}>
                      <span className="ddb-map-col-icon">
                        <Icon
                          name="key"
                          size={11}
                          style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
                        />
                      </span>
                      <span className="ddb-map-col-name is-fk">{e.pkN}</span>
                      <span className="ddb-map-col-tag pk">PK</span>
                      <span className="ddb-map-col-type accent">{e.pkPattern}</span>
                    </div>
                    {e.skN ? (
                      <div className="ddb-map-card-col" style={{ height: ROW_H }}>
                        <span className="ddb-map-col-icon">
                          <Icon
                            name="key"
                            size={11}
                            style={{ color: "var(--text-dim)", transform: "rotate(45deg)" }}
                          />
                        </span>
                        <span className="ddb-map-col-name is-fk">{e.skN}</span>
                        <span className="ddb-map-col-tag sk">SK</span>
                        <span className="ddb-map-col-type accent">{e.skPattern}</span>
                      </div>
                    ) : (
                      <div className="ddb-map-card-col" style={{ height: ROW_H }}>
                        <span className="ddb-map-col-icon" />
                        <span className="ddb-map-col-name dim">partition-only</span>
                      </div>
                    )}
                    {e.attrs.slice(0, MAX_ATTRS).map((a) => (
                      <div key={a} className="ddb-map-card-col" style={{ height: ROW_H }}>
                        <span className="ddb-map-col-icon" />
                        <span className="ddb-map-col-name">{a}</span>
                        <span className="ddb-map-col-type">{e.attrTypes[a]}</span>
                      </div>
                    ))}
                    {extra > 0 ? (
                      <div className="ddb-map-card-col ddb-map-col-more" style={{ height: ROW_H }}>
                        <span className="ddb-map-col-icon" />
                        <span className="ddb-map-col-name">
                          + {extra} more attribute{extra > 1 ? "s" : ""}…
                        </span>
                      </div>
                    ) : null}
                    {e.gsis.map((g) => (
                      <div key={g.name} className="ddb-map-card-col gsi" style={{ height: ROW_H }}>
                        <span className="ddb-map-col-icon">
                          <Icon name="link" size={11} style={{ color: "var(--text-faint)" }} />
                        </span>
                        <span className="ddb-map-col-name">{g.name}</span>
                        <span className="ddb-map-col-tag gsi">GSI</span>
                        <span className="ddb-map-col-type">
                          {g.pkPattern}
                          {g.skPattern ? " / " + g.skPattern : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
