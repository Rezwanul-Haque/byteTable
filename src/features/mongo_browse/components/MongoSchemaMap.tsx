// MongoDB schema map (M18 §18.7): one card per collection with inferred field
// types, dashed reference edges (`<field>Id → collection`, incl. nested array
// paths like `items.productId`), draggable cards, pan + zoom. Ported from the
// prototype's MongoSchemaMap; references are inferred from the real introspected
// schema (no hardcoded graph) since the backend has no declared reference list.

import { useEffect, useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import {
  exportCardMap,
  type ExportFormat,
  type ExportMapRow,
} from "../../schema_map/cardMapExport";
import { mongoInferSchema, type CollectionDescriptor, type SchemaField } from "../api";
import { MONGO_TYPE_COLOR, type MongoType } from "../helpers";
import "./MongoMap.css";

const CARD_W = 240;
const HEAD_H = 36;
const ROW_H = 21;
const MAX_FIELDS = 8;

interface MapField {
  name: string;
  type: string;
  embedded: boolean;
}
interface MapColl {
  id: string;
  name: string;
  count: number;
  validated: boolean;
  fields: MapField[];
}
interface MapRef {
  from: string;
  to: string;
  field: string;
}

/** Infer reference edges from the schema: a field whose leaf name is `<x>Id`
 *  (not `_id`) points at the collection `<x>s` when one exists. Covers nested
 *  array paths (`items[].productId` → products). */
function inferReferences(schemas: Record<string, SchemaField[]>, names: string[]): MapRef[] {
  const present = new Set(names);
  const refs: MapRef[] = [];
  const seen = new Set<string>();
  for (const from of names) {
    for (const f of schemas[from] ?? []) {
      const leaf =
        f.path
          .split(/\.|\[\]/)
          .filter(Boolean)
          .pop() ?? "";
      const m = leaf.match(/^(.+)Id$/);
      if (!m || leaf === "_id") continue;
      const target = (m[1] ?? "").toLowerCase() + "s"; // user → users, product → products
      if (!present.has(target)) continue;
      const key = from + "·" + f.path + "·" + target;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ from, to: target, field: f.path });
    }
  }
  return refs;
}

function cardHeight(c: MapColl): number {
  const shown = Math.min(c.fields.length, MAX_FIELDS);
  const more = c.fields.length > MAX_FIELDS ? 1 : 0;
  return HEAD_H + 8 + (shown + more) * ROW_H;
}

export function MongoSchemaMap({
  handleId,
  db,
  collections,
  onOpenColl,
}: {
  handleId: string;
  db: string;
  collections: CollectionDescriptor[];
  onOpenColl: (coll: string) => void;
}) {
  const [schemas, setSchemas] = useState<Record<string, SchemaField[]> | null>(null);

  useEffect(() => {
    let live = true;
    const names = collections.map((c) => c.name);
    Promise.all(
      names.map((n) =>
        mongoInferSchema(handleId, db, n)
          .then((s) => [n, s] as const)
          .catch(() => [n, [] as SchemaField[]] as const),
      ),
    ).then((pairs) => {
      if (live) setSchemas(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [handleId, db, collections]);

  const model = useMemo(() => {
    if (!schemas) return { colls: [] as MapColl[], refs: [] as MapRef[] };
    const names = collections.map((c) => c.name);
    const colls: MapColl[] = collections.map((c) => {
      const top = (schemas[c.name] ?? []).filter((f) => f.depth === 0);
      return {
        id: c.name,
        name: c.name,
        count: c.count,
        validated: !!c.validator,
        fields: top.map((f) => {
          const type = f.types[0] ?? "string";
          return { name: f.path, type, embedded: type === "object" || type === "array" };
        }),
      };
    });
    return { colls, refs: inferReferences(schemas, names) };
  }, [schemas, collections]);

  const { colls, refs } = model;

  // Default grid position for a card by its index (used until the user drags it,
  // at which point the explicit position in `overrides` takes over).
  const defaultPos = (i: number) => ({ x: 70 + (i % 3) * 360, y: 70 + Math.floor(i / 3) * 360 });
  const indexOf: Record<string, number> = {};
  colls.forEach((c, i) => (indexOf[c.id] = i));
  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>({});
  const [zoom, setZoom] = useState(1);
  const dragRef = useRef<{
    id: string;
    start: { x: number; y: number; ox: number; oy: number };
  } | null>(null);
  const positions: Record<string, { x: number; y: number }> = {};
  colls.forEach((c, i) => (positions[c.id] = overrides[c.id] ?? defaultPos(i)));
  const setPositions = setOverrides;
  const initPos = () => setOverrides({});

  const toast = useToast();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    if (!exportMenuOpen) return;
    const close = () => setExportMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [exportMenuOpen]);

  if (!schemas) {
    return <div className="grid-empty">Building schema map…</div>;
  }

  const onHeadDown = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = positions[id] ?? { x: 0, y: 0 };
    const start = { x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y };
    dragRef.current = { id, start };
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

  let maxX = 0;
  let maxY = 0;
  colls.forEach((c) => {
    const p = positions[c.id];
    if (!p) return;
    maxX = Math.max(maxX, p.x + CARD_W);
    maxY = Math.max(maxY, p.y + cardHeight(c));
  });

  const byId: Record<string, MapColl> = {};
  colls.forEach((c) => (byId[c.id] = c));

  const fieldRowIndex = (c: MapColl, field: string) => {
    const base = field.split(".")[0];
    const idx = c.fields.findIndex((f) => f.name === base);
    return idx < 0 ? 0 : Math.min(idx, MAX_FIELDS);
  };
  const rowY = (id: string, rowIdx: number) =>
    (positions[id]?.y ?? 0) + HEAD_H + rowIdx * ROW_H + ROW_H / 2;
  const edgePath = (fromId: string, toId: string, fromRow: number) => {
    const a = positions[fromId];
    const b = positions[toId];
    if (!a || !b) return null;
    const ay = rowY(fromId, fromRow);
    const by = rowY(toId, 0);
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

  // --- export (PNG / SVG) ---------------------------------------------
  const runExport = async (format: ExportFormat) => {
    setExportMenuOpen(false);
    setExporting(true);
    try {
      const cards = colls.map((c) => {
        const p = positions[c.id] ?? { x: 0, y: 0 };
        const extra = c.fields.length - MAX_FIELDS;
        const rows: ExportMapRow[] = c.fields.slice(0, MAX_FIELDS).map((f) => ({
          name: f.name,
          type: f.type,
          typeColor: MONGO_TYPE_COLOR[f.type as MongoType],
        }));
        if (extra > 0) {
          rows.push({ name: `+ ${extra} more field${extra > 1 ? "s" : ""}…`, muted: true });
        }
        return { x: p.x, y: p.y, w: CARD_W, name: c.name, count: String(c.count), rows };
      });
      const edges = refs
        .map((r) => {
          const fc = byId[r.from];
          if (!fc) return null;
          const p = edgePath(r.from, r.to, fieldRowIndex(fc, r.field));
          return p ? { d: p.d, dashed: true } : null;
        })
        .filter((e): e is { d: string; dashed: boolean } => e !== null);

      const res = await exportCardMap({ cards, edges, fileBase: `${db}-schema-map`, format });
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
    <div className="schema-map mg-map" data-screen-label="MongoDB schema map">
      <div className="map-toolbar">
        <Icon name="hub" size={16} style={{ color: "var(--accent)" }} />
        <span className="map-title">{db} · collection map</span>
        <span className="map-sub">
          {colls.length} collections · {refs.length} references
        </span>
        <span
          className="map-hint"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          references inferred from <code>&lt;name&gt;Id → name</code>
        </span>
        <div style={{ flex: 1, minWidth: 8 }} />
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
            initPos();
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
              {refs.map((r, i) => {
                const fc = byId[r.from];
                if (!fc) return null;
                const p = edgePath(r.from, r.to, fieldRowIndex(fc, r.field));
                if (!p) return null;
                return (
                  <g key={"ref" + i}>
                    <path d={p.d} className="map-edge-path ref" />
                    <circle cx={p.sx} cy={p.sy} r="3" className="map-edge-dot ref" />
                    <circle cx={p.tx} cy={p.ty} r="4.5" className="map-edge-arrow ref" />
                  </g>
                );
              })}
            </svg>
            {colls.map((c) => {
              const p = positions[c.id];
              if (!p) return null;
              const extra = c.fields.length - MAX_FIELDS;
              return (
                <div key={c.id} className="map-card" style={{ left: p.x, top: p.y, width: CARD_W }}>
                  <div className="map-card-head" onMouseDown={(ev) => onHeadDown(ev, c.id)}>
                    <Icon name="folder_special" size={14} style={{ color: "var(--accent)" }} />
                    <span className="map-card-name">{c.name}</span>
                    {c.validated ? (
                      <Icon name="verified" size={12} style={{ color: "var(--text-faint)" }} />
                    ) : null}
                    <span className="map-card-count">{c.count}</span>
                    <button
                      className="map-card-open"
                      title={"Open " + c.name}
                      onMouseDown={(ev) => ev.stopPropagation()}
                      onClick={() => onOpenColl(c.name)}
                    >
                      <Icon name="open_in_new" size={13} />
                    </button>
                  </div>
                  <div className="map-card-cols">
                    {c.fields.slice(0, MAX_FIELDS).map((f) => {
                      const isRef = /Id$/.test(f.name) || f.name === "_id";
                      return (
                        <div key={f.name} className="map-card-col" style={{ height: ROW_H }}>
                          <span className="map-col-icon">
                            {f.name === "_id" ? (
                              <Icon
                                name="key"
                                size={11}
                                style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
                              />
                            ) : f.embedded ? (
                              <Icon
                                name={f.type === "array" ? "data_array" : "data_object"}
                                size={11}
                                style={{ color: MONGO_TYPE_COLOR[f.type as MongoType] }}
                              />
                            ) : isRef ? (
                              <Icon name="link" size={11} style={{ color: "var(--text-faint)" }} />
                            ) : null}
                          </span>
                          <span
                            className={"map-col-name" + (isRef && f.name !== "_id" ? " is-fk" : "")}
                          >
                            {f.name}
                          </span>
                          <span
                            className="map-col-type"
                            style={{ color: MONGO_TYPE_COLOR[f.type as MongoType] }}
                          >
                            {f.type}
                          </span>
                        </div>
                      );
                    })}
                    {extra > 0 ? (
                      <div className="map-card-col map-col-more" style={{ height: ROW_H }}>
                        <span className="map-col-icon" />
                        <span className="map-col-name">
                          + {extra} more field{extra > 1 ? "s" : ""}…
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
