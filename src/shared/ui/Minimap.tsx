// Minimap — a corner overview of a pan/zoom canvas. The whole content is drawn
// small, with the main view's visible area as a rectangle on top. Clicking a
// spot jumps the main view there; dragging (the rectangle or after a click)
// pans it live.
//
// The minimap knows nothing about how its host scrolls or transforms: the host
// gives it world rects, a `getViewport` that reads the visible world rect right
// now, and an `onNavigate` that puts a world point at the centre of the view.
// `watch` is the element whose scroll/resize moves the viewport without the host
// re-rendering (the schema map scrolls natively), so the minimap redraws itself
// for those instead of re-rendering the whole diagram per scroll frame.
//
// While a drag is in progress the fit is FROZEN at the one from pointerdown.
// The bounds include the viewport, so re-fitting each frame would rescale the
// map under the cursor as the view moves.

import { useEffect, useReducer, useRef, useState, type RefObject } from "react";

import { useT } from "../i18n/useT";
import { Icon } from "./Icon";
import {
  containsPoint,
  minimapFrame,
  toMinimap,
  toWorld,
  unionRects,
  type MinimapFrame,
  type MinimapRect,
} from "./minimapGeometry";
import "./Minimap.css";

const WIDTH = 200;
const HEIGHT = 130;
const PAD = 6;
const COLLAPSED_KEY = "bt.minimap.collapsed";

export interface MinimapItem extends MinimapRect {
  /** Fill (or stroke, for an outline). Defaults to the theme's muted card tone. */
  color?: string;
  /** Draw as a frame rather than a filled block — groups, frames. */
  outline?: boolean;
  /** Faded: present but not in focus. */
  dim?: boolean;
}

export interface MinimapProps {
  items: readonly MinimapItem[];
  /** The world rect the main view shows right now, or null before it is measured. */
  getViewport: () => MinimapRect | null;
  /** Put this world point at the centre of the main view. `jump` is a click on
   *  the map (the host may zoom in); `drag` is a live pan at the current zoom. */
  onNavigate: (point: { x: number; y: number }, gesture: "jump" | "drag") => void;
  /** The element whose scroll or resize changes the viewport. */
  watch?: RefObject<HTMLElement | null>;
  className?: string;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function Minimap({ items, getViewport, onNavigate, watch, className }: MinimapProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The fit frozen for the drag in progress (state, since render reads it) and
  // the grab offset from the cursor to the view's centre (handlers only).
  const [dragFrame, setDragFrame] = useState<MinimapFrame | null>(null);
  const grab = useRef({ dx: 0, dy: 0 });

  useEffect(() => {
    if (collapsed) return;
    const el = watch?.current;
    if (!el) return;
    let raf = 0;
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), redraw()));
    };
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [collapsed, watch]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage blocked: the toggle still works for this session.
    }
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className={"bt-minimap-show" + (className ? " " + className : "")}
        onClick={toggle}
        onPointerDown={(e) => e.stopPropagation()}
        title={t("minimap.show")}
      >
        <Icon name="map" size={16} />
      </button>
    );
  }

  const viewport = getViewport();
  const bounds = unionRects([...items, viewport]);
  const frame = dragFrame ?? (bounds ? minimapFrame(bounds, WIDTH, HEIGHT, PAD) : null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.stopPropagation();
    if (e.button !== 0 || !frame) return;
    const m = local(e);
    const p = toWorld(frame, m.x, m.y);
    const inside = viewport ? containsPoint(viewport, p.x, p.y) : false;
    if (inside && viewport) {
      // Grab the rectangle where it was pressed, so it doesn't snap its centre
      // to the cursor.
      grab.current = {
        dx: viewport.x + viewport.w / 2 - p.x,
        dy: viewport.y + viewport.h / 2 - p.y,
      };
    } else {
      grab.current = { dx: 0, dy: 0 };
      onNavigate(p, "jump");
    }
    setDragFrame(frame);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragFrame) return;
    const m = local(e);
    const p = toWorld(dragFrame, m.x, m.y);
    onNavigate({ x: p.x + grab.current.dx, y: p.y + grab.current.dy }, "drag");
  };

  // Dropping the frozen frame re-fits now that the view has settled.
  const endDrag = () => setDragFrame(null);

  const vp = frame && viewport ? toMinimap(frame, viewport) : null;

  return (
    <div
      className={"bt-minimap" + (className ? " " + className : "")}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <svg
        ref={svgRef}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label={t("minimap.label")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <title>{t("minimap.hint")}</title>
        {frame
          ? items.map((item, i) => {
              const r = toMinimap(frame, item);
              return (
                <rect
                  key={i}
                  x={r.x}
                  y={r.y}
                  width={Math.max(r.w, 1)}
                  height={Math.max(r.h, 1)}
                  rx={item.outline ? 2 : 1.5}
                  className={
                    "bt-minimap-item" +
                    (item.outline ? " is-outline" : "") +
                    (item.dim ? " is-dim" : "")
                  }
                  style={
                    item.color
                      ? item.outline
                        ? { stroke: item.color }
                        : { fill: item.color }
                      : undefined
                  }
                />
              );
            })
          : null}
        {vp ? (
          <rect
            className="bt-minimap-view"
            x={vp.x}
            y={vp.y}
            width={Math.max(vp.w, 2)}
            height={Math.max(vp.h, 2)}
            rx={2}
          />
        ) : null}
      </svg>
      <button type="button" className="bt-minimap-hide" onClick={toggle} title={t("minimap.hide")}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
