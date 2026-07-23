// SchemaMap — the interactive ER schema-map diagram (M9 §3.8). Renders the
// `map` tab body: a toolbar + a pan/zoomable SVG canvas of table cards joined
// by FK edges, with draggable cards (live edge re-route), auto-layout, and
// position/zoom persistence per (connectionId, schema).
//
// ============================ ARCHITECTURE ============================
// SVG-NATIVE RENDERING (deliberate divergence from the prototype).
// --------------------------------------------------------------------
// The prototype (schemamap.jsx) draws cards as absolutely-positioned HTML
// <div>s over an SVG edge layer. We instead render the ENTIRE diagram as one
// <svg>: cards are <g> groups of <rect> + <text> rows, edges are <path>s, all
// inside a single pan/zoom transform group `<g transform="translate scale">`.
//
// WHY: Task 3 must export the diagram to PNG/SVG. A pure-SVG tree serialises
// to a standalone .svg and rasterises to PNG cleanly. HTML-in-SVG via
// <foreignObject> taints the canvas (cross-origin/security) and breaks
// canvas.toDataURL PNG export in most engines. Building SVG-native now means
// Task 3's export is "serialise this <svg>" rather than a rewrite. We match
// the prototype's VISUAL (geometry/colours/fonts from §3.8 + ByteTable.html)
// using the same tokens, only the rendering substrate differs.
//
// STRUCTURE:
//   - pan/zoom: a `<g transform="translate(panX,panY) scale(zoom)">` wraps all
//     content. Zoom is clamped 50–150% via toolbar controls (+ optional wheel).
//     Pan is dragging empty canvas. The dot-grid is a CSS background on the
//     wrapper behind the <svg> (cheap, and excluded from export by design —
//     Task 3 paints its own grid into the export if wanted).
//   - cards: pure geometry from diagram.ts; positions live in `positions`
//     state. Dragging a card header mutates only that card's position (a
//     transform-level update, no re-layout) → edges re-route live because
//     they are recomputed from `positions` on each render (memoised).
//   - edges: built from FK metadata in diagram.ts with a STABLE id scheme
//     (`child.cols->refTable`) that Task 3's EdgeWaypoint keys on.
//
// TASK 3 SEAMS (do not build here — leave clean):
//   - Export button: marked spot in the toolbar (commented).
//   - Movable edge waypoints: edges carry a stable id; edgeGeometry() in
//     diagram.ts documents where a {dx,dy} midpoint control point slots in.
//     `layout.edges` is round-tripped untouched on save so Task 3's waypoints
//     survive this task's position saves.
//
// PERSISTENCE: on mount, `useSchemaMapStore.load(connectionId, schema)`. If
// saved positions exist, use them (restores drags across restarts); else
// auto-layout. Saves are debounced and fire on drag END, never per mousemove,
// to avoid IPC spam. Zoom is persisted too. connectionId = workspace.saved.id.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TableMeta } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { highlightSql } from "../../browse/shared/highlightSql";
import { Btn } from "../../../shared/ui/Btn";
import { BTLogo } from "../../../shared/ui/BTLogo";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { useToast } from "../../../shared/ui/toastContext";
import { useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import type { Workspace } from "../../workspaces/types";
import {
  diagramExport,
  type CardinalityKind,
  type EdgeCardinality,
  type EdgeWaypoint,
  type NodePosition,
} from "../api";
import { useSchemaMapStore } from "../state";
import {
  autoLayout,
  buildEdges,
  cardModel,
  CARD_PAD_T,
  CARD_W,
  contentExtent,
  crowFoot,
  HEAD_H,
  ROW_H,
  type CardModel,
  type EdgeModel,
  type Waypoint,
} from "../diagram";
import { ICON_KEY, ICON_LINK, ICON_OPEN, ICON_TABLE, type IconPath } from "../icons";
import { buildExportSvg, embeddedFontFaceCss, exportTimestamp, readExportColors } from "../export";
import { isDestructive } from "../editModel";
import { useSchemaEditor } from "../useSchemaEditor";
import { SchemaCommitModal } from "./SchemaCommitModal";
import { SchemaEditCanvas } from "./SchemaEditCanvas";
import "./SchemaMap.css";

/** Engines whose schema map is editable (staged DDL). Mongo/Dynamo/Redis ship
 *  read-only maps; the edit toggle is gated to relational engines only. */
const EDITABLE_ENGINES = new Set(["sqlite", "mysql", "postgres"]);

// Lazily import the dialog plugin so plain-browser dev (no Tauri) doesn't crash
// at module load; the dynamic import rejects there and we show an info toast.
async function saveDialog(defaultName: string, ext: string, label: string) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] });
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.1;
/** Debounce (ms) for persisting positions after a drag settles. */
const SAVE_DEBOUNCE = 400;

// Read-mode card resize bounds (widen-only): the default CARD_W is the floor,
// so resizing only grows a card to fit long names, never shrinks it below the
// default. MAX caps how wide a single card can get.
const MIN_CARD_W = CARD_W;
const MAX_CARD_W = 720;
const clampCardW = (w: number): number => Math.min(MAX_CARD_W, Math.max(MIN_CARD_W, w));

const clampZoom = (z: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));

type Positions = Record<string, { x: number; y: number }>;
/** User-resized card widths by table (read-mode). Absent = default CARD_W. */
type Widths = Record<string, number>;

/** Spread a read-mode layout apart for edit mode, where cards are 340px wide
 *  (vs 224px) and show every column, so the read spacing would overlap. */
const SPREAD_X = 1.5;
const SPREAD_Y = 1.4;
function spreadPositions(p: Positions): Positions {
  const np: Positions = {};
  for (const [k, v] of Object.entries(p)) np[k] = { x: v.x * SPREAD_X, y: v.y * SPREAD_Y };
  return np;
}

/** Re-anchor a layout's bounding box to `margin` from the origin. Read-mode
 *  positions can sit anywhere (panned/dragged/saved), and edit mode navigates
 *  by scroll from 0,0 — so without this, spread cards land off-screen and the
 *  user has to hit Reset View. Keeps the arrangement, just shifts it into view. */
const EDIT_MARGIN = 48;
function anchorToOrigin(p: Positions): Positions {
  const vals = Object.values(p);
  if (vals.length === 0) return p;
  const minX = Math.min(...vals.map((v) => v.x));
  const minY = Math.min(...vals.map((v) => v.y));
  const np: Positions = {};
  for (const [k, v] of Object.entries(p))
    np[k] = { x: v.x - minX + EDIT_MARGIN, y: v.y - minY + EDIT_MARGIN };
  return np;
}

/** A drag in progress — a card move, an edge bend, or a canvas pan. */
type Drag =
  | { kind: "card"; table: string; startX: number; startY: number; origX: number; origY: number }
  | { kind: "resize"; table: string; startX: number; origW: number }
  | {
      kind: "edge";
      id: string;
      startX: number;
      startY: number;
      origDx: number;
      origDy: number;
      moved: boolean;
    }
  | { kind: "pan"; startX: number; startY: number; origPanX: number; origPanY: number };

export function SchemaMap({ workspace, schema }: { workspace: Workspace; schema: string }) {
  const { handleId } = workspace;
  const connectionId = workspace.saved.id;

  const toast = useToast();
  const loadTables = useIntrospectionStore((s) => s.loadTables);
  const loadTableMeta = useIntrospectionStore((s) => s.loadTableMeta);
  const openTableTab = useWorkspacesStore((s) => s.openTableTab);
  const loadLayout = useSchemaMapStore((s) => s.load);
  const saveLayout = useSchemaMapStore((s) => s.save);

  // --- table metas for the whole schema -------------------------------
  // The map needs every table's columns + FKs. There is no bulk meta command,
  // so we load per table in parallel (the map opens once per schema and the
  // introspection cache de-dupes / warms the sidebar+grid too).
  const [metas, setMetas] = useState<Record<string, TableMeta> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      setMetas(null);
      const list = await loadTables(handleId, schema);
      if (cancelled) return;
      if (!list) {
        const key = `${handleId}\u0000${schema}`;
        const err = useIntrospectionStore.getState().errors[key];
        setLoadError(err ?? "Could not load tables.");
        setLoading(false);
        return;
      }
      const results = await Promise.all(
        list.map(async (t) => [t.name, await loadTableMeta(handleId, schema, t.name)] as const),
      );
      if (cancelled) return;
      const map: Record<string, TableMeta> = {};
      let firstError: string | null = null;
      for (const [name, meta] of results) {
        if (meta) map[name] = meta;
        else if (!firstError) firstError = `Could not load structure of ${name}.`;
      }
      // A table with no resolvable meta is dropped from the map rather than
      // failing the whole diagram; only a total wipe-out surfaces an error.
      if (Object.keys(map).length === 0 && list.length > 0) {
        setLoadError(firstError ?? "Could not load schema metadata.");
        setLoading(false);
        return;
      }
      setMetas(map);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [handleId, schema, loadTables, loadTableMeta, reloadKey]);

  const tables = useMemo(() => (metas ? Object.keys(metas) : []), [metas]);

  // --- positions + zoom (with saved-layout restore) -------------------
  const [positions, setPositions] = useState<Positions | null>(null);
  // User-resized read-mode card widths by table (empty = all default width).
  const [widths, setWidths] = useState<Widths>({});
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Movable-edge waypoints: a {dx,dy} offset per edge id, applied to the live
  // midpoint so a bend follows the connected cards. Empty = all edges straight.
  const [waypoints, setWaypoints] = useState<Record<string, Waypoint>>({});
  // Manual cardinality overrides per edge id (empty = all auto-derived). Wins
  // over the schema-derived crow's-foot ends. Persisted with the layout.
  const [overrides, setOverrides] = useState<Record<string, CardinalityKind>>({});
  // The currently selected edge id (highlighted + shows its bend handle), or
  // null. Clicking empty canvas deselects.
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  // The edge the pointer is currently over. Drives the hover glow AND raises
  // that edge to the top of the paint order, so an overlapping neighbour can't
  // occlude the highlighted portion of the curve.
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  // --- edit mode (visual schema designer) -----------------------------
  const [editing, setEditing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Drag-to-reorder state for the pending-migration list (index being dragged /
  // index currently hovered as the drop target).
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const editable = EDITABLE_ENGINES.has(workspace.saved.engine);
  // Edit mode keeps its OWN positions, seeded (spread apart so the wider 340px
  // cards don't overlap) from the read-mode layout when editing starts and
  // discarded on exit. The read-mode `positions` are never touched, so leaving
  // edit mode restores the exact arrangement with no un-spread arithmetic.
  const [editPositions, setEditPositions] = useState<Positions | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // World-space top-left for a newly added table — derived from the current
  // scroll so the card lands in view.
  const newTablePos = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return { x: 40, y: 40 };
    return { x: wrap.scrollLeft / zoom + 40, y: wrap.scrollTop / zoom + 40 };
  }, [zoom]);

  const onCommitted = useCallback(() => {
    // Drop back to read mode and re-introspect: the map then reflects the
    // committed schema as live truth (read-mode positions were never touched).
    setCommitOpen(false);
    setReviewOpen(false);
    setEditing(false);
    setEditPositions(null);
    setReloadKey((k) => k + 1);
  }, []);

  const editor = useSchemaEditor({
    workspace,
    schemaName: schema,
    metas,
    // Table add/rename/drop mutate the edit-mode positions, never the read ones.
    setPositions: setEditPositions,
    newTablePos,
    onCommitted,
    toast,
  });

  const toggleEditing = () => {
    if (editing) {
      if (editor.pending.length) {
        toast("Commit or discard pending changes first", "err");
        return;
      }
      setEditing(false);
      setEditPositions(null);
    } else {
      // Seed edit positions from the read-mode layout, spread apart for the
      // wider cards and re-anchored to the origin so they land in view. Reset
      // zoom + scroll so entering edit mode is centered without a Reset View.
      setEditPositions(positions ? anchorToOrigin(spreadPositions(positions)) : {});
      setZoom(1);
      setEditing(true);
      requestAnimationFrame(() => wrapRef.current?.scrollTo({ left: 0, top: 0 }));
    }
  };

  // Reorder the pending list by pointer drag from a row's grip. Native HTML5
  // drag/drop is unreliable in Tauri's webview, so this mirrors the card-drag
  // approach (window mousemove/mouseup), hit-testing rows by their `data-idx`.
  const startPendingDrag = (e: React.MouseEvent, from: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragIdx(from);
    setDragOverIdx(from);
    let over = from;
    const onMove = (me: MouseEvent) => {
      const el = document.elementFromPoint(me.clientX, me.clientY);
      const row = el && "closest" in el ? (el as Element).closest(".pending-sql-row") : null;
      const idx = row?.getAttribute("data-idx");
      if (idx != null) {
        over = Number(idx);
        setDragOverIdx(over);
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (over !== from) editor.reorder(from, over);
      setDragIdx(null);
      setDragOverIdx(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Resolve positions once metas are in: saved layout wins, else auto-layout.
  useEffect(() => {
    if (!metas) return;
    let cancelled = false;
    void (async () => {
      const layout = await loadLayout(connectionId, schema);
      if (cancelled) return;
      const auto = autoLayout(Object.keys(metas), metas);
      if (layout && layout.positions.length > 0) {
        const saved: Positions = {};
        const savedWidths: Widths = {};
        for (const p of layout.positions) {
          saved[p.table] = { x: p.x, y: p.y };
          // A saved width only applies to tables still present; clamp defends
          // against a stale/out-of-range value in the JSON.
          if (typeof p.w === "number" && metas[p.table]) savedWidths[p.table] = clampCardW(p.w);
        }
        // Merge: saved positions win; any table missing a saved position
        // (schema gained a table since the save) falls back to auto-layout.
        const merged: Positions = { ...auto };
        for (const t of Object.keys(metas)) if (saved[t]) merged[t] = saved[t];
        setPositions(merged);
        setWidths(savedWidths);
        const wp: Record<string, Waypoint> = {};
        for (const e of layout.edges ?? []) wp[e.id] = { dx: e.dx, dy: e.dy };
        setWaypoints(wp);
        const ov: Record<string, CardinalityKind> = {};
        for (const c of layout.cardinalities ?? []) ov[c.id] = c.kind;
        setOverrides(ov);
        if (typeof layout.zoom === "number") setZoom(clampZoom(layout.zoom));
      } else {
        setPositions(auto);
        setWidths({});
        setWaypoints({});
        setOverrides({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metas, connectionId, schema, loadLayout]);

  // --- persistence (debounced, on drag END) ---------------------------
  // A ref mirrors the live waypoints so any debounced save (whether triggered
  // by a card/zoom change or a waypoint drag) writes the current bends — one
  // mapLayoutSave carries positions + edges + zoom together.
  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  // Mirror the live widths so any debounced save writes the current sizes,
  // whichever drag (card move / resize / edge bend / zoom) triggered it.
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(
    (pos: Positions, z: number) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const positionsArr: NodePosition[] = Object.entries(pos).map(([table, p]) => ({
          table,
          x: p.x,
          y: p.y,
          // Only widened cards carry `w`; a default-width card omits it (undefined
          // is dropped by JSON.stringify), keeping the saved layout lean.
          w: widthsRef.current[table],
        }));
        const edgesArr: EdgeWaypoint[] = Object.entries(waypointsRef.current).map(([id, w]) => ({
          id,
          dx: w.dx,
          dy: w.dy,
        }));
        const cardinalitiesArr: EdgeCardinality[] = Object.entries(overridesRef.current).map(
          ([id, kind]) => ({ id, kind }),
        );
        void saveLayout(connectionId, schema, {
          positions: positionsArr,
          edges: edgesArr,
          cardinalities: cardinalitiesArr,
          zoom: z,
        });
      }, SAVE_DEBOUNCE);
    },
    [saveLayout, connectionId, schema],
  );
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  // --- card models + edges (recomputed from positions; memoised) ------
  const cards = useMemo<CardModel[]>(() => {
    if (!metas || !positions) return [];
    const out: CardModel[] = [];
    for (const t of tables) {
      const meta = metas[t];
      if (!meta) continue;
      out.push(cardModel(t, meta, positions[t] ?? { x: 0, y: 0 }, widths[t]));
    }
    return out;
  }, [metas, positions, widths, tables]);

  const cardsById = useMemo<Record<string, CardModel>>(() => {
    const m: Record<string, CardModel> = {};
    for (const c of cards) m[c.table] = c;
    return m;
  }, [cards]);

  const edges = useMemo(
    () => (metas ? buildEdges(tables, metas, cardsById, waypoints, overrides) : []),
    [metas, tables, cardsById, waypoints, overrides],
  );

  // The selected edge's live model — resolved here so its cardinality popover
  // can render in a top layer (above the cards), not inside the edge layer.
  const selectedEdgeModel = useMemo(
    () => (selectedEdge ? (edges.find((e) => e.id === selectedEdge) ?? null) : null),
    [edges, selectedEdge],
  );

  // Paint order with the highlighted edges lifted to the end (SVG has no
  // z-index — last painted wins). Selected rises above the rest; the hovered
  // edge rises above everything, so the curve under the cursor is never
  // occluded by an overlapping neighbour and glows along its whole length.
  const orderedEdges = useMemo(() => {
    if (!hoveredEdge && !selectedEdge) return edges;
    const raised = [selectedEdge, hoveredEdge].filter(
      (id, i, a): id is string => Boolean(id) && a.indexOf(id) === i,
    );
    const base = edges.filter((e) => !raised.includes(e.id));
    const top = raised
      .map((id) => edges.find((e) => e.id === id))
      .filter((e): e is EdgeModel => Boolean(e));
    return [...base, ...top];
  }, [edges, hoveredEdge, selectedEdge]);

  // Set (or clear, with null) an edge's manual cardinality override, then persist.
  const setCardinality = useCallback(
    (id: string, kind: CardinalityKind | null) => {
      setOverrides((prev) => {
        const next = { ...prev };
        if (kind === null) delete next[id];
        else next[id] = kind;
        overridesRef.current = next;
        return next;
      });
      if (positions) persist(positions, zoom);
    },
    [positions, zoom, persist],
  );

  const extent = useMemo(() => contentExtent(cards), [cards]);

  // --- drag (card move + canvas pan) ----------------------------------
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const onCardPointerDown = (e: React.PointerEvent, table: string) => {
    if (e.button !== 0 || !positions) return;
    e.stopPropagation();
    // Capture on the <svg> (not the card glyph) so its onPointerMove/Up keep
    // firing for the whole drag even if the pointer leaves the card.
    svgRef.current?.setPointerCapture?.(e.pointerId);
    const p = positions[table];
    dragRef.current = {
      kind: "card",
      table,
      startX: e.clientX,
      startY: e.clientY,
      origX: p?.x ?? 0,
      origY: p?.y ?? 0,
    };
  };

  // Grab a card's right-edge handle → drag to resize its width (widen-only).
  const onCardResizePointerDown = (e: React.PointerEvent, table: string) => {
    if (e.button !== 0 || !positions) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      kind: "resize",
      table,
      startX: e.clientX,
      origW: widths[table] ?? CARD_W,
    };
  };

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Clicking empty canvas deselects any selected edge + closes the menu.
    setSelectedEdge(null);
    setExportMenuOpen(false);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      kind: "pan",
      startX: e.clientX,
      startY: e.clientY,
      origPanX: pan.x,
      origPanY: pan.y,
    };
  };

  // Click an edge's wide hit-area → select it (without starting a pan).
  const onEdgePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedEdge(id);
  };

  // Grab an edge's bend handle → drag to offset its midpoint waypoint.
  const onHandlePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture?.(e.pointerId);
    setSelectedEdge(id);
    const w = waypoints[id];
    dragRef.current = {
      kind: "edge",
      id,
      startX: e.clientX,
      startY: e.clientY,
      origDx: w?.dx ?? 0,
      origDy: w?.dy ?? 0,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "card") {
      const nx = Math.max(0, d.origX + (e.clientX - d.startX) / zoom);
      const ny = Math.max(0, d.origY + (e.clientY - d.startY) / zoom);
      setPositions((prev) => (prev ? { ...prev, [d.table]: { x: nx, y: ny } } : prev));
    } else if (d.kind === "resize") {
      const nw = clampCardW(d.origW + (e.clientX - d.startX) / zoom);
      setWidths((prev) => ({ ...prev, [d.table]: nw }));
    } else if (d.kind === "edge") {
      const dx = d.origDx + (e.clientX - d.startX) / zoom;
      const dy = d.origDy + (e.clientY - d.startY) / zoom;
      d.moved = true;
      setWaypoints((prev) => ({ ...prev, [d.id]: { dx, dy } }));
    } else {
      setPan({ x: d.origPanX + (e.clientX - d.startX), y: d.origPanY + (e.clientY - d.startY) });
    }
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    // Persist when a card moved or an edge bent (positions/waypoints changed);
    // panning is pure view state and is not saved here.
    if (d?.kind === "card" && positions) persist(positions, zoom);
    else if (d?.kind === "resize" && positions) persist(positions, zoom);
    else if (d?.kind === "edge" && d.moved && positions) persist(positions, zoom);
  };

  /** Straighten an edge (clear its waypoint) — double-click its handle. */
  const resetEdge = (id: string) => {
    setWaypoints((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (positions) persist(positions, zoom);
  };

  // --- zoom controls ---------------------------------------------------
  const applyZoom = (z: number) => {
    const next = clampZoom(z);
    setZoom(next);
    // Read-mode positions are untouched in edit mode, so persisting the (read)
    // layout + zoom is safe either way.
    if (positions) persist(positions, next);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return; // only zoom on pinch / ctrl+wheel
    e.preventDefault();
    applyZoom(zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  };

  const resetView = () => {
    if (!metas) return;
    const auto = autoLayout(tables, metas);
    // In edit mode, reset only the (separate) edit-mode positions — re-spread so
    // the wider cards don't overlap — and leave the saved read layout untouched.
    if (editing) {
      setEditPositions(anchorToOrigin(spreadPositions(auto)));
      setZoom(1);
      requestAnimationFrame(() => wrapRef.current?.scrollTo({ left: 0, top: 0 }));
      return;
    }
    setPositions(auto);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    // Full reset to the initial state: re-run auto-layout, straighten every edge
    // (clear all bezier waypoints), AND drop custom card widths back to default.
    // The refs are cleared first so the debounced persist below writes the empty
    // edges + default widths.
    waypointsRef.current = {};
    setWaypoints({});
    widthsRef.current = {};
    setWidths({});
    persist(auto, 1);
  };

  // Reset only the bezier curves: straighten every edge back to its default
  // route, leaving card positions + zoom untouched. Shown in the toolbar only
  // when at least one edge has been bent.
  const resetCurves = () => {
    if (!positions) return;
    waypointsRef.current = {};
    setWaypoints({});
    persist(positions, zoom);
  };
  const hasBentEdges = Object.keys(waypoints).length > 0;

  // --- export (PNG / SVG) ---------------------------------------------
  // Build a standalone export SVG from the current card/edge models (whole
  // diagram at 1×, baked colours, embedded fonts, inline-path icons), then
  // either write it as .svg or rasterise → .png. The save dialog (a Tauri
  // plugin) is the user's consent; in plain browser dev it rejects and we show
  // an info toast.
  const runExport = useCallback(
    async (format: "png" | "svg") => {
      setExportMenuOpen(false);
      if (cards.length === 0) {
        toast("Nothing to export yet.", "info");
        return;
      }
      try {
        const colors = readExportColors();
        const fontCss = await embeddedFontFaceCss();
        const svg = buildExportSvg(cards, edges, colors, fontCss);
        const defaultName = `${schema}-schema-map-${exportTimestamp()}.${format}`;

        let path: string | null;
        try {
          path = await saveDialog(
            defaultName,
            format,
            format === "png" ? "PNG image" : "SVG image",
          );
        } catch {
          // Dialog plugin unavailable (browser dev) → not a real failure.
          toast("Exporting requires the ByteTable desktop app.", "info");
          return;
        }
        if (!path) return; // user cancelled

        // Only now show the loader — the render + file write is the slow part
        // (CPU-bound resvg raster for PNG); the save dialog above is user time.
        setExporting(true);
        // Both formats ship the SVG text; PNG is rasterized in Rust (resvg), not
        // the webview canvas — WebKitGTK can't do SVG→canvas→PNG on Linux.
        await diagramExport(path, format, svg);
        const file = path.split(/[\\/]/).pop() ?? defaultName;
        toast(`Exported schema map to ${file}`, "ok");
      } catch (err) {
        toast(appErrorMessage(err, "Could not export the schema map."), "err");
      } finally {
        setExporting(false);
      }
    },
    [cards, edges, schema, toast],
  );

  // --- render ----------------------------------------------------------
  if (loading) {
    return (
      <div className="schema-map">
        <div className="dg-state">
          <Icon name="schema" size={28} style={{ opacity: 0.5 }} />
          <span>Loading schema map for {schema}…</span>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="schema-map">
        <div className="dg-state">
          <Icon name="error" size={28} style={{ color: "#e06c75" }} />
          <div className="dg-error">
            Could not load the schema map.
            <code>{loadError}</code>
          </div>
          <button type="button" className="dg-retry" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="schema-map">
      <div className="map-toolbar">
        <Icon name="schema" size={16} style={{ color: "var(--accent)" }} />
        <span className="map-title">
          {schema} · schema {editing ? "designer" : "map"}
        </span>
        <span className="map-sub">
          {tables.length} {tables.length === 1 ? "table" : "tables"} · {edges.length}{" "}
          {edges.length === 1 ? "relationship" : "relationships"}
        </span>
        <div style={{ flex: 1 }} />
        {editing ? (
          <button type="button" className="map-addtable" onClick={editor.addTable}>
            <Icon name="add" size={15} />
            Add table
          </button>
        ) : (
          <span className="map-hint">drag tables to rearrange</span>
        )}
        {editable ? (
          <button
            type="button"
            className={"map-edit-toggle" + (editing ? " on" : "")}
            onClick={toggleEditing}
            title="Toggle schema editing"
          >
            <Icon name={editing ? "edit_off" : "edit"} size={15} />
            {editing ? "Editing" : "Edit schema"}
          </button>
        ) : null}
        <IconBtn
          icon="zoom_out"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => applyZoom(zoom - ZOOM_STEP)}
          disabled={zoom <= ZOOM_MIN}
        />
        <span className="map-zoom" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <IconBtn
          icon="zoom_in"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => applyZoom(zoom + ZOOM_STEP)}
          disabled={zoom >= ZOOM_MAX}
        />
        {hasBentEdges ? (
          <IconBtn
            icon="ink_eraser"
            title="Reset curves — straighten all edges to their default route"
            aria-label="Reset curved edges to straight"
            onClick={resetCurves}
          />
        ) : null}
        <IconBtn
          icon="fit_screen"
          title="Reset view & re-run layout (also straightens edges)"
          aria-label="Reset view, re-run auto-layout, and straighten edges"
          onClick={resetView}
        />
        {/* Export (PNG / SVG) — a small popover anchored to this button.
            Hidden in edit mode (export targets the read-mode SVG diagram). */}
        <div className="map-export" hidden={editing}>
          <IconBtn
            icon={exporting ? "hourglass_top" : "download"}
            title="Export diagram"
            aria-label="Export diagram"
            aria-haspopup="menu"
            aria-expanded={exportMenuOpen}
            disabled={exporting}
            active={exportMenuOpen}
            onClick={() => setExportMenuOpen((o) => !o)}
          />
          {exportMenuOpen ? (
            <div className="map-export-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="map-export-item"
                onClick={() => void runExport("png")}
              >
                <Icon name="image" size={15} />
                <span>PNG image</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="map-export-item"
                onClick={() => void runExport("svg")}
              >
                <Icon name="shape_line" size={15} />
                <span>SVG vector</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div
        className="map-canvas-wrap"
        ref={wrapRef}
        // Dot-grid now PANS+ZOOMS with the content: the CSS background's tile
        // size scales with zoom and its origin tracks pan, so the grid moves
        // under the cards instead of staying fixed (Task 2 left this as a TODO).
        style={
          {
            backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
            backgroundPosition: editing ? "0 0" : `${pan.x}px ${pan.y}px`,
          } as React.CSSProperties
        }
      >
        {editing ? (
          <SchemaEditCanvas
            editor={editor}
            positions={editPositions ?? {}}
            setPositions={setEditPositions}
            zoom={zoom}
            wrapRef={wrapRef}
          />
        ) : (
          <>
            <svg
              ref={svgRef}
              className="map-svg"
              // Size the SVG to the SCALED content extent (not the viewport) so cards
              // laid out beyond the visible area aren't clipped by the SVG's own box
              // — the wrap then scrolls to reach them. min-width/height:100% (CSS)
              // keeps it filling the viewport when the schema is small.
              width={extent.width * zoom}
              height={extent.height * zoom}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onWheel={onWheel}
            >
              <defs>
                {/* Soft layered drop shadow for cards (lighter than a CSS filter,
                and serialises into the export filter too). */}
                <filter id="mapCardShadow" x="-20%" y="-20%" width="140%" height="160%">
                  <feDropShadow
                    dx="0"
                    dy="6"
                    stdDeviation="9"
                    floodColor="#000"
                    floodOpacity="0.4"
                  />
                </filter>
              </defs>
              <g
                transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}
                className={dragRef.current ? "" : "map-eased"}
              >
                {/* Edges first so cards paint over their endpoints. */}
                <g className="map-edges-layer">
                  {orderedEdges.map((edge) => (
                    <Edge
                      key={edge.id}
                      edge={edge}
                      selected={selectedEdge === edge.id}
                      hovered={hoveredEdge === edge.id}
                      bent={Boolean(waypoints[edge.id])}
                      onSelectPointerDown={(e) => onEdgePointerDown(e, edge.id)}
                      onHoverChange={(h) =>
                        setHoveredEdge((cur) => (h ? edge.id : cur === edge.id ? null : cur))
                      }
                      onHandlePointerDown={(e) => onHandlePointerDown(e, edge.id)}
                      onResetEdge={() => resetEdge(edge.id)}
                    />
                  ))}
                </g>

                {cards.map((card) => (
                  <Card
                    key={card.table}
                    card={card}
                    onHeaderPointerDown={(e) => onCardPointerDown(e, card.table)}
                    onResizePointerDown={(e) => onCardResizePointerDown(e, card.table)}
                    onOpen={() => openTableTab(schema, card.table)}
                  />
                ))}

                {/* Cardinality popover on its own top layer — after the cards so
                    it paints above them (a real FK edge only; derived M:N stays
                    auto). */}
                {selectedEdgeModel && !selectedEdgeModel.derived ? (
                  <CardinalityPopover
                    edge={selectedEdgeModel}
                    override={overrides[selectedEdgeModel.id]}
                    onSetCardinality={(kind) => setCardinality(selectedEdgeModel.id, kind)}
                  />
                ) : null}
              </g>
            </svg>
            {/* Off-screen spacer matching the scaled SVG, so the wrap reserves the
            same scroll room at any zoom level. */}
            <div
              className="map-extent"
              style={{ width: extent.width * zoom, height: extent.height * zoom }}
            />
          </>
        )}
      </div>

      {/* Pending-migration bar — floats over the canvas bottom when ≥1 change
          is staged in edit mode. */}
      {editing && editor.pending.length > 0 ? (
        <div className="map-pending">
          {reviewOpen ? (
            <div className="pending-list">
              <div className="pending-list-title">Pending migration</div>
              {editor.pending.map((op, i) => (
                <div
                  key={i}
                  data-idx={i}
                  className={
                    "pending-sql-row" +
                    (dragIdx === i ? " dragging" : "") +
                    // Only while a drag is active — otherwise a lingering
                    // dragOverIdx would keep the drop indicator stuck on.
                    (dragIdx !== null && dragOverIdx === i && dragIdx !== i ? " drag-over" : "")
                  }
                >
                  <span
                    className="pending-sql-grip"
                    title="Drag to reorder"
                    onMouseDown={(e) => startPendingDrag(e, i)}
                  >
                    <Icon name="drag_indicator" size={15} />
                  </span>
                  <pre
                    className={"pending-sql" + (isDestructive(op.sql) ? " destructive" : "")}
                    dangerouslySetInnerHTML={{ __html: highlightSql(op.sql) }}
                  />
                  <button
                    type="button"
                    className="pending-sql-remove"
                    title="Remove this statement"
                    onClick={() => editor.unstage(i)}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="pending-bar-row">
            <Icon name="pending_actions" size={16} style={{ color: "var(--accent)" }} />
            <span className="pending-count">
              {editor.pending.length} pending change{editor.pending.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="pending-review"
              onClick={() => setReviewOpen((v) => !v)}
            >
              <Icon name={reviewOpen ? "expand_more" : "expand_less"} size={14} />
              {reviewOpen ? "Hide SQL" : "Review SQL"}
            </button>
            <div style={{ flex: 1 }} />
            <Btn variant="text" small onClick={editor.discard}>
              Discard
            </Btn>
            <Btn
              variant="filled"
              icon="published_with_changes"
              small
              onClick={() => setCommitOpen(true)}
            >
              Commit changes
            </Btn>
          </div>
        </div>
      ) : null}

      {commitOpen ? (
        <SchemaCommitModal
          schemaName={schema}
          env={workspace.saved.env}
          envColor={workspace.saved.color ?? ENV_COLOR[workspace.saved.env]}
          statements={editor.pending.map((o) => o.sql)}
          busy={editor.busy}
          onConfirm={() => void editor.commit()}
          onClose={() => setCommitOpen(false)}
        />
      ) : null}

      {/* Export loader — rasterizing/writing a large diagram can take a moment
          (CPU-bound in the backend), so cover the canvas with a branded overlay
          rather than leaving the UI looking idle until the toast fires. */}
      {exporting ? (
        <div className="map-export-overlay" role="status" aria-live="polite">
          <div className="map-export-loader">
            <div className="map-export-logo">
              <BTLogo size={44} blink />
            </div>
            <span className="map-export-label">Exporting schema map…</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A small inline-path icon inside an SVG card (replaces Material Symbols font
 * glyphs so the diagram exports/rasterises without an icon-font dependency). */
function CardIcon({
  icon,
  x,
  y,
  size,
  className,
}: {
  icon: IconPath;
  x: number;
  y: number;
  size: number;
  className?: string;
}) {
  const s = size / 24;
  return <path className={className} d={icon.d} transform={`translate(${x},${y}) scale(${s})`} />;
}

/** One FK edge: visible curve + wide hit-area + endpoints + bend handle. */
const CARDINALITY_OPTIONS: { label: string; kind: CardinalityKind | null }[] = [
  { label: "Auto", kind: null },
  { label: "1:1", kind: "1:1" },
  { label: "1:N", kind: "1:N" },
  { label: "M:N", kind: "M:N" },
];

function Edge({
  edge,
  selected,
  hovered,
  bent,
  onSelectPointerDown,
  onHoverChange,
  onHandlePointerDown,
  onResetEdge,
}: {
  edge: EdgeModel;
  selected: boolean;
  hovered: boolean;
  bent: boolean;
  onSelectPointerDown: (e: React.PointerEvent) => void;
  onHoverChange: (hovering: boolean) => void;
  onHandlePointerDown: (e: React.PointerEvent) => void;
  onResetEdge: () => void;
}) {
  return (
    <g
      className={
        "map-edge" +
        (selected ? " is-selected" : "") +
        (hovered ? " is-hovered" : "") +
        (edge.derived ? " is-mn" : "")
      }
      data-edge-id={edge.id}
    >
      {/* Wide transparent hit-area makes the thin curve easy to click/touch, and
          drives the hover glow + raise (the thin path is not directly hovered). */}
      <path
        className="map-edge-hit"
        d={edge.path}
        onPointerDown={onSelectPointerDown}
        onPointerEnter={() => onHoverChange(true)}
        onPointerLeave={() => onHoverChange(false)}
      />
      <path className="map-edge-path" d={edge.path} />
      <circle className="map-edge-dot" cx={edge.sx} cy={edge.sy} r={2} />
      <circle className="map-edge-dot" cx={edge.tx} cy={edge.ty} r={2} />
      {/* Crow's-foot cardinality markers at each endpoint. */}
      <path className="map-edge-foot" d={crowFoot(edge.sx, edge.sy, edge.sOut, edge.childEnd)} />
      <path className="map-edge-foot" d={crowFoot(edge.tx, edge.ty, edge.tOut, edge.parentEnd)} />
      {/* Bend handle: shown when selected or already bent. Drag to bend, double
          -click to straighten (reset). */}
      {selected || bent ? (
        <circle
          className="map-edge-handle"
          cx={edge.mx}
          cy={edge.my}
          r={5}
          role="button"
          tabIndex={0}
          aria-label="Drag to bend relationship; double-click to straighten"
          onPointerDown={onHandlePointerDown}
          onDoubleClick={onResetEdge}
        />
      ) : null}
    </g>
  );
}

/**
 * Cardinality override popover for the selected FK edge (1:1 / 1:N / M:N /
 * Auto). Rendered in its OWN layer *above* the cards — a foreignObject left
 * inside the edge layer paints under any card the edge passes behind, hiding
 * the buttons (see the layer order in the main SVG).
 */
function CardinalityPopover({
  edge,
  override,
  onSetCardinality,
}: {
  edge: EdgeModel;
  override: CardinalityKind | undefined;
  onSetCardinality: (kind: CardinalityKind | null) => void;
}) {
  return (
    <foreignObject x={edge.mx - 78} y={edge.my + 12} width={156} height={26}>
      <div className="map-card-pop" onPointerDown={(e) => e.stopPropagation()}>
        {CARDINALITY_OPTIONS.map((o) => {
          const active = (override ?? null) === o.kind;
          return (
            <button
              key={o.label}
              type="button"
              className={"map-card-pop-btn" + (active ? " active" : "")}
              onClick={() => onSetCardinality(o.kind)}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </foreignObject>
  );
}

/** One table card, rendered as an SVG group. */
function Card({
  card,
  onHeaderPointerDown,
  onResizePointerDown,
  onOpen,
}: {
  card: CardModel;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onResizePointerDown: (e: React.PointerEvent) => void;
  onOpen: () => void;
}) {
  const { x, y, w, h, shownColumns, hiddenCount } = card;
  // Truncation budgets scale with width (widen-only), so a resized card reveals
  // more of long table/column names rather than just adding whitespace. The
  // baseline char counts hold at the default CARD_W.
  const wr = w / CARD_W;
  const nameMax = Math.round(18 * wr);
  const colNameMax = Math.round(16 * wr);
  const colTypeMax = Math.round(12 * wr);
  return (
    <g className="map-card" transform={`translate(${x},${y})`}>
      <rect
        className="map-card-box"
        x={0}
        y={0}
        width={w}
        height={h}
        rx={11}
        filter="url(#mapCardShadow)"
      />
      {/* Header — grab handle (drag), table icon, name, open btn. */}
      <g className="map-card-head" onPointerDown={onHeaderPointerDown}>
        <rect className="map-card-head-bg" x={0} y={0} width={w} height={HEAD_H} rx={11} />
        {/* square off the header's bottom corners (rx only rounds the top) */}
        <rect className="map-card-head-bg" x={0} y={HEAD_H - 11} width={w} height={11} />
        <line className="map-card-head-rule" x1={0} y1={HEAD_H} x2={w} y2={HEAD_H} />
        <CardIcon className="map-card-icon" icon={ICON_TABLE} x={9} y={HEAD_H / 2 - 7} size={14} />
        <text className="map-card-name" x={30} y={HEAD_H / 2} dominantBaseline="central">
          {truncate(card.table, nameMax)}
        </text>
        {/* open-in-new — SVG button with its own click handler. */}
        <g
          className="map-card-open"
          role="button"
          tabIndex={0}
          aria-label={`Open ${card.table}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen();
            }
          }}
        >
          <rect
            className="map-card-open-hit"
            x={w - 24}
            y={HEAD_H / 2 - 10}
            width={20}
            height={20}
            rx={5}
          />
          <CardIcon
            className="map-card-open-icon"
            icon={ICON_OPEN}
            x={w - 20.5}
            y={HEAD_H / 2 - 6.5}
            size={13}
          />
        </g>
      </g>

      {/* Column rows. */}
      {shownColumns.map((col, i) => {
        const ry = HEAD_H + CARD_PAD_T + i * ROW_H;
        const cy = ry + ROW_H / 2;
        return (
          <g key={col.name} className="map-card-row">
            {col.pk ? (
              <CardIcon
                className="map-col-icon map-col-pk"
                icon={ICON_KEY}
                x={4}
                y={cy - 5.5}
                size={11}
              />
            ) : col.fk ? (
              <CardIcon
                className="map-col-icon map-col-fk"
                icon={ICON_LINK}
                x={4}
                y={cy - 5.5}
                size={11}
              />
            ) : null}
            <text
              className={"map-col-name" + (col.fk ? " is-fk" : "")}
              x={26}
              y={cy}
              dominantBaseline="central"
            >
              {truncate(col.name, colNameMax)}
            </text>
            <text
              className="map-col-type"
              x={w - 10}
              y={cy}
              textAnchor="end"
              dominantBaseline="central"
            >
              {truncate(col.dataType.toLowerCase(), colTypeMax)}
            </text>
          </g>
        );
      })}
      {hiddenCount > 0 ? (
        <text
          className="map-col-more"
          x={26}
          y={HEAD_H + CARD_PAD_T + shownColumns.length * ROW_H + ROW_H / 2}
          dominantBaseline="central"
        >
          + {hiddenCount} more columns…
        </text>
      ) : null}

      {/* Right-edge resize handle (widen-only). A transparent hit strip
          straddling the card's right border, below the header so it never
          conflicts with the header drag or the open button. The thin visible
          grip appears on hover (CSS). */}
      <g className="map-card-resize" onPointerDown={onResizePointerDown}>
        <rect className="map-card-resize-hit" x={w - 5} y={HEAD_H} width={10} height={h - HEAD_H} />
        <line className="map-card-resize-grip" x1={w} y1={HEAD_H + 6} x2={w} y2={h - 6} />
      </g>
    </g>
  );
}

/** Truncate a label to `max` chars with an ellipsis (SVG has no text-overflow). */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
