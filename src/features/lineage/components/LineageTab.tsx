// Row lineage (M50): one row and everything linked to it by declared foreign
// keys. The row in the middle, the rows it points at on the left, and on the
// right one stack per table of the rows that point at it — on a canvas you can
// pan, zoom and rearrange, with a side panel showing the selected card in full.
// "Walking" to any related row makes it the new centre.
//
// Ported from the prototype's `LineageTab` (lineage.jsx): the geometry, the
// canvas movement and the markup follow it exactly. What is new is loading —
// the prototype has every row in memory; here each piece streams in (see
// `load.ts`), so the centre card has a skeleton and each stack a shimmer and,
// on failure, its own Retry. Read-only throughout: dragging a card moves it on
// the canvas, never in the database.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Kbd } from "../../../shared/ui/Kbd";
import { fmtNumber } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { useWheelNavigation } from "../../../shared/hooks/useWheelNavigation";
import { clampZoom, zoomAt, type CanvasView } from "../../../shared/ui/canvasView";
import { CellContent } from "../../browse/shared/components/GridCell";
import { maskText, useMask } from "../../masking/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { isDataFileWorkspace, type Tab, type Workspace } from "../../workspaces/types";
import { graphOf, groupTotal, hueStyle, type Graph } from "../graph";
import { useLineage } from "../hooks/useLineage";
import { CHILD_LIMIT } from "../load";
import {
  CL_HALF,
  keyFull,
  keyText,
  columnsX,
  curve,
  dock,
  fitWorld,
  HERO_HALF,
  LN_W,
  lnHue,
  PN_HALF,
  put,
  spread,
  stackWidth,
  walk,
  worldHeight,
  ZOOM_LIMITS,
  type Offset,
} from "../model";
import { LnBadge, LnCopy, LnFields, LnHops } from "./LineageParts";
import "./LineageTab.css";

type LineageTabT = Extract<Tab, { kind: "lineage" }>;
type Translate = ReturnType<typeof useT>;

/** Arrow-key pan step, in screen pixels. */
const PAN_STEP = 60;
/** The centre card's colour: the app accent, not its table's. */
const ACCENT = { "--tc": "var(--accent)" } as CSSProperties;
/** Values in panel sentences are mono; this marks them inside a translation. */
const MARK = "\u0001";
const code = (s: string) => MARK + s + MARK;

/** A translated sentence with its `code(…)` parts drawn as `<code>`. */
function Coded({ text }: { text: string }) {
  return <>{text.split(MARK).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</>;
}

/** "Points at 1 row · 5 rows in 3 tables point at it · 1 broken reference". */
function sentence(g: Graph, t: Translate): string {
  const parts = [
    g.up ? t("lineage.sentence.up", { count: g.up }) : t("lineage.sentence.upNone"),
    g.down
      ? t("lineage.sentence.down", {
          rows: t("lineage.nRows", { count: g.down }),
          tables: t("lineage.nTables", { count: g.children.length }),
        })
      : t("lineage.sentence.downNone"),
  ];
  if (g.broken) parts.push(t("lineage.sentence.broken", { count: g.broken }));
  return parts.join(" · ");
}

export function LineageTab({ workspace, tab }: { workspace: Workspace; tab: LineageTabT }) {
  const t = useT();
  const maskKey = useMask();
  const at = Math.max(0, Math.min(tab.at, tab.trail.length - 1));
  // A tab always has its starting row; the fallback only satisfies the types.
  const focus = tab.trail[at] ?? { table: "", key: null };
  const { data, retryGroup } = useLineage(workspace.handleId, tab.schema, focus.table, focus.key);
  const g = useMemo(
    () => graphOf(data, maskText),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- maskKey: re-mask on a switch
    [data, maskKey],
  );
  const historyOk = workspace.kind === "sql" && !isDataFileWorkspace(workspace);
  const focusId = focus.table + "\u0000" + JSON.stringify(focus.key);

  // What the side panel shows: 'focus' | 'up-<col>' | 'dn-<table.col>'.
  const [sel, setSel] = useState("focus");
  // The card under the pointer — its link lights up.
  const [hot, setHot] = useState<string | null>(null);
  // A movable canvas, like the brainstorm board: pan, zoom, drag any card.
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, k: 1 });
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [moved, setMoved] = useState<Record<string, Offset>>({});
  const [dragging, setDragging] = useState<"pan" | "node" | null>(null);
  // Has the user panned or zoomed since the last fit?
  const [touched, setTouched] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { type: "pan"; sx: number; sy: number; vx: number; vy: number; on: boolean }
    | { type: "node"; id: string; sx: number; sy: number; o: Offset; on: boolean }
    | null
  >(null);
  const swallow = useRef(false);

  // A new centre row: the panel goes back to it, every card back in its place
  // (adjusting state on a prop change during render, not in an effect).
  const [lastFocus, setLastFocus] = useState(focusId);
  if (lastFocus !== focusId) {
    setLastFocus(focusId);
    setSel("focus");
    setHot(null);
    setMoved({});
    setTouched(false);
  }

  const go = (table: string, key: unknown) => {
    if (key === null || key === undefined) return;
    const next = walk(tab.trail, at, { table, key: key as LineageTabT["trail"][number]["key"] });
    if (next.at !== at || next.trail !== tab.trail) {
      useWorkspacesStore.getState().setLineageTrail(tab.id, next.trail, next.at);
    }
  };
  const jump = (i: number) => {
    if (i < 0 || i >= tab.trail.length || i === at) return;
    useWorkspacesStore.getState().setLineageTrail(tab.id, tab.trail, i);
  };
  const openIn = (table: string, col: string, value: unknown) =>
    useWorkspacesStore
      .getState()
      .openTableTabWithFilter(tab.schema, table, col, value as LineageTabT["trail"][number]["key"]);

  const ready = g !== null;
  const nUp = g ? g.parents.length : 0;
  const nDn = g ? g.children.length : 0;
  const H = g ? worldHeight(nUp, nDn) : 480;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setVp({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(read) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [ready]);

  // Fitted until the user pans or zooms: on open, on each walk, as the tab is
  // resized, and as stacks arrive and the world grows.
  const fitted = vp.w && vp.h ? fitWorld(vp.w, vp.h, H) : null;
  const shown = !touched && fitted ? fitted : view;
  const fit = () => setTouched(false);
  const moveView = (v: CanvasView) => {
    setTouched(true);
    setView(v);
  };
  useWheelNavigation(wrapRef, shown, moveView, ZOOM_LIMITS, ready);
  const zoomBy = (f: number) => {
    const k = clampZoom(shown.k * f, ZOOM_LIMITS);
    moveView(zoomAt(shown, k, vp.w / 2, vp.h / 2));
  };

  // Drag the background to pan, drag a card to move it. A press that does not
  // travel 5px stays a click, so cards remain clickable.
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if ((e.button !== 0 && e.button !== 1) || target.closest(".bb-zoom")) return;
    const nodeEl = e.button === 0 ? target.closest("[data-ln-node]") : null;
    if (nodeEl) {
      const id = nodeEl.getAttribute("data-ln-node") ?? "";
      drag.current = {
        type: "node",
        id,
        sx: e.clientX,
        sy: e.clientY,
        o: moved[id] ?? { dx: 0, dy: 0 },
        on: false,
      };
    } else {
      drag.current = {
        type: "pan",
        sx: e.clientX,
        sy: e.clientY,
        vx: shown.x,
        vy: shown.y,
        on: false,
      };
    }
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.on) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return;
      d.on = true;
      setDragging(d.type);
      try {
        wrapRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // A pointer that already ended cannot be captured; the drag still works.
      }
    }
    if (d.type === "pan") moveView({ k: shown.k, x: d.vx + dx, y: d.vy + dy });
    else {
      // Divided by the zoom, so the card stays under the pointer.
      const k = shown.k;
      setMoved((m) => ({ ...m, [d.id]: { dx: d.o.dx + dx / k, dy: d.o.dy + dy / k } }));
    }
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.on) return;
    try {
      wrapRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    setDragging(null);
    // The click that ends a drag selects nothing.
    swallow.current = true;
    window.setTimeout(() => {
      swallow.current = false;
    }, 0);
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const pan = (dx: number, dy: number) => {
      e.preventDefault();
      moveView({ ...shown, x: shown.x + dx, y: shown.y + dy });
    };
    if (e.key === "ArrowLeft") pan(PAN_STEP, 0);
    else if (e.key === "ArrowRight") pan(-PAN_STEP, 0);
    else if (e.key === "ArrowUp") pan(0, PAN_STEP);
    else if (e.key === "ArrowDown") pan(0, -PAN_STEP);
    else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomBy(1.2);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomBy(1 / 1.2);
    } else if (e.key === "0") {
      e.preventDefault();
      fit();
    }
  };

  // The panel's selection may name a card that vanished (a stack that turned
  // out empty); fall back to the centre.
  useEffect(() => {
    if (!g || sel === "focus") return;
    if (!g.parents.some((p) => p.id === sel) && !g.children.some((c) => c.id === sel)) {
      setSel("focus");
    }
  }, [g, sel]);

  const header = (stats: React.ReactNode) => (
    <div className="ln-head">
      <span className="ln-head-ic">
        <Icon name="hub" size={17} />
      </span>
      <div className="ln-trail" role="navigation" aria-label={t("lineage.trailAria")}>
        <button
          type="button"
          className="ln-back"
          disabled={at === 0}
          onClick={() => jump(at - 1)}
          title={t("lineage.back")}
          aria-label={t("lineage.back")}
        >
          <Icon name="arrow_back" size={15} />
        </button>
        {tab.trail.map((s, i) => (
          <span key={i} className="ln-crumb-wrap">
            {i ? <Icon name="chevron_right" size={13} className="ln-sep" /> : null}
            <button
              type="button"
              className={"ln-crumb" + (i === at ? " on" : "")}
              style={hueStyle(s.table)}
              aria-current={i === at ? "page" : undefined}
              onClick={() => jump(i)}
            >
              <i aria-hidden="true"></i>
              {s.table} <b title={keyFull(s.key)}>{keyText(s.key)}</b>
            </button>
          </span>
        ))}
      </div>
      {stats}
    </div>
  );

  if (data.status === "no-row" || data.status === "no-table" || data.status === "error") {
    const [title, body] =
      data.status === "no-row"
        ? [
            t("lineage.gone.title"),
            t("lineage.gone.body", { table: focus.table, key: String(focus.key) }),
          ]
        : data.status === "no-table"
          ? [t("lineage.noPk.title"), t("lineage.noPk.body")]
          : [t("lineage.err.title"), data.error ?? t("lineage.err.load")];
    return (
      <div className="ln">
        {header(null)}
        <div className="ln-gone" role="status">
          <Icon name={data.status === "error" ? "error" : "search_off"} size={28} />
          <div>{title}</div>
          <p>{body}</p>
        </div>
      </div>
    );
  }

  if (!g) {
    // Loading the centre row: a skeleton card where it will be.
    return (
      <div className="ln">
        {header(null)}
        <div className="ln-main">
          <div className="ln-view" ref={wrapRef} aria-busy="true">
            <div className="ln-skel" role="status" aria-label={t("lineage.loading")}>
              <span className="ln-skel-badge" />
              <span className="ln-skel-line w60" />
              <span className="ln-skel-line w80 tall" />
              <span className="ln-skel-line w40" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- geometry: the row in the middle, what it points at on the left, what
  // points at it on the right ----
  const W = LN_W;
  const cx = Math.round(W / 2);
  const cy = Math.round(H / 2);
  const hero = put(moved, "focus", cx, cy);
  const { xUp, xDn } = columnsX(W);
  // The column-name pills on the links need room between the cards.
  const roomy = W >= 940;
  const ups = g.parents.map((p, i) => ({
    p,
    hue: lnHue(p.refTable),
    ...put(moved, p.id, xUp, spread(nUp, i, H)),
  }));
  const dns = g.children.map((c, i) => ({
    c,
    hue: lnHue(c.table),
    ...put(moved, c.id, xDn, spread(nDn, i, H)),
  }));
  // Drawn from the row holding the foreign key to the row it points at, so the
  // travelling dots show direction: stack → centre, centre → parent.
  type Link = {
    id: string;
    hue: string;
    kind: string;
    label: string;
    w: number;
    xa: number;
    ya: number;
    xb: number;
    yb: number;
  };
  const links: Link[] = [
    ...ups.map((u, i) => ({
      id: u.p.id,
      hue: u.hue,
      kind:
        u.p.state === "ok" || u.p.state === "null" || u.p.state === "missing"
          ? u.p.state
          : "pending",
      label: u.p.col,
      w: 1.6,
      xa: hero.x - HERO_HALF,
      ya: dock(nUp, i, hero.y),
      xb: u.x + PN_HALF,
      yb: u.y,
    })),
    ...dns.map((n, i) => ({
      id: n.c.id,
      hue: n.hue,
      kind: n.c.status === "ready" ? "ok" : "pending",
      label: n.c.col,
      w: stackWidth(groupTotal(n.c)),
      xa: n.x - CL_HALF,
      ya: n.y,
      xb: hero.x + HERO_HALF,
      yb: dock(nDn, i, hero.y),
    })),
  ];
  const lit = (id: string) => hot === id || sel === id;
  const hover = (id: string) => ({
    onMouseEnter: () => setHot(id),
    onMouseLeave: () => setHot(null),
  });
  const selUp = ups.find((u) => u.p.id === sel);
  const selDn = dns.find((n) => n.c.id === sel);
  const ry = H / 2 - 38;
  const rx = Math.abs(cx - xUp);
  const stageStyle = {
    width: W,
    height: H,
    transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.k})`,
    // The centre row (its card, glow and orbits) wears the app accent; the rows
    // around it keep their table colours.
    "--fc": "var(--accent)",
    "--cx": hero.x + "px",
    "--cy": hero.y + "px",
  } as CSSProperties;
  const countText = (c: Graph["children"][number]) =>
    c.count !== null
      ? fmtNumber(c.count)
      : c.rows.length >= CHILD_LIMIT
        ? CHILD_LIMIT + "+"
        : String(c.rows.length);

  return (
    <div className="ln">
      {header(
        <div className="ln-stats" aria-label={sentence(g, t)} role="group">
          <span className="ln-stat">
            <b>{fmtNumber(g.up)}</b> {t("lineage.stat.up")}
          </span>
          <span className="ln-stat">
            <b>{fmtNumber(g.down)}</b> {t("lineage.stat.down")}
          </span>
          {g.broken ? (
            <span className="ln-stat warn">
              <Icon name="link_off" size={13} /> <b>{fmtNumber(g.broken)}</b>{" "}
              {t("lineage.stat.broken")}
            </span>
          ) : null}
        </div>,
      )}
      {/* A broken reference is announced, not only drawn in amber. */}
      <span className="ln-sr" role="status">
        {g.broken ? t("lineage.sentence.broken", { count: g.broken }) : ""}
      </span>

      <div className="ln-main">
        <div
          className={"ln-view" + (dragging ? " " + dragging : "")}
          ref={wrapRef}
          tabIndex={0}
          role="group"
          aria-label={t("lineage.canvasAria")}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
          onClickCapture={(e) => {
            if (swallow.current) {
              e.stopPropagation();
              e.preventDefault();
            }
          }}
          style={{
            backgroundPosition: shown.x + "px " + shown.y + "px",
            backgroundSize: 24 * shown.k + "px " + 24 * shown.k + "px",
          }}
        >
          <div className="ln-stage" key={focusId} style={stageStyle}>
            <div className="ln-glow" aria-hidden="true"></div>
            <svg className="ln-wires" width={W} height={H} aria-hidden="true">
              <ellipse className="ln-orbit" cx={hero.x} cy={hero.y} rx={rx} ry={ry} />
              <ellipse
                className="ln-orbit inner"
                cx={hero.x}
                cy={hero.y}
                rx={rx * 0.52}
                ry={ry * 0.52}
              />
              {links.map((k) => {
                const d = curve(k.xa, k.ya, k.xb, k.yb);
                return (
                  <g
                    key={k.id}
                    className={"ln-wire " + k.kind + (lit(k.id) ? " hot" : "")}
                    style={hueStyle(k.hue)}
                  >
                    <path className="ln-wire-base" d={d} strokeWidth={k.w} />
                    {k.kind === "ok" ? (
                      <path className="ln-wire-flow" d={d} strokeWidth={Math.max(2, k.w)} />
                    ) : null}
                    <circle className="ln-wire-end" cx={k.xa} cy={k.ya} r="3.5" />
                    <circle className="ln-wire-end" cx={k.xb} cy={k.yb} r="3.5" />
                  </g>
                );
              })}
            </svg>
            {roomy
              ? links.map((k) => (
                  <span
                    key={k.id}
                    className={"ln-edge " + k.kind + (lit(k.id) ? " hot" : "")}
                    style={{ left: (k.xa + k.xb) / 2, top: (k.ya + k.yb) / 2, ...hueStyle(k.hue) }}
                    aria-hidden="true"
                  >
                    {k.label}
                  </span>
                ))
              : null}

            {/* Each side's caption sits centred above its column's first card;
                it does not follow dragged cards. */}
            <span
              className="ln-side-h"
              style={{ left: xUp, top: (nUp ? spread(nUp, 0, H) : cy) - 82 }}
            >
              <Icon name="north_west" size={13} /> {t("lineage.side.up")} <b>{fmtNumber(g.up)}</b>
            </span>
            <span
              className="ln-side-h"
              style={{ left: xDn, top: (nDn ? spread(nDn, 0, H) : cy) - 82 }}
            >
              <Icon name="south_west" size={13} /> {t("lineage.side.down")}{" "}
              <b>{fmtNumber(g.down)}</b>
            </span>

            {/* ---- left: where this row points ---- */}
            {ups.map((u) => {
              const p = u.p;
              const style = { left: u.x, top: u.y, ...hueStyle(p.refTable) };
              if (p.state === "ok" && p.row) {
                return (
                  <div
                    key={p.id}
                    data-ln-node={p.id}
                    className={"ln-node ln-pn" + (sel === p.id ? " sel" : "")}
                    style={style}
                    {...hover(p.id)}
                  >
                    <button
                      type="button"
                      className="ln-node-main"
                      onClick={() => setSel(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          go(p.refTable, p.key);
                        }
                      }}
                      aria-pressed={sel === p.id}
                      aria-label={t("lineage.showRow", { table: p.refTable, key: keyText(p.key) })}
                    >
                      <span className="ln-node-top">
                        <LnBadge table={p.refTable} />
                        <span className="ln-t">{p.refTable}</span>
                        <span className="ln-k" title={keyFull(p.key)}>
                          {keyText(p.key)}
                        </span>
                      </span>
                      <span className="ln-label">
                        {p.label || (p.pk ?? p.refCol) + " " + keyText(p.key)}
                      </span>
                      <LnHops hops={p.hops} />
                    </button>
                    <button
                      type="button"
                      className="ln-node-go"
                      onClick={() => go(p.refTable, p.key)}
                      title={t("lineage.walkHint")}
                      aria-label={t("lineage.walkTo", { table: p.refTable, key: keyText(p.key) })}
                    >
                      <Icon name="arrow_outward" size={14} />
                    </button>
                  </div>
                );
              }
              if (p.state === "loading") {
                return (
                  <div
                    key={p.id}
                    data-ln-node={p.id}
                    className="ln-node ln-pn is-loading"
                    style={style}
                    aria-busy="true"
                  >
                    <span className="ln-node-top">
                      <LnBadge table={p.refTable} />
                      <span className="ln-t">{p.refTable}</span>
                    </span>
                    <span className="ln-shimmer w70" />
                  </div>
                );
              }
              const cls =
                p.state === "null" ? "is-null" : p.state === "missing" ? "is-broken" : "is-failed";
              return (
                <button
                  type="button"
                  key={p.id}
                  data-ln-node={p.id}
                  className={"ln-node ln-pn " + cls + (sel === p.id ? " sel" : "")}
                  style={style}
                  onClick={() => setSel(p.id)}
                  aria-pressed={sel === p.id}
                  {...hover(p.id)}
                >
                  <span className="ln-node-top">
                    {p.state === "null" ? (
                      <LnBadge table={p.refTable} />
                    ) : (
                      <Icon name={p.state === "missing" ? "link_off" : "error"} size={16} />
                    )}
                    <span className="ln-t">{p.refTable}</span>
                    {p.state !== "null" ? (
                      <span className="ln-k" title={maskText(p.value, p.col)}>
                        {keyText(maskText(p.value, p.col))}
                      </span>
                    ) : null}
                  </span>
                  <span className="ln-note">
                    {p.state === "null"
                      ? t("lineage.notLinked")
                      : p.state === "missing"
                        ? t("lineage.broken")
                        : t("lineage.unresolved")}
                  </span>
                </button>
              );
            })}
            {!nUp ? (
              <div className="ln-ghost" style={{ left: xUp, top: cy }}>
                {t("lineage.ghost.up", { table: g.table })}
              </div>
            ) : null}

            {/* ---- centre: the row itself ---- */}
            {/* A card, not a button, so the id can have its own copy button: the
                transparent button under the content is what selects it. */}
            <div
              data-ln-node="focus"
              className={"ln-node ln-hero" + (sel === "focus" ? " sel" : "")}
              style={{ left: hero.x, top: hero.y, ...ACCENT }}
            >
              <button
                type="button"
                className="ln-hero-hit"
                onClick={() => setSel("focus")}
                aria-pressed={sel === "focus"}
                aria-label={t("lineage.showRow", { table: g.table, key: keyText(g.key) })}
              />
              <LnBadge table={g.table} size="xl" accent />
              <span className="ln-hero-t">
                {g.table}{" "}
                <span className="ln-k" title={keyFull(g.key)}>
                  {g.pk} {keyText(g.key)}
                </span>
                <LnCopy
                  className="ln-key-copy"
                  size={12}
                  text={keyFull(g.key)}
                  title={t("lineage.copy", { col: g.pk })}
                  label={t("lineage.copyAria", { col: g.pk })}
                />
              </span>
              <span className="ln-hero-label">
                {g.label.text || g.table + " " + keyText(g.key)}
              </span>
              {g.facts.length ? (
                <span className="ln-hero-facts">
                  {g.facts.map((c) => (
                    <span key={c}>
                      <em>{c}</em>
                      <CellContent value={g.row[c] ?? null} column={c} />
                    </span>
                  ))}
                </span>
              ) : null}
            </div>

            {/* ---- right: what points at this row ---- */}
            {dns.map((n) => {
              const c = n.c;
              const loading = c.status === "loading";
              const failed = c.status === "error";
              const total = groupTotal(c);
              return (
                <div
                  key={c.id}
                  data-ln-node={c.id}
                  className={"ln-deck" + (sel === c.id ? " sel" : "") + (loading ? " loading" : "")}
                  style={{ left: n.x, top: n.y, ...hueStyle(c.table) }}
                  {...hover(c.id)}
                >
                  {/* The cards underneath: one per extra row, two at most. */}
                  {total > 2 ? (
                    <span className="ln-deck-card back" aria-hidden="true"></span>
                  ) : null}
                  {total > 1 ? <span className="ln-deck-card" aria-hidden="true"></span> : null}
                  <button
                    type="button"
                    className={
                      "ln-node ln-cl" + (sel === c.id ? " sel" : "") + (failed ? " is-failed" : "")
                    }
                    onClick={() => setSel(c.id)}
                    aria-pressed={sel === c.id}
                    aria-busy={loading || undefined}
                    aria-label={
                      loading
                        ? t("lineage.showStackLoading", { table: c.table })
                        : t("lineage.showStack", { count: total, table: c.table })
                    }
                  >
                    <span className="ln-node-top">
                      <LnBadge table={c.table} />
                      <span className="ln-t">{c.table}</span>
                      {c.status === "ready" ? (
                        <span
                          className="ln-count"
                          title={
                            c.countState === "unavailable"
                              ? t("lineage.countUnavailable")
                              : undefined
                          }
                        >
                          {countText(c)}
                        </span>
                      ) : null}
                    </span>
                    {loading ? (
                      <span className="ln-cl-prev">
                        <span className="ln-shimmer w80" />
                        <span className="ln-shimmer w60" />
                      </span>
                    ) : failed ? (
                      <span className="ln-cl-prev">
                        <span className="ln-cl-err">{c.error ?? t("lineage.err.load")}</span>
                      </span>
                    ) : (
                      <span className="ln-cl-prev">
                        {c.rows.slice(0, 2).map((r, i) => (
                          <span key={i}>
                            {r.label || r.hops[0]?.label || (c.pk ?? "") + " " + keyText(r.key)}
                          </span>
                        ))}
                        {c.count === null && c.countState === "unavailable" ? (
                          <span className="more">{t("lineage.countUnavailable")}</span>
                        ) : total > 2 ? (
                          <span className="more">
                            {t("lineage.more", { count: fmtNumber(total - 2) })}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </button>
                  {failed ? (
                    <button type="button" className="ln-retry" onClick={() => retryGroup(c.index)}>
                      <Icon name="refresh" size={13} /> {t("lineage.retry")}
                    </button>
                  ) : null}
                </div>
              );
            })}
            {!nDn ? (
              <div className="ln-ghost" style={{ left: xDn, top: cy }}>
                {t("lineage.ghost.down")}
              </div>
            ) : null}
          </div>

          <div className="bb-zoom ln-zoom">
            <button
              type="button"
              onClick={() => zoomBy(1 / 1.2)}
              disabled={shown.k <= ZOOM_LIMITS.min + 0.01}
              title={t("lineage.zoom.out")}
              aria-label={t("lineage.zoom.out")}
            >
              <Icon name="remove" size={16} />
            </button>
            <button
              type="button"
              className="ln-zoom-pct"
              onClick={() => zoomBy(1 / shown.k)}
              title={t("lineage.zoom.reset")}
            >
              {Math.round(shown.k * 100)}%
            </button>
            <button
              type="button"
              onClick={() => zoomBy(1.2)}
              disabled={shown.k >= ZOOM_LIMITS.max - 0.01}
              title={t("lineage.zoom.in")}
              aria-label={t("lineage.zoom.in")}
            >
              <Icon name="add" size={16} />
            </button>
            <button
              type="button"
              onClick={fit}
              title={t("lineage.zoom.fit")}
              aria-label={t("lineage.zoom.fitAria")}
            >
              <Icon name="fit_screen" size={16} />
            </button>
            {Object.keys(moved).length ? (
              <button
                type="button"
                onClick={() => setMoved({})}
                title={t("lineage.zoom.layout")}
                aria-label={t("lineage.zoom.layoutAria")}
              >
                <Icon name="restart_alt" size={16} />
              </button>
            ) : null}
          </div>
          <div className="ln-hint" aria-hidden="true">
            {t("lineage.hint.pre")} <Kbd>⌘</Kbd> {t("lineage.hint.post")}
          </div>
        </div>

        {/* ---- side panel: the selected card in full ---- */}
        <aside className="ln-panel" aria-live="polite" aria-label={t("lineage.panelAria")}>
          {selUp && selUp.p.state === "ok" && selUp.p.row ? (
            <>
              <div className="ln-panel-h" style={hueStyle(selUp.p.refTable)}>
                <LnBadge table={selUp.p.refTable} size="lg" />
                <div>
                  <span className="ln-t">{selUp.p.refTable}</span>
                  <span className="ln-sub">
                    {t("lineage.panel.pointedBy")} <code>{selUp.p.col}</code>
                  </span>
                </div>
              </div>
              {selUp.p.label ? <div className="ln-panel-title">{selUp.p.label}</div> : null}
              <LnFields
                columns={data.shapes[selUp.p.refTable]?.columns ?? []}
                row={selUp.p.row}
                fkCols={data.shapes[selUp.p.refTable]?.fks.map((f) => f.col) ?? []}
                limit={12}
              />
              <div className="ln-actions">
                <Btn
                  small
                  variant="filled"
                  icon="arrow_outward"
                  onClick={() => go(selUp.p.refTable, selUp.p.key)}
                >
                  {t("lineage.panel.walk")}
                </Btn>
                <Btn
                  small
                  variant="text"
                  icon="table_rows"
                  onClick={() => openIn(selUp.p.refTable, selUp.p.refCol, selUp.p.value)}
                >
                  {t("lineage.panel.openInTable")}
                </Btn>
              </div>
            </>
          ) : selUp ? (
            <>
              <div className="ln-panel-h" style={hueStyle(selUp.p.refTable)}>
                <LnBadge table={selUp.p.refTable} size="lg" />
                <div>
                  <span className="ln-t">{selUp.p.refTable}</span>
                  <span className="ln-sub">
                    {t("lineage.panel.through")} <code>{selUp.p.col}</code>
                  </span>
                </div>
              </div>
              {selUp.p.state === "null" ? (
                <p className="ln-panel-p">
                  <b>{t("lineage.notLinked")}.</b>{" "}
                  <Coded
                    text={t("lineage.panel.nullBody", {
                      col: code(selUp.p.col),
                      table: selUp.p.refTable,
                    })}
                  />
                </p>
              ) : selUp.p.state === "missing" ? (
                <p className="ln-panel-p warn">
                  <Icon name="link_off" size={15} />
                  <span>
                    <b>{t("lineage.broken")}.</b>{" "}
                    <Coded
                      text={t("lineage.panel.brokenBody", {
                        col: code(selUp.p.col),
                        value: maskText(selUp.p.value, selUp.p.col),
                        table: selUp.p.refTable,
                        refCol: selUp.p.refCol,
                      })}
                    />
                  </span>
                </p>
              ) : (
                <p className="ln-panel-p">
                  {selUp.p.state === "loading"
                    ? t("lineage.panel.loadingRow")
                    : t("lineage.panel.unresolvedBody", {
                        table: selUp.p.refTable,
                        refCol: selUp.p.refCol,
                        value: maskText(selUp.p.value, selUp.p.col),
                      })}
                </p>
              )}
            </>
          ) : selDn ? (
            <>
              <div className="ln-panel-h" style={hueStyle(selDn.c.table)}>
                <LnBadge table={selDn.c.table} size="lg" />
                <div>
                  <span className="ln-t">{selDn.c.table}</span>
                  <span className="ln-sub">
                    <Coded
                      text={t("lineage.panel.stackSub", {
                        rows:
                          selDn.c.count === null
                            ? t("lineage.panel.someRows")
                            : t("lineage.nRows", { count: selDn.c.count }),
                        col: code(selDn.c.col),
                      })}
                    />
                  </span>
                </div>
              </div>
              {selDn.c.status === "loading" ? (
                <p className="ln-panel-p">{t("lineage.panel.loadingRows")}</p>
              ) : selDn.c.status === "error" ? (
                <div className="ln-panel-p warn">
                  <Icon name="error" size={15} />
                  <span>
                    {selDn.c.error ?? t("lineage.err.load")}{" "}
                    <Btn
                      small
                      variant="text"
                      icon="refresh"
                      onClick={() => retryGroup(selDn.c.index)}
                    >
                      {t("lineage.retry")}
                    </Btn>
                  </span>
                </div>
              ) : (
                <div className="ln-rows">
                  {selDn.c.rows.map((r, i) => (
                    <button
                      type="button"
                      key={i}
                      className="ln-row"
                      style={hueStyle(selDn.c.table)}
                      disabled={r.key === null}
                      onClick={() => go(selDn.c.table, r.key)}
                      aria-label={t("lineage.walkTo", {
                        table: selDn.c.table,
                        key: keyText(r.key),
                      })}
                    >
                      <span className="ln-k" title={keyFull(r.key)}>
                        {r.key === null ? "·" : keyText(r.key)}
                      </span>
                      <span className="ln-row-main">
                        {r.label ? <span className="ln-label">{r.label}</span> : null}
                        <LnHops hops={r.hops} />
                        {r.facts.length ? (
                          <span className="ln-facts">
                            {r.facts.map((f) => (
                              <span key={f}>
                                {f} <CellContent value={r.row[f] ?? null} column={f} />
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </span>
                      <Icon name="arrow_outward" size={13} className="ln-go" />
                    </button>
                  ))}
                </div>
              )}
              {selDn.c.status === "ready" &&
              selDn.c.count === null &&
              selDn.c.countState === "unavailable" ? (
                <div className="ln-panel-note">
                  {t("lineage.panel.countUnavailableBody", { shown: selDn.c.rows.length })}
                </div>
              ) : selDn.c.count !== null && selDn.c.count > selDn.c.rows.length ? (
                <div className="ln-panel-note">
                  {t("lineage.panel.showing", {
                    shown: selDn.c.rows.length,
                    count: fmtNumber(selDn.c.count),
                  })}
                </div>
              ) : null}
              <div className="ln-actions">
                <Btn
                  small
                  variant="tonal"
                  icon="table_rows"
                  onClick={() => openIn(selDn.c.table, selDn.c.col, selDn.c.value)}
                >
                  {selDn.c.count === 1
                    ? t("lineage.panel.openIt", { table: selDn.c.table })
                    : selDn.c.count === null
                      ? t("lineage.panel.openRows", { table: selDn.c.table })
                      : t("lineage.panel.openAll", {
                          count: fmtNumber(selDn.c.count),
                          table: selDn.c.table,
                        })}
                </Btn>
              </div>
            </>
          ) : (
            <>
              <div className="ln-panel-h" style={ACCENT}>
                <LnBadge table={g.table} size="lg" accent />
                <div>
                  <span className="ln-t">{g.table}</span>
                  <span className="ln-sub">
                    {t("lineage.panel.centreSub", { pk: g.pk, key: keyText(g.key) })}
                  </span>
                </div>
              </div>
              {g.label.text ? <div className="ln-panel-title">{g.label.text}</div> : null}
              <LnFields columns={g.columns} row={g.row} fkCols={g.fkCols} />
              <div className="ln-actions">
                <Btn
                  small
                  variant="tonal"
                  icon="table_rows"
                  onClick={() => openIn(g.table, g.pk, g.key)}
                >
                  {t("lineage.panel.openIn", { table: g.table })}
                </Btn>
                {historyOk ? (
                  <Btn
                    small
                    variant="text"
                    icon="history"
                    onClick={() =>
                      useWorkspacesStore.getState().openHistoryTab({
                        filter: { table: g.table, key: [g.key], pk: [g.pk] },
                        focus: "latest",
                      })
                    }
                  >
                    {t("lineage.panel.changes")}
                  </Btn>
                ) : null}
              </div>
              {g.empty.length ? (
                <div className="ln-panel-note">
                  {t("lineage.panel.empty")}{" "}
                  <span className="mono">
                    {g.empty.map((e) => e.table + "." + e.col).join(", ")}
                  </span>
                </div>
              ) : null}
            </>
          )}
          <div className="ln-panel-foot">
            <Icon name="info" size={13} /> {t("lineage.panel.foot")}
          </div>
        </aside>
      </div>
    </div>
  );
}
