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
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import type { Workspace } from "../../workspaces/types";
import { diagramExport, type EdgeWaypoint, type NodePosition } from "../api";
import { useSchemaMapStore } from "../state";
import {
  autoLayout,
  buildEdges,
  cardModel,
  contentBounds,
  contentExtent,
  HEAD_H,
  ROW_H,
  type CardModel,
  type EdgeModel,
  type Waypoint,
} from "../diagram";
import { ICON_KEY, ICON_LINK, ICON_OPEN, ICON_TABLE, type IconPath } from "../icons";
import {
  buildExportSvg,
  embeddedFontFaceCss,
  rasterizeToPngBase64,
  readExportColors,
} from "../export";
import "./SchemaMap.css";

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

const clampZoom = (z: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));

type Positions = Record<string, { x: number; y: number }>;

/** A drag in progress — a card move, an edge bend, or a canvas pan. */
type Drag =
  | { kind: "card"; table: string; startX: number; startY: number; origX: number; origY: number }
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
  // introspection cache de-dupes / warms the sidebar+grid too). Row counts
  // come from the cheap `loadTables` list (approxRowCount).
  const [metas, setMetas] = useState<Record<string, TableMeta> | null>(null);
  const [rowCounts, setRowCounts] = useState<Record<string, number | null>>({});
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
      const counts: Record<string, number | null> = {};
      for (const t of list) counts[t.name] = t.approxRowCount;
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
      setRowCounts(counts);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [handleId, schema, loadTables, loadTableMeta, reloadKey]);

  const tables = useMemo(() => (metas ? Object.keys(metas) : []), [metas]);

  // --- positions + zoom (with saved-layout restore) -------------------
  const [positions, setPositions] = useState<Positions | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Movable-edge waypoints: a {dx,dy} offset per edge id, applied to the live
  // midpoint so a bend follows the connected cards. Empty = all edges straight.
  const [waypoints, setWaypoints] = useState<Record<string, Waypoint>>({});
  // The currently selected edge id (highlighted + shows its bend handle), or
  // null. Clicking empty canvas deselects.
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

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
        for (const p of layout.positions) saved[p.table] = { x: p.x, y: p.y };
        // Merge: saved positions win; any table missing a saved position
        // (schema gained a table since the save) falls back to auto-layout.
        const merged: Positions = { ...auto };
        for (const t of Object.keys(metas)) if (saved[t]) merged[t] = saved[t];
        setPositions(merged);
        const wp: Record<string, Waypoint> = {};
        for (const e of layout.edges ?? []) wp[e.id] = { dx: e.dx, dy: e.dy };
        setWaypoints(wp);
        if (typeof layout.zoom === "number") setZoom(clampZoom(layout.zoom));
      } else {
        setPositions(auto);
        setWaypoints({});
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(
    (pos: Positions, z: number) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const positionsArr: NodePosition[] = Object.entries(pos).map(([table, p]) => ({
          table,
          x: p.x,
          y: p.y,
        }));
        const edgesArr: EdgeWaypoint[] = Object.entries(waypointsRef.current).map(([id, w]) => ({
          id,
          dx: w.dx,
          dy: w.dy,
        }));
        void saveLayout(connectionId, schema, {
          positions: positionsArr,
          edges: edgesArr,
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
      out.push(cardModel(t, meta, positions[t] ?? { x: 0, y: 0 }, rowCounts[t] ?? null));
    }
    return out;
  }, [metas, positions, tables, rowCounts]);

  const cardsById = useMemo<Record<string, CardModel>>(() => {
    const m: Record<string, CardModel> = {};
    for (const c of cards) m[c.table] = c;
    return m;
  }, [cards]);

  const edges = useMemo(
    () => (metas ? buildEdges(tables, metas, cardsById, waypoints) : []),
    [metas, tables, cardsById, waypoints],
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
    setPositions(auto);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    // Full reset to the initial state: re-run auto-layout AND straighten every
    // edge (clear all bezier waypoints). waypointsRef is cleared first so the
    // debounced persist below writes empty edges.
    waypointsRef.current = {};
    setWaypoints({});
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
      setExporting(true);
      try {
        const colors = readExportColors();
        const fontCss = await embeddedFontFaceCss();
        const svg = buildExportSvg(cards, edges, colors, fontCss);
        const b = contentBounds(cards, 48);
        const defaultName = `${schema}-schema-map.${format}`;

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

        const data = format === "png" ? await rasterizeToPngBase64(svg, b.width, b.height, 2) : svg;
        await diagramExport(path, format, data);
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
          <Icon name="hub" size={28} style={{ opacity: 0.5 }} />
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
        <Icon name="hub" size={16} style={{ color: "var(--accent)" }} />
        <span className="map-title">{schema} · schema map</span>
        <span className="map-sub">
          {tables.length} {tables.length === 1 ? "table" : "tables"} · {edges.length}{" "}
          {edges.length === 1 ? "relationship" : "relationships"}
        </span>
        <div style={{ flex: 1 }} />
        <span className="map-hint">drag tables to rearrange</span>
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
        {/* Export (PNG / SVG) — a small popover anchored to this button. */}
        <div className="map-export">
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
        // Dot-grid now PANS+ZOOMS with the content: the CSS background's tile
        // size scales with zoom and its origin tracks pan, so the grid moves
        // under the cards instead of staying fixed (Task 2 left this as a TODO).
        style={
          {
            backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
            backgroundPosition: `${pan.x}px ${pan.y}px`,
          } as React.CSSProperties
        }
      >
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
              <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#000" floodOpacity="0.4" />
            </filter>
          </defs>
          <g
            transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}
            className={dragRef.current ? "" : "map-eased"}
          >
            {/* Edges first so cards paint over their endpoints. */}
            <g className="map-edges-layer">
              {edges.map((edge) => (
                <Edge
                  key={edge.id}
                  edge={edge}
                  selected={selectedEdge === edge.id}
                  bent={Boolean(waypoints[edge.id])}
                  onSelectPointerDown={(e) => onEdgePointerDown(e, edge.id)}
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
                onOpen={() => openTableTab(schema, card.table)}
              />
            ))}
          </g>
        </svg>
        {/* Off-screen spacer matching the scaled SVG, so the wrap reserves the
            same scroll room at any zoom level. */}
        <div
          className="map-extent"
          style={{ width: extent.width * zoom, height: extent.height * zoom }}
        />
      </div>
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
function Edge({
  edge,
  selected,
  bent,
  onSelectPointerDown,
  onHandlePointerDown,
  onResetEdge,
}: {
  edge: EdgeModel;
  selected: boolean;
  bent: boolean;
  onSelectPointerDown: (e: React.PointerEvent) => void;
  onHandlePointerDown: (e: React.PointerEvent) => void;
  onResetEdge: () => void;
}) {
  return (
    <g className={"map-edge" + (selected ? " is-selected" : "")} data-edge-id={edge.id}>
      {/* Wide transparent hit-area makes the thin curve easy to click/touch. */}
      <path className="map-edge-hit" d={edge.path} onPointerDown={onSelectPointerDown} />
      <path className="map-edge-path" d={edge.path} />
      <circle className="map-edge-dot" cx={edge.sx} cy={edge.sy} r={3.5} />
      <circle className="map-edge-ring" cx={edge.tx} cy={edge.ty} r={5} />
      <circle className="map-edge-dot" cx={edge.tx} cy={edge.ty} r={2} />
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

/** One table card, rendered as an SVG group. */
function Card({
  card,
  onHeaderPointerDown,
  onOpen,
}: {
  card: CardModel;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onOpen: () => void;
}) {
  const { x, y, w, h, shownColumns, hiddenCount, rowCount } = card;
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
      {/* Header — grab handle (drag), table icon, name, row count, open btn. */}
      <g className="map-card-head" onPointerDown={onHeaderPointerDown}>
        <rect className="map-card-head-bg" x={0} y={0} width={w} height={HEAD_H} rx={11} />
        {/* square off the header's bottom corners (rx only rounds the top) */}
        <rect className="map-card-head-bg" x={0} y={HEAD_H - 11} width={w} height={11} />
        <line className="map-card-head-rule" x1={0} y1={HEAD_H} x2={w} y2={HEAD_H} />
        <CardIcon className="map-card-icon" icon={ICON_TABLE} x={9} y={HEAD_H / 2 - 7} size={14} />
        <text className="map-card-name" x={30} y={HEAD_H / 2} dominantBaseline="central">
          {truncate(card.table, 18)}
        </text>
        {rowCount !== null ? (
          <text
            className="map-card-count"
            x={w - 30}
            y={HEAD_H / 2}
            textAnchor="end"
            dominantBaseline="central"
          >
            {formatCount(rowCount)}
          </text>
        ) : null}
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
        const ry = HEAD_H + 4 + i * ROW_H;
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
              {truncate(col.name, 16)}
            </text>
            <text
              className="map-col-type"
              x={w - 10}
              y={cy}
              textAnchor="end"
              dominantBaseline="central"
            >
              {truncate(col.dataType.toLowerCase(), 12)}
            </text>
          </g>
        );
      })}
      {hiddenCount > 0 ? (
        <text
          className="map-col-more"
          x={26}
          y={HEAD_H + 4 + shownColumns.length * ROW_H + ROW_H / 2}
          dominantBaseline="central"
        >
          + {hiddenCount} more columns…
        </text>
      ) : null}
    </g>
  );
}

/** Truncate a label to `max` chars with an ellipsis (SVG has no text-overflow). */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Compact row-count label for the header chip (e.g. 12.3k). */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}
