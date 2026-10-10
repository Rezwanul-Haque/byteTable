// The board canvas (M37 Tasks 2 + 4): world transform, pan/zoom, one pointer
// state machine, the per-type object renderers, group outlines and the SVG layer
// (flow edges, derived FK relations, ink, the in-flight connector).
//
// ============================== DESIGN ==============================
//
// **One world div.** Everything lives inside `.bb-world`, which carries
// `translate(x,y) scale(k)`. Objects are positioned in world coordinates and
// never know about the view, so panning and zooming are one style change rather
// than a re-layout. The dot grid is the viewport's own background, moved and
// scaled with the view so it reads as the same surface.
//
// **One pointer state machine.** Every gesture — pan, drag, resize, ink, link —
// is one entry in `gesture`, and the move/up listeners are registered on WINDOW
// at pointerdown. Window-level is the point: a drag that leaves the viewport (or
// the window) still tracks, and still ends, which per-element handlers cannot
// promise. The listeners are stable function identities that forward to refs, so
// re-renders during a drag never re-subscribe.
//
// **Measured bounds.** Most objects size themselves to their content, so edges
// would visibly miss if they anchored on guesses. Every measurable object
// carries `data-measure`, a layout effect reads the real box, and the edge
// router works from those. The effect has no dependency array on purpose (any
// render may change a size) and only calls `setSizes` when something actually
// moved, so it converges in one extra pass.
//
// **Dimmed means inert.** Isolating a layer dims the others to 18% — it never
// hides them, because context is the whole point of one canvas. A faded object
// must not take pointer events, or it steals clicks from the focused layer; that
// is enforced in CSS (`.dim { pointer-events: none }`, SVG paths included) and
// relied on here.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { Icon } from "../../../shared/ui/Icon";
import { useT } from "../../../shared/i18n/useT";
import type { BoardDiffInfo } from "../diff";
import { tableStateLabel } from "../diff";
import { boxOf, clampZoom, edgePath, inkPath, unionBox, volumeWidth } from "../geometry";
import {
  edgeLayer,
  isEditable,
  uid,
  FLOW_KINDS,
  STICKY_COLORS,
  ZOOM_MAX,
  ZOOM_MIN,
  type BoardDoc,
  type BoardObject,
  type BoardSelection,
  type BoardSizes,
  type BoardView,
  type LayerFocus,
  type Point,
  type TableObject,
} from "../model";
import { moveObjects, patchObject } from "../doc";
import type { ToolId } from "../tools";
import { BoardTextEditor } from "./BoardTextEditor";
import { JsonText } from "./JsonText";

/** How far (in world px, scaled by zoom) the pen moves before it samples again.
 *  Dividing by k keeps the sampling density constant on screen. */
const INK_SAMPLE_PX = 2.5;

/** Minimum size a frame can be dragged down to. */
const FRAME_MIN_W = 180;
const FRAME_MIN_H = 120;

/** Padding between a group's members and its outline. */
const GROUP_PAD = 18;

/** The grid cell at 100%; scales with the view. */
const GRID = 22;

type Gesture =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "drag"; ids: string[]; last: { x: number; y: number } }
  | { kind: "resize"; id: string; sx: number; sy: number; w: number; h: number }
  | { kind: "ink"; points: Point[] }
  | { kind: "link"; from: string };

/** The in-flight stroke or connector, drawn but not yet committed. */
type Preview = { ink: Point[] } | { link: { from: string; x: number; y: number } } | null;

/** What the eraser was clicked on. The canvas identifies it; the host decides
 *  what removing it means and says so. */
export type EraseTarget =
  | { kind: "object"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "group"; id: string };

export interface BoardCanvasProps {
  doc: BoardDoc;
  view: BoardView;
  setView: (view: BoardView) => void;
  tool: ToolId;
  activeLayer: LayerFocus;
  selection: BoardSelection;
  setSelection: (selection: BoardSelection) => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  /** True when the current edit was opened on a freshly created object, whose
   *  stand-in text should be selected rather than appended to. */
  editingSelectAll: boolean;
  /** Commit a document change. `withHistory: false` for the frames of a drag. */
  apply: (fn: (doc: BoardDoc) => BoardDoc, withHistory?: boolean) => void;
  /** Push one undo entry — called once at drag start, so a drag is one step. */
  snapshot: () => void;
  onCreate: (tool: ToolId, point: { x: number; y: number }) => void;
  onLink: (from: string, to: string) => void;
  /** Remove whatever the eraser was clicked on. */
  onErase: (target: EraseTarget) => void;
  onPromote: (sketchId: string) => void;
  onJump: (id: string) => void;
  sizes: BoardSizes;
  setSizes: (sizes: BoardSizes) => void;
  /** True while Space is held — pan in any tool. A ref, not state: it changes
   *  on keydown/keyup and must not re-render the canvas. */
  spaceRef: RefObject<boolean>;
  diffInfo: BoardDiffInfo;
  inkColor: string;
  /** While exporting: render ONLY these objects, at full strength. */
  exportIds: Set<string> | null;
}

export function BoardCanvas(props: BoardCanvasProps) {
  const {
    doc,
    view,
    setView,
    tool,
    activeLayer,
    selection,
    setSelection,
    editingId,
    setEditingId,
    editingSelectAll,
    apply,
    snapshot,
    onCreate,
    onLink,
    onErase,
    onPromote,
    onJump,
    sizes,
    setSizes,
    spaceRef,
    diffInfo,
    inkColor,
    exportIds,
  } = props;

  const t = useT();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Preview>(null);

  // The wheel handler and the move/up listeners are registered once, so they
  // must read the CURRENT view rather than the one captured at subscribe time.
  const viewRef = useRef(view);
  viewRef.current = view;

  /** True when `layer` is drawn at full strength. An export lights everything. */
  const lit = (layer: string) => !!exportIds || activeLayer === "all" || layer === activeLayer;

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (e.clientX - rect.left - v.x) / v.k, y: (e.clientY - rect.top - v.y) / v.k };
  };

  // --- measurement -----------------------------------------------------
  // No dependency array: any render may have changed a size (text edited, a
  // column added). Writes only on a real change, so this settles immediately.
  useLayoutEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const next = { ...sizes };
    let changed = false;
    world.querySelectorAll<HTMLElement>("[data-oid][data-measure]").forEach((el) => {
      const id = el.dataset.oid!;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!next[id] || next[id].w !== w || next[id].h !== h) {
        next[id] = { w, h };
        changed = true;
      }
    });
    if (changed) setSizes(next);
  });

  // --- wheel: pan, and ⌘/Ctrl-wheel (or pinch) zoom around the cursor ---
  // Registered natively because it must be non-passive to preventDefault — React
  // attaches wheel listeners as passive, which would let the page scroll.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        // Keep the point under the cursor fixed: solve for the translation that
        // leaves (mx,my) mapping to the same world point at the new scale.
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const k = clampZoom(v.k * Math.exp(-e.deltaY * 0.0018), ZOOM_MIN, ZOOM_MAX);
        setView({ k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k });
      } else {
        setView({ k: v.k, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // setView is a stable store/state setter for the board's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- the pointer state machine ---------------------------------------
  // Handlers live in refs behind two stable forwarders, so the window listeners
  // registered at pointerdown always run the latest closure without ever being
  // re-subscribed mid-drag.
  const onMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const onUpRef = useRef<(e: PointerEvent) => void>(() => {});
  const listeners = useRef({
    move: (e: PointerEvent) => onMoveRef.current(e),
    up: (e: PointerEvent) => onUpRef.current(e),
  }).current;

  onMoveRef.current = (e) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      setView({ k: viewRef.current.k, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy });
      return;
    }
    const p = toWorld(e);
    if (g.kind === "drag") {
      const dx = p.x - g.last.x;
      const dy = p.y - g.last.y;
      if (!dx && !dy) return;
      g.last = p;
      // No history: the snapshot was taken at drag start, so the whole drag is
      // one undo step rather than one per frame.
      apply((d) => moveObjects(d, g.ids, dx, dy), false);
    } else if (g.kind === "resize") {
      apply(
        (d) =>
          patchObject(d, g.id, {
            w: Math.max(FRAME_MIN_W, g.w + p.x - g.sx),
            h: Math.max(FRAME_MIN_H, g.h + p.y - g.sy),
          }),
        false,
      );
    } else if (g.kind === "ink") {
      const last = g.points[g.points.length - 1];
      if (!last) return;
      if (Math.hypot(p.x - last[0], p.y - last[1]) < INK_SAMPLE_PX / viewRef.current.k) return;
      g.points.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
      setPreview({ ink: [...g.points] });
    } else if (g.kind === "link") {
      setPreview({ link: { from: g.from, x: p.x, y: p.y } });
    }
  };

  onUpRef.current = (e) => {
    const g = gesture.current;
    gesture.current = null;
    window.removeEventListener("pointermove", listeners.move);
    if (!g) return;
    if (g.kind === "ink") {
      setPreview(null);
      // Two points is a tap, not a stroke — dropping it means a mis-click with
      // the pen selected leaves nothing behind.
      if (g.points.length > 2) {
        const id = uid("ink");
        apply((d) => ({
          ...d,
          objects: {
            ...d.objects,
            [id]: { id, type: "ink", layer: "domain", color: inkColor, points: g.points },
          },
          order: [...d.order, id],
        }));
      }
    } else if (g.kind === "link") {
      setPreview(null);
      // Hit-test where the pointer was released: the target is whatever object
      // element is under it, which is simpler and more forgiving than tracking
      // enter/leave across every object during the drag.
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const target = hit instanceof Element ? hit.closest<HTMLElement>("[data-oid]") : null;
      if (target && target.dataset.oid && target.dataset.oid !== g.from) {
        onLink(g.from, target.dataset.oid);
      }
    }
  };

  const begin = (e: { preventDefault: () => void }, next: Gesture) => {
    gesture.current = next;
    e.preventDefault();
    window.addEventListener("pointermove", listeners.move);
    window.addEventListener("pointerup", listeners.up, { once: true });
  };

  /**
   * Finish any in-place edit before a gesture changes the board.
   *
   * BLURRING, not clearing `editingId`. Clearing it re-renders without the
   * editor, which REMOVES the focused textarea from the DOM — and a removed
   * element fires no blur, so `BoardTextEditor`'s onBlur never runs and
   * everything typed is silently discarded. Blur, by contrast, dispatches
   * synchronously: the editor commits its text, and that commit is what clears
   * `editingId`.
   *
   * The browser would normally blur it for us when the pointer lands elsewhere,
   * but every gesture path here calls `preventDefault()` to stop text selection
   * mid-drag, and that suppresses the focus change along with it.
   */
  const commitEditing = () => {
    if (!editingId) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.classList.contains("bb-edit")) active.blur();
    else setEditingId(null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    const target = e.target as HTMLElement;
    // Form controls and anything marked no-drag (inline buttons, the inline
    // editor) own their own pointer behaviour.
    if (target.closest("textarea,input,select,[data-nodrag]")) return;

    const p = toWorld(e);
    const objectEl = target.closest<HTMLElement>("[data-oid]");
    const objectId = objectEl?.dataset.oid;
    const edgeId = target.closest<HTMLElement>("[data-eid]")?.dataset.eid;
    const handleId = target.closest<HTMLElement>("[data-handle]")?.dataset.handle;
    const groupId = target.closest<HTMLElement>("[data-gid]")?.dataset.gid;
    const v = viewRef.current;

    // Middle-click and Space always pan, whatever the tool.
    if (e.button === 1 || spaceRef.current) {
      return begin(e, { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y });
    }

    if (tool === "hand") {
      const group = groupId ? doc.groups.find((g) => g.id === groupId) : undefined;
      const ids = group
        ? group.ids.filter((id) => doc.objects[id])
        : objectId
          ? selection.ids.includes(objectId)
            ? selection.ids
            : [objectId]
          : null;
      if (ids && ids.length > 0) {
        commitEditing();
        snapshot();
        return begin(e, { kind: "drag", ids, last: p });
      }
      return begin(e, { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y });
    }

    // The eraser removes on press and starts no gesture. Group label first: it
    // sits above the members, and clicking it means "this whole group". Empty
    // space still pans, so the tool is never a dead end.
    if (tool === "eraser") {
      if (groupId) return onErase({ kind: "group", id: groupId });
      if (objectId) return onErase({ kind: "object", id: objectId });
      if (edgeId) return onErase({ kind: "edge", id: edgeId });
      return begin(e, { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y });
    }

    if (handleId) {
      const frame = doc.objects[handleId];
      if (frame && frame.type === "frame") {
        snapshot();
        return begin(e, {
          kind: "resize",
          id: frame.id,
          sx: p.x,
          sy: p.y,
          w: frame.w,
          h: frame.h,
        });
      }
    }

    if (tool === "select") {
      // A group LABEL selects and moves the whole group; the outline itself is
      // click-through, so members stay individually editable.
      if (groupId) {
        const group = doc.groups.find((g) => g.id === groupId);
        if (group) {
          const ids = group.ids.filter((id) => doc.objects[id]);
          setSelection({ ids, edge: null });
          commitEditing();
          snapshot();
          return begin(e, { kind: "drag", ids, last: p });
        }
      }
      if (objectId) {
        if (editingId === objectId) return;
        let ids = selection.ids;
        if (e.shiftKey) {
          ids = ids.includes(objectId) ? ids.filter((x) => x !== objectId) : [...ids, objectId];
        } else if (!ids.includes(objectId)) {
          ids = [objectId];
        }
        setSelection({ ids, edge: null });
        commitEditing();
        snapshot();
        return begin(e, { kind: "drag", ids, last: p });
      }
      if (edgeId) {
        setSelection({ ids: [], edge: edgeId });
        return;
      }
      setSelection({ ids: [], edge: null });
      commitEditing();
      return begin(e, { kind: "pan", sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y });
    }

    if (tool === "pen") {
      setPreview({ ink: [[p.x, p.y]] });
      return begin(e, { kind: "ink", points: [[p.x, p.y]] });
    }

    if (tool === "connector") {
      if (objectId) {
        setPreview({ link: { from: objectId, x: p.x, y: p.y } });
        return begin(e, { kind: "link", from: objectId });
      }
      return;
    }

    onCreate(tool, p);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-oid]");
    if (!el?.dataset.oid) return;
    const object = doc.objects[el.dataset.oid];
    if (object && isEditable(object)) setEditingId(object.id);
  };

  const commit = (id: string, patch: Partial<BoardObject>) => {
    setEditingId(null);
    apply((d) => patchObject(d, id, patch));
  };

  // --- what to draw ----------------------------------------------------
  const objects = doc.order
    .map((id) => doc.objects[id])
    .filter((o): o is BoardObject => Boolean(o))
    .filter((o) => !exportIds || exportIds.has(o.id));
  const frames = objects.filter((o) => o.type === "frame");
  const inks = objects.filter((o) => o.type === "ink");
  const rest = objects.filter((o) => o.type !== "frame" && o.type !== "ink");
  const selected = new Set(selection.ids);
  const classFor = (o: BoardObject, base: string) =>
    base + (selected.has(o.id) ? " sel" : "") + (lit(o.layer) ? "" : " dim");

  // Table cards by name, so a column's `fk` (a NAME) resolves to a card.
  const tablesByName: Record<string, TableObject> = {};
  for (const o of objects) if (o.type === "table") tablesByName[o.name] = o;

  const edges = doc.edges
    .map((edge) => {
      const a = doc.objects[edge.from];
      const b = doc.objects[edge.to];
      if (!a || !b) return null;
      if (exportIds && (!exportIds.has(edge.from) || !exportIds.has(edge.to))) return null;
      const from = boxOf(a, sizes);
      const to = boxOf(b, sizes);
      if (!from || !to) return null;
      const isFlow = a.type === "flow" && b.type === "flow";
      return {
        edge,
        path: edgePath(from, to),
        layer: edgeLayer(a, b),
        isFlow,
        width: isFlow ? volumeWidth(edge.label) : 1.4,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // FK relations are DERIVED every render (never stored), so a rename or a
  // delete can't leave a line pointing at nothing.
  const relations: { key: string; d: string }[] = [];
  for (const table of objects) {
    if (table.type !== "table") continue;
    for (const column of table.columns) {
      const target = column.fk ? tablesByName[column.fk] : undefined;
      if (!target || target.id === table.id) continue;
      const from = boxOf(table, sizes);
      const to = boxOf(target, sizes);
      if (from && to) relations.push({ key: table.id + column.name, d: edgePath(from, to).d });
    }
  }

  const renderObject = (o: BoardObject) => {
    const editing = editingId === o.id;
    if (o.type === "ink" || o.type === "frame") return null;
    const pos: CSSProperties = { left: o.x, top: o.y };

    if (o.type === "sticky") {
      return (
        <div
          key={o.id}
          data-oid={o.id}
          data-measure="1"
          className={classFor(o, "bb-sticky")}
          style={{ background: STICKY_COLORS[o.color], ...pos }}
        >
          <small>{o.tag}</small>
          {editing ? (
            <BoardTextEditor
              selectAll={editingSelectAll}
              value={o.text}
              className="hand"
              placeholder={t("board.ph.sticky")}
              onCommit={(text) => commit(o.id, { text })}
            />
          ) : (
            <div className="bb-sticky-t">
              {o.text || <span className="bb-ph">{t("board.ph.stickyEmpty")}</span>}
            </div>
          )}
        </div>
      );
    }

    if (o.type === "text") {
      return (
        <div
          key={o.id}
          data-oid={o.id}
          data-measure="1"
          className={classFor(o, "bb-text " + o.size)}
          style={pos}
        >
          {editing ? (
            <BoardTextEditor
              selectAll={editingSelectAll}
              value={o.text}
              className={o.size === "h1" ? "h1" : undefined}
              placeholder={t("board.ph.heading")}
              onCommit={(text) => commit(o.id, { text })}
            />
          ) : (
            o.text || <span className="bb-ph">{t("board.obj.text")}</span>
          )}
        </div>
      );
    }

    if (o.type === "sketch") {
      const promoted = o.promotedTo ? doc.objects[o.promotedTo] : undefined;
      return (
        <div
          key={o.id}
          data-oid={o.id}
          data-measure="1"
          className={classFor(o, "bb-sketch")}
          style={{ width: o.w, ...pos }}
        >
          {editing ? (
            <BoardTextEditor
              selectAll={editingSelectAll}
              className="hand"
              value={[o.title, ...o.lines].join("\n")}
              placeholder={t("board.ph.sketch")}
              onCommit={(text) => {
                const lines = text
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean);
                commit(o.id, { title: lines[0] || t("board.ph.untitled"), lines: lines.slice(1) });
              }}
            />
          ) : (
            <>
              <div className="bb-sketch-h">{o.title}</div>
              <ul>
                {o.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {o.lines.length === 0 ? (
                <div className="bb-ph" style={{ padding: "0 10px 8px" }}>
                  {t("board.ph.sketchEmpty")}
                </div>
              ) : null}
            </>
          )}
          {promoted && promoted.type === "table" ? (
            <button
              type="button"
              className="bb-linked"
              data-nodrag="1"
              onClick={() => onJump(promoted.id)}
              title={t("board.sketch.linkedTitle")}
            >
              <Icon name="table_view" size={13} />
              {promoted.name}
            </button>
          ) : (
            // `bb-noexport`: hover-only chrome, filtered out of an image export.
            <button
              type="button"
              className="bb-promote bb-noexport"
              data-nodrag="1"
              onClick={() => onPromote(o.id)}
            >
              <Icon name="upgrade" size={13} />
              {t("board.sketch.promote")}
            </button>
          )}
        </div>
      );
    }

    if (o.type === "snippet") {
      return (
        <div
          key={o.id}
          data-oid={o.id}
          data-measure="1"
          className={classFor(o, "bb-snip")}
          style={pos}
        >
          <div className="bb-snip-h">{o.title || t("board.obj.snippet")}</div>
          {editing ? (
            // Highlighted while typing, not just when read: a payload you are
            // in the middle of pasting is exactly when the colours help most.
            <BoardTextEditor
              selectAll={editingSelectAll}
              className="mono"
              value={o.body}
              highlight={(text) => <JsonText text={text} />}
              indentWithTab
              onCommit={(body) => commit(o.id, { body })}
            />
          ) : (
            <pre>
              <JsonText text={o.body || "{ }"} />
            </pre>
          )}
        </div>
      );
    }

    if (o.type === "flow") {
      const kind = FLOW_KINDS[o.kind] ?? FLOW_KINDS.process;
      return (
        <div
          key={o.id}
          data-oid={o.id}
          data-measure="1"
          className={classFor(o, "bb-flow")}
          style={{ "--fk": kind.color, ...pos } as CSSProperties}
        >
          <span className="bb-flow-k">
            <Icon name={kind.icon} size={13} />
            {t(kind.labelKey)}
          </span>
          {editing ? (
            <BoardTextEditor
              selectAll={editingSelectAll}
              value={o.name}
              onCommit={(name) => commit(o.id, { name: name || t(kind.labelKey) })}
            />
          ) : (
            <span className="bb-flow-n">{o.name}</span>
          )}
          <span className="bb-flow-d">{o.detail || " "}</span>
        </div>
      );
    }

    // table
    const status = diffInfo.status[o.id];
    const added = diffInfo.added[o.id] ?? new Set<string>();
    const typed = diffInfo.typed[o.id] ?? new Set<string>();
    return (
      <div
        key={o.id}
        data-oid={o.id}
        data-measure="1"
        className={classFor(o, "bb-table " + o.origin + (status === "changed" ? " changed" : ""))}
        style={pos}
      >
        <div className="bb-table-h">
          <Icon name={o.origin === "live" ? "table_rows" : "edit_square"} size={14} />
          <span className="bb-table-n">{o.name}</span>
          <em>{tableStateLabel(o, status)}</em>
        </div>
        <ul>
          {o.columns.map((column, i) => (
            <li
              key={column.name + i}
              className={
                (column.pk ? "pk " : "") +
                (added.has(column.name) ? "add " : "") +
                (typed.has(column.name) ? "mod" : "")
              }
            >
              <span className="bb-ci">
                {column.pk ? (
                  <Icon name="key" size={12} />
                ) : column.fk ? (
                  <Icon name="link" size={12} />
                ) : null}
              </span>
              <span className="bb-cn">{column.name}</span>
              <span className="bb-ct">
                {column.type}
                {column.fk ? " → " + column.fk : ""}
              </span>
            </li>
          ))}
          {o.columns.length === 0 ? <li className="bb-ph">{t("board.table.noColumns")}</li> : null}
        </ul>
      </div>
    );
  };

  // `.bb-root.hand` handles the grabbing state on :active, so the tool only
  // needs to declare its resting cursor here.
  const cursor =
    tool === "hand"
      ? "grab"
      : tool === "pen" || tool === "connector" || tool === "eraser"
        ? "crosshair"
        : tool === "select"
          ? "default"
          : "cell";

  return (
    <div
      ref={viewportRef}
      className="bb-viewport"
      style={{
        cursor,
        backgroundPosition: `${view.x}px ${view.y}px`,
        backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={worldRef}
        className="bb-world"
        style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }}
      >
        {doc.groups.map((group) => {
          // An export includes a group only when every member is in scope —
          // half a frame around half a diagram would be a lie.
          if (exportIds && !group.ids.every((id) => exportIds.has(id))) return null;
          const box = unionBox(
            group.ids.map((id) => boxOf(doc.objects[id], sizes)).filter((b) => b !== null),
          );
          if (!box) return null;
          // A group dims only when NONE of its members are on the focused layer.
          const groupLit = group.ids.some((id) => doc.objects[id] && lit(doc.objects[id].layer));
          const groupSelected =
            selection.ids.length === group.ids.length && group.ids.every((id) => selected.has(id));
          return (
            <div
              key={group.id}
              className={"bb-group" + (groupLit ? "" : " dim") + (groupSelected ? " gsel" : "")}
              style={
                {
                  left: box.x1 - GROUP_PAD,
                  top: box.y1 - GROUP_PAD,
                  width: box.x2 - box.x1 + GROUP_PAD * 2,
                  height: box.y2 - box.y1 + GROUP_PAD * 2,
                  "--gc": group.color,
                } as CSSProperties
              }
            >
              <div className="bb-group-l" data-gid={group.id} title={t("board.group.labelTitle")}>
                <Icon name="workspaces" size={13} />
                {group.name}
                <em>{group.ids.length}</em>
              </div>
            </div>
          );
        })}

        {frames.map((o) =>
          o.type === "frame" ? (
            <div
              key={o.id}
              data-oid={o.id}
              className={classFor(o, "bb-frame")}
              style={{ left: o.x, top: o.y, width: o.w, height: o.h }}
            >
              <div className="bb-frame-l">
                {editingId === o.id ? (
                  <BoardTextEditor
                    selectAll={editingSelectAll}
                    value={o.label}
                    onCommit={(label) => commit(o.id, { label: label || t("board.obj.frame") })}
                  />
                ) : (
                  o.label
                )}
              </div>
              {selected.has(o.id) ? <div className="bb-handle" data-handle={o.id} /> : null}
            </div>
          ) : null,
        )}

        <svg className="bb-svg">
          <defs>
            <marker
              id="bbArrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="10"
              markerHeight="10"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="#a9b1bf" />
            </marker>
            <marker
              id="bbFk"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path d="M1 1 L9 5 L1 9" fill="none" stroke="#2dd4a7" strokeWidth="1.4" />
            </marker>
          </defs>
          {relations.map((relation) => (
            <path
              key={relation.key}
              d={relation.d}
              className={"bb-rel" + (lit("schema") ? "" : " dim")}
              markerEnd="url(#bbFk)"
            />
          ))}
          {edges.map(({ edge, path, layer, isFlow, width }) => (
            <g
              key={edge.id}
              className={(lit(layer) ? "" : "dim") + (selection.edge === edge.id ? " sel" : "")}
            >
              {/* A 14px invisible path, so a 1.4px line is still clickable. */}
              <path d={path.d} className="bb-ehit" data-eid={edge.id} />
              <path
                d={path.d}
                className={"bb-edge" + (isFlow ? " flow" : "")}
                style={{ strokeWidth: width }}
                markerEnd="url(#bbArrow)"
              />
            </g>
          ))}
          {inks.map((o) =>
            o.type === "ink" ? (
              <g
                key={o.id}
                className={(lit(o.layer) ? "" : "dim") + (selected.has(o.id) ? " sel" : "")}
              >
                <path d={inkPath(o.points)} className="bb-inkhit" data-oid={o.id} />
                <path d={inkPath(o.points)} className="bb-ink" style={{ stroke: o.color }} />
              </g>
            ) : null,
          )}
          {preview && "ink" in preview ? (
            <path d={inkPath(preview.ink)} className="bb-ink" style={{ stroke: inkColor }} />
          ) : null}
          {preview && "link" in preview && doc.objects[preview.link.from]
            ? (() => {
                const from = boxOf(doc.objects[preview.link.from], sizes);
                if (!from) return null;
                const { x, y } = preview.link;
                return (
                  <path
                    d={edgePath(from, { x1: x, y1: y, x2: x, y2: y }).d}
                    className="bb-edge temp"
                    markerEnd="url(#bbArrow)"
                  />
                );
              })()
            : null}
        </svg>

        {/* Labels are HTML, not SVG text: they need a pill background that
            sizes to the text, which SVG cannot do. */}
        {edges
          .filter((x) => x.edge.label)
          .map(({ edge, path, layer }) => (
            <div
              key={"l" + edge.id}
              data-eid={edge.id}
              className={
                "bb-elabel" +
                (lit(layer) ? "" : " dim") +
                (selection.edge === edge.id ? " sel" : "")
              }
              style={{ left: path.mx, top: path.my }}
            >
              {edge.label}
            </div>
          ))}

        {rest.map(renderObject)}
      </div>
    </div>
  );
}
