// Cassandra schema map (M19 §19.7, ported from cassandra-map.jsx): one card per
// query table with its columns + key badges, and denormalization edges between
// tables that share a key column. The prototype derived edges from a hand-authored
// `references` catalog; a live cluster has none, so edges are derived from shared
// partition/clustering key columns — the real denormalization signal in a
// query-first model (e.g. every `*_by_user` table shares `user_id`). Draggable
// cards, pan + zoom. Reuses the shared .schema-map / .map-* chrome.

import { useEffect, useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { useToast } from "../../../../shared/ui/toastContext";
import {
  exportCardMap,
  type ExportFormat,
  type ExportMapRow,
} from "../../../schema_map/cardMapExport";
import type { TableDescriptor } from "../api";
import { cqlColor } from "../cqlTypes";
// Dedicated, self-contained map CSS (scoped under `.cass-map`) — independent of
// the Mongo/SQL/Dynamo maps so their CSS can change without breaking this one.
import "./CassandraMap.css";

const CARD_W = 248;
const HEAD_H = 36;
const ROW_H = 21;
const MAX_COLS = 9;
const PALETTE = ["#61afef", "#e5a458", "#98c379", "#b08cff", "#56b6c2", "#e2b340"];

interface Edge {
  from: string;
  to: string;
  key: string;
  color: string;
}

function buildEdges(tables: TableDescriptor[]): Edge[] {
  const byKey: Record<string, string[]> = {};
  tables.forEach((t) => {
    [...t.partitionKey, ...t.clustering.map((c) => c.name)].forEach((k) => {
      (byKey[k] ??= []).push(t.name);
    });
  });
  const edges: Edge[] = [];
  let ci = 0;
  Object.entries(byKey).forEach(([key, ids]) => {
    if (ids.length < 2) return;
    const color = PALETTE[ci++ % PALETTE.length] ?? "#61afef";
    for (let i = 1; i < ids.length; i++)
      edges.push({ from: ids[0] ?? "", to: ids[i] ?? "", key, color });
  });
  return edges;
}

function cardHeight(t: TableDescriptor): number {
  const shown = Math.min(t.columns.length, MAX_COLS);
  const more = t.columns.length > MAX_COLS ? 1 : 0;
  return HEAD_H + 8 + (shown + more) * ROW_H;
}

interface CassandraSchemaMapProps {
  ks: string;
  tables: TableDescriptor[];
  onOpenTable: (name: string) => void;
}

export function CassandraSchemaMap({ ks, tables, onOpenTable }: CassandraSchemaMapProps) {
  const edges = useMemo(() => buildEdges(tables), [tables]);
  const byId = useMemo(() => {
    const m: Record<string, TableDescriptor> = {};
    tables.forEach((t) => (m[t.name] = t));
    return m;
  }, [tables]);

  const initPos = () => {
    const p: Record<string, { x: number; y: number }> = {};
    tables.forEach((t, i) => {
      p[t.name] = { x: 70 + (i % 3) * 380, y: 70 + Math.floor(i / 3) * 360 };
    });
    return p;
  };
  const [positions, setPositions] = useState(initPos);
  const [zoom, setZoom] = useState(1);
  const toast = useToast();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Seed default positions for any table missing one. Critical when the map tab
  // is the active tab on (re)mount and `tables` is still empty (refetching) — the
  // `useState(initPos)` ran with no tables, so without this every card would fall
  // back to (0,0) and pile up once the tables arrive.
  useEffect(() => {
    setPositions((prev) => {
      let changed = false;
      const next = { ...prev };
      tables.forEach((t, i) => {
        if (!next[t.name]) {
          next[t.name] = { x: 70 + (i % 3) * 380, y: 70 + Math.floor(i / 3) * 360 };
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [tables]);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const close = () => setExportMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [exportMenuOpen]);
  const dragRef = useRef<{
    id: string;
    start: { x: number; y: number; ox: number; oy: number };
  } | null>(null);

  const pos = (id: string) => positions[id] ?? { x: 0, y: 0 };

  const onHeadDown = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = pos(id);
    dragRef.current = { id, start: { x: e.clientX, y: e.clientY, ox: p.x, oy: p.y } };
    const onMove = (me: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPositions((prev) => ({
        ...prev,
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

  let maxX = 0;
  let maxY = 0;
  tables.forEach((t) => {
    const p = pos(t.name);
    maxX = Math.max(maxX, p.x + CARD_W);
    maxY = Math.max(maxY, p.y + cardHeight(t));
  });

  const colRowIndex = (t: TableDescriptor, key: string) => {
    const idx = t.columns.findIndex((f) => f.name === key);
    return idx < 0 ? 0 : Math.min(idx, MAX_COLS);
  };
  const rowY = (id: string, rowIdx: number) => pos(id).y + HEAD_H + rowIdx * ROW_H + ROW_H / 2;
  const edgePath = (fromId: string, toId: string, fromRow: number, toRow: number) => {
    const a = pos(fromId);
    const b = pos(toId);
    const ay = rowY(fromId, fromRow);
    const by = rowY(toId, toRow);
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
    return {
      d: `M ${sx} ${ay} C ${c1} ${ay}, ${c2} ${by}, ${tx} ${by}`,
      sx,
      sy: ay,
      tx,
      ty: by,
      mx: (sx + tx) / 2,
      my: (ay + by) / 2,
    };
  };

  // Export the map to PNG / SVG via the shared card-map exporter.
  const runExport = async (format: ExportFormat) => {
    setExportMenuOpen(false);
    setExporting(true);
    try {
      const cards = tables.map((t) => {
        const p = pos(t.name);
        const extra = t.columns.length - MAX_COLS;
        const rows: ExportMapRow[] = t.columns.slice(0, MAX_COLS).map((c) => ({
          name: c.name,
          type: c.type,
          typeColor: cqlColor(c.type),
        }));
        if (extra > 0) {
          rows.push({ name: `+ ${extra} more column${extra > 1 ? "s" : ""}…`, muted: true });
        }
        return { x: p.x, y: p.y, w: CARD_W, name: t.name, rows };
      });
      const exportEdges = edges
        .map((e) => {
          const fc = byId[e.from];
          const tc = byId[e.to];
          if (!fc || !tc) return null;
          const p = edgePath(e.from, e.to, colRowIndex(fc, e.key), colRowIndex(tc, e.key));
          return { d: p.d, dashed: true };
        })
        .filter((e): e is { d: string; dashed: boolean } => e !== null);

      const res = await exportCardMap({
        cards,
        edges: exportEdges,
        fileBase: `${ks}-schema-map`,
        format,
      });
      if (res.status === "ok") toast(`Exported schema map to ${res.file}`, "ok");
      else if (res.status === "empty") toast("Nothing to export yet.", "info");
      else if (res.status === "no-dialog")
        toast("Exporting requires the ByteTable desktop app.", "info");
    } catch (e) {
      toast(appErrorMessage(e, "Could not export the schema map."), "err");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="schema-map cass-map" data-screen-label="Cassandra schema map">
      <div className="map-toolbar">
        <Icon name="schema" size={16} style={{ color: "var(--accent)" }} />
        <span className="map-title">{ks} · query-table map</span>
        <span className="map-sub">
          {tables.length} tables · {edges.length} denormalization links
        </span>
        <div style={{ flex: 1 }} />
        <span className="map-hint">
          edges link tables sharing a key column (query-first denormalization)
        </span>
        <IconBtn
          icon="zoom_out"
          title="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
        />
        <span className="map-zoom">{Math.round(zoom * 100)}%</span>
        <IconBtn
          icon="zoom_in"
          title="Zoom in"
          onClick={() => setZoom((z) => Math.min(1.5, Math.round((z + 0.1) * 10) / 10))}
        />
        <IconBtn
          icon="fit_screen"
          title="Reset layout"
          onClick={() => {
            setPositions(initPos());
            setZoom(1);
          }}
        />
        <div style={{ position: "relative" }}>
          <IconBtn
            icon="download"
            title="Export schema map"
            active={exportMenuOpen}
            disabled={exporting}
            onClick={(e) => {
              e.stopPropagation();
              setExportMenuOpen((o) => !o);
            }}
          />
          {exportMenuOpen ? (
            <div
              className="ctx-menu"
              style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 1000 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ctx-item" onClick={() => void runExport("png")}>
                <Icon name="image" size={15} /> PNG image
              </div>
              <div className="ctx-item" onClick={() => void runExport("svg")}>
                <Icon name="shape_line" size={15} /> SVG vector
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="map-canvas-wrap">
        <div
          className="map-canvas"
          style={{ width: (maxX + 120) * zoom, height: (maxY + 120) * zoom }}
        >
          <div
            className="map-inner"
            style={{ transform: "scale(" + zoom + ")", width: maxX + 120, height: maxY + 120 }}
          >
            <svg className="map-edges" width={maxX + 120} height={maxY + 120}>
              {edges.map((e, i) => {
                const fc = byId[e.from];
                const tc = byId[e.to];
                if (!fc || !tc) return null;
                const p = edgePath(e.from, e.to, colRowIndex(fc, e.key), colRowIndex(tc, e.key));
                return (
                  <g key={"e" + i}>
                    <path d={p.d} className="map-edge-path ref" style={{ stroke: e.color }} />
                    <circle
                      cx={p.sx}
                      cy={p.sy}
                      r="3"
                      className="map-edge-dot ref"
                      style={{ fill: e.color }}
                    />
                    <circle
                      cx={p.tx}
                      cy={p.ty}
                      r="4.5"
                      className="map-edge-arrow ref"
                      style={{ fill: e.color }}
                    />
                    <foreignObject x={p.mx - 34} y={p.my - 11} width="68" height="20">
                      <div
                        className="cass-edge-tag"
                        style={{ borderColor: e.color + "88", color: e.color }}
                      >
                        {e.key}
                      </div>
                    </foreignObject>
                  </g>
                );
              })}
            </svg>
            {tables.map((t) => {
              const p = pos(t.name);
              const extra = t.columns.length - MAX_COLS;
              return (
                <div
                  key={t.name}
                  className="map-card"
                  style={{ left: p.x, top: p.y, width: CARD_W }}
                >
                  <div className="map-card-head" onMouseDown={(ev) => onHeadDown(ev, t.name)}>
                    <Icon name="table_chart" size={14} style={{ color: "var(--accent)" }} />
                    <span className="map-card-name">{t.name}</span>
                    <button
                      className="map-card-open"
                      title={"Open " + t.name}
                      onMouseDown={(ev) => ev.stopPropagation()}
                      onClick={() => onOpenTable(t.name)}
                    >
                      <Icon name="open_in_new" size={13} />
                    </button>
                  </div>
                  <div className="map-card-cols">
                    {t.columns.slice(0, MAX_COLS).map((f) => (
                      <div key={f.name} className="map-card-col" style={{ height: ROW_H }}>
                        <span className="map-col-icon">
                          {f.kind === "partition_key" ? (
                            <span className="cass-kbadge pk sm">PK</span>
                          ) : f.kind === "clustering" ? (
                            <span className="cass-kbadge ck sm">CK</span>
                          ) : f.kind === "static" ? (
                            <span className="cass-kbadge st sm">ST</span>
                          ) : null}
                        </span>
                        <span
                          className={
                            "map-col-name" +
                            (f.kind === "partition_key" || f.kind === "clustering" ? " is-fk" : "")
                          }
                        >
                          {f.name}
                        </span>
                        <span className="map-col-type" style={{ color: cqlColor(f.type) }}>
                          {f.type}
                        </span>
                      </div>
                    ))}
                    {extra > 0 ? (
                      <div className="map-card-col map-col-more" style={{ height: ROW_H }}>
                        <span className="map-col-icon" />
                        <span className="map-col-name">
                          + {extra} more column{extra > 1 ? "s" : ""}…
                        </span>
                      </div>
                    ) : null}
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
