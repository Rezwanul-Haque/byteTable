// Hand-drawn arrows for the schema map: a directed annotation from one thing on
// the canvas to another — a group frame or a single table card, in any
// combination ("Billing → Auth", "Billing → events").
//
// WHY THESE ARE NOT FK EDGES. An FK edge is a derived fact — introspection says
// orders.user_id references users, and the diagram has no say in it. An arrow
// drawn here is the opposite: nothing in the schema implies it, so it is user
// data, stored verbatim with the layout.
//
// THE ENDPOINTS ARE IDENTITIES, NOT POINTS: a group id or a table name, tagged
// with which. Where an arrow attaches is computed from the two boxes on every
// render (their facing sides), so moving or resizing either end re-routes the
// arrow with nothing to keep in sync — the same stance groups.ts takes on
// membership. The only stored geometry is the bend, and it is stored RELATIVE to
// the arrow's midpoint, so a bent arrow keeps its shape when either end moves.
//
// NAMING: the stored field is still `groupLinks` and the type still `GroupLink`
// — arrows began as group-to-group only, and renaming the persisted key would
// orphan every saved layout for no gain. An endpoint's `kind` is what says
// whether it is a frame or a card.
//
// Pure module: no React, no DOM, no IPC. {@link GroupLink} is a structural
// mirror of api.ts's wire type (the same split groups.ts keeps for TableGroup).

import type { CardModel } from "./diagram";
import type { GroupBox, GroupRect } from "./groups";

/** What an arrow's endpoint names: a group frame, or one table's card. */
export type LinkEndKind = "group" | "table";

/** One end of an arrow — the kind says how to read the id. */
export interface LinkEnd {
  kind: LinkEndKind;
  /** A group id, or a table name. */
  id: string;
}

/** One user-drawn arrow. Persisted verbatim in `MapLayout.groupLinks`. */
export interface GroupLink {
  /** Stable id (the selection key). */
  id: string;
  /** Source — the tail of the arrow: a group id, or a table name. */
  from: string;
  /** Target — the head of the arrow. */
  to: string;
  /** How to read `from` / `to`. Absent means `"group"`: arrows predate table
   *  endpoints, and every arrow saved back then joined two frames. */
  fromKind?: LinkEndKind;
  toKind?: LinkEndKind;
  /** Optional caption drawn at the arrow's midpoint ("writes to", "ETL", …). */
  label?: string;
  /** Bend offset, relative to the midpoint of the straight chord between the
   *  two anchors. Absent/zero = the default curve. */
  dx?: number;
  dy?: number;
}

/** Read one end of a stored arrow (defaulting its kind). */
export function linkEnd(link: GroupLink, which: "from" | "to"): LinkEnd {
  return which === "from"
    ? { kind: link.fromKind ?? "group", id: link.from }
    : { kind: link.toKind ?? "group", id: link.to };
}

/** Two endpoints naming the same thing. */
export function sameEnd(a: LinkEnd, b: LinkEnd): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** An arrow resolved to drawable geometry for one render. */
export interface GroupLinkModel {
  id: string;
  from: LinkEnd;
  to: LinkEnd;
  /** Endpoint names (a group's name, or the table's), for the selection bar
   *  and the arrow's tooltip. */
  fromName: string;
  toName: string;
  /** Caption, or "" when the arrow is unlabelled. */
  label: string;
  /** The source end's colour — its frame's, or the frame it sits in, so an
   *  arrow reads as leaving that domain. */
  color: string;
  /** SVG path `d` for the curve. */
  path: string;
  /** SVG path `d` for the filled arrowhead at the target end. */
  head: string;
  /** Tail anchor (on the source frame's facing side). */
  sx: number;
  sy: number;
  /** Head anchor (on the target frame's facing side). */
  tx: number;
  ty: number;
  /** Bend-handle position: the chord midpoint plus any stored offset. */
  mx: number;
  my: number;
  /** True once the arrow carries a bend offset. */
  bent: boolean;
}

/** How far a control handle reaches out of a frame, at minimum. */
const REACH_MIN = 48;
/** Arrowhead length along the line, and half its width across it. */
const HEAD_LEN = 13;
const HEAD_SPREAD = 5.5;
/** How far from a frame's corner an anchor may sit, so an arrow never attaches
 *  at the rounded corner itself. Capped at a third of the side for small frames. */
const ANCHOR_INSET = 18;

/** Round to 2dp — keeps emitted path strings short and comparable. */
const r = (v: number): number => Math.round(v * 100) / 100;

/** Slide `v` along a frame side that starts at `start` and runs `len`, keeping
 *  it clear of both corners. */
function alongSide(v: number, start: number, len: number): number {
  const inset = Math.min(ANCHOR_INSET, len / 3);
  return Math.max(start + inset, Math.min(start + len - inset, v));
}

/** The two anchors plus the outward unit normal at each (the direction the line
 *  leaves its frame), picked from how the frames sit relative to each other. */
interface Anchors {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  nsx: number;
  nsy: number;
  ntx: number;
  nty: number;
}

/**
 * Pick the facing sides of two frames: left/right when the frames are further
 * apart horizontally than vertically, top/bottom otherwise (gaps compared, not
 * centres, so a tall frame beside a short one still connects side-to-side).
 *
 * The anchor slides along the chosen side to the midpoint between the two frame
 * centres, clamped inside the side — so frames that overlap on that axis get a
 * near-straight arrow rather than one that dives to a centre and back.
 */
function anchors(a: GroupRect, b: GroupRect): Anchors {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const hGap = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const vGap = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (hGap >= vGap) {
    const dir = bcx >= acx ? 1 : -1;
    const y = (acy + bcy) / 2;
    return {
      sx: dir > 0 ? a.x + a.w : a.x,
      sy: alongSide(y, a.y, a.h),
      tx: dir > 0 ? b.x : b.x + b.w,
      ty: alongSide(y, b.y, b.h),
      nsx: dir,
      nsy: 0,
      ntx: -dir,
      nty: 0,
    };
  }
  const dir = bcy >= acy ? 1 : -1;
  const x = (acx + bcx) / 2;
  return {
    sx: alongSide(x, a.x, a.w),
    sy: dir > 0 ? a.y + a.h : a.y,
    tx: alongSide(x, b.x, b.w),
    ty: dir > 0 ? b.y : b.y + b.h,
    nsx: 0,
    nsy: dir,
    ntx: 0,
    nty: -dir,
  };
}

/**
 * The filled arrowhead at `(x,y)`, pointing along `angle` (radians). A path
 * rather than an SVG `<marker>`: markers inherit nothing useful per-arrow (each
 * arrow carries its group's colour) and would need one `<marker>` per colour in
 * both the live canvas and the standalone export.
 */
export function arrowHead(x: number, y: number, angle: number): string {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const bx = x - cos * HEAD_LEN;
  const by = y - sin * HEAD_LEN;
  const px = -sin * HEAD_SPREAD;
  const py = cos * HEAD_SPREAD;
  return `M ${r(x)} ${r(y)} L ${r(bx + px)} ${r(by + py)} ` + `L ${r(bx - px)} ${r(by - py)} Z`;
}

/** What {@link linkGeometry} resolves — the drawable half of a link model. */
export interface GroupLinkGeometry {
  path: string;
  head: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  mx: number;
  my: number;
}

/**
 * Curve + arrowhead between two frames. `offset` bends the curve by moving its
 * midpoint; with no offset it is a single cubic whose control handles reach
 * straight out of each frame, with one it routes as two cubics meeting at the
 * handle (the shape FK edges use for a dragged bend, so both read the same).
 *
 * `b` may be a zero-size rect — that is how the live "drawing an arrow" preview
 * aims at the pointer.
 */
export function linkGeometry(
  a: GroupRect,
  b: GroupRect,
  offset?: { dx: number; dy: number } | null,
): GroupLinkGeometry {
  const an = anchors(a, b);
  const dx = offset?.dx ?? 0;
  const dy = offset?.dy ?? 0;
  const mx = (an.sx + an.tx) / 2 + dx;
  const my = (an.sy + an.ty) / 2 + dy;
  const reach = Math.max(REACH_MIN, Math.round(Math.hypot(an.tx - an.sx, an.ty - an.sy) / 3));
  const c1x = an.sx + an.nsx * reach;
  const c1y = an.sy + an.nsy * reach;
  const c2x = an.tx + an.ntx * reach;
  const c2y = an.ty + an.nty * reach;
  const path =
    dx === 0 && dy === 0
      ? `M ${r(an.sx)} ${r(an.sy)} C ${r(c1x)} ${r(c1y)}, ${r(c2x)} ${r(c2y)}, ${r(an.tx)} ${r(an.ty)}`
      : // Through the handle: endpoints keep their outward tangents, and the join
        // at the handle runs parallel to the chord so the bend never kinks.
        `M ${r(an.sx)} ${r(an.sy)} ` +
        `C ${r(c1x)} ${r(c1y)}, ${r(mx - (an.tx - an.sx) / 4)} ${r(my - (an.ty - an.sy) / 4)}, ${r(mx)} ${r(my)} ` +
        `C ${r(mx + (an.tx - an.sx) / 4)} ${r(my + (an.ty - an.sy) / 4)}, ${r(c2x)} ${r(c2y)}, ${r(an.tx)} ${r(an.ty)}`;
  return {
    path,
    // Along the incoming tangent — the last control point is what the curve
    // arrives from in both the bent and unbent routings.
    head: arrowHead(an.tx, an.ty, Math.atan2(an.ty - c2y, an.tx - c2x)),
    sx: an.sx,
    sy: an.sy,
    tx: an.tx,
    ty: an.ty,
    mx,
    my,
  };
}

/** A fresh arrow id — timestamp + random, like group ids, so ids stay unique
 *  across sessions. */
export function newGroupLinkId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** An existing arrow between these two endpoints, in EITHER direction (null
 *  when there is none). Direction-insensitive on purpose — see
 *  {@link createGroupLink}. A frame and a card inside it are different
 *  endpoints, so both can carry their own arrow. */
export function findGroupLink(links: GroupLink[], a: LinkEnd, b: LinkEnd): GroupLink | null {
  return (
    links.find((l) => {
      const from = linkEnd(l, "from");
      const to = linkEnd(l, "to");
      return (sameEnd(from, a) && sameEnd(to, b)) || (sameEnd(from, b) && sameEnd(to, a));
    }) ?? null
  );
}

/**
 * Draw an arrow between two endpoints — either of them a group frame or a table
 * card. Returns null when there is nothing to draw: an endpoint pointing at
 * itself, or a pair that is already joined.
 *
 * One arrow per PAIR, not per direction: a second arrow between the same two
 * things would route along the identical curve and simply hide the first.
 * Changing an arrow's direction is what {@link flipGroupLink} is for. Any
 * number of arrows may fan out of one endpoint to DIFFERENT ones.
 */
export function createGroupLink(
  links: GroupLink[],
  from: LinkEnd,
  to: LinkEnd,
): { links: GroupLink[]; link: GroupLink } | null {
  if (sameEnd(from, to) || findGroupLink(links, from, to)) return null;
  const link: GroupLink = {
    id: newGroupLinkId(),
    from: from.id,
    to: to.id,
    // Only a table endpoint carries a kind: "group" is the default, so a
    // group-to-group arrow stays exactly the shape it has always been saved as.
    ...(from.kind === "table" ? { fromKind: "table" as const } : {}),
    ...(to.kind === "table" ? { toKind: "table" as const } : {}),
  };
  return { links: [...links, link], link };
}

/** Remove one arrow. */
export function removeGroupLink(links: GroupLink[], id: string): GroupLink[] {
  return links.filter((l) => l.id !== id);
}

/** Reverse an arrow's direction. The bend is stored relative to the chord's
 *  midpoint, which is the same point either way round, so it carries over. */
export function flipGroupLink(links: GroupLink[], id: string): GroupLink[] {
  return links.map((l) =>
    l.id === id ? { ...l, from: l.to, to: l.from, fromKind: l.toKind, toKind: l.fromKind } : l,
  );
}

/** Caption an arrow. A blank label clears it (and is dropped from the saved
 *  layout) rather than drawing an empty pill. */
export function labelGroupLink(links: GroupLink[], id: string, label: string): GroupLink[] {
  const trimmed = label.trim();
  return links.map((l) =>
    l.id === id ? { ...l, label: trimmed ? trimmed.slice(0, 40) : undefined } : l,
  );
}

/** Apply a bend offset to one arrow. */
export function bendGroupLink(links: GroupLink[], id: string, dx: number, dy: number): GroupLink[] {
  return links.map((l) => (l.id === id ? { ...l, dx, dy } : l));
}

/** Straighten one arrow back to its default curve. */
export function straightenGroupLink(links: GroupLink[], id: string): GroupLink[] {
  return links.map((l) => (l.id === id ? { ...l, dx: undefined, dy: undefined } : l));
}

/** Straighten every arrow (the rail's counterpart to "reset curves"). */
export function straightenGroupLinks(links: GroupLink[]): GroupLink[] {
  return links.map((l) => ({ ...l, dx: undefined, dy: undefined }));
}

/** True when at least one arrow has been bent. */
export function hasBentGroupLinks(links: GroupLink[]): boolean {
  return links.some((l) => Boolean(l.dx) || Boolean(l.dy));
}

/**
 * Drop arrows whose GROUP endpoint no longer exists — deleting a frame takes
 * its arrows with it rather than leaving them pointing at nothing.
 *
 * Table endpoints are deliberately not checked: a table can be missing from the
 * map for a moment (its metadata failed to load, the schema is mid-reload), and
 * silently deleting the user's annotation over that would be data loss. Such an
 * arrow simply isn't drawn until the table is back — see
 * {@link buildGroupLinks}.
 */
export function pruneGroupLinks(links: GroupLink[], liveGroupIds: Iterable<string>): GroupLink[] {
  const live = new Set(liveGroupIds);
  const alive = (e: LinkEnd): boolean => e.kind !== "group" || live.has(e.id);
  return links.filter((l) => alive(linkEnd(l, "from")) && alive(linkEnd(l, "to")));
}

/** An endpoint resolved to something drawable. */
interface EndTarget {
  rect: GroupRect;
  name: string;
  color: string;
}

/**
 * Resolve every arrow to drawable geometry against the current frames and
 * cards. An arrow with an endpoint that is not on the canvas is skipped for
 * this render (it is NOT deleted — see {@link pruneGroupLinks}).
 *
 * `accent` colours a table endpoint that sits in no frame; one inside a frame
 * borrows that frame's colour, so an arrow out of a card still reads as leaving
 * its domain.
 */
export function buildGroupLinks(
  links: GroupLink[],
  boxes: GroupBox[],
  cards: Record<string, CardModel>,
  accent: string,
): GroupLinkModel[] {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const frameOf = new Map<string, GroupBox>();
  for (const b of boxes) for (const t of b.tables) if (!frameOf.has(t)) frameOf.set(t, b);

  const resolve = (end: LinkEnd): EndTarget | null => {
    if (end.kind === "group") {
      const box = byId.get(end.id);
      return box ? { rect: box, name: box.name, color: box.color } : null;
    }
    const card = cards[end.id];
    if (!card) return null;
    return {
      rect: { x: card.x, y: card.y, w: card.w, h: card.h },
      name: card.table,
      color: frameOf.get(card.table)?.color ?? accent,
    };
  };

  const out: GroupLinkModel[] = [];
  for (const l of links) {
    const from = linkEnd(l, "from");
    const to = linkEnd(l, "to");
    const a = resolve(from);
    const b = resolve(to);
    if (!a || !b) continue;
    const bent = Boolean(l.dx) || Boolean(l.dy);
    const geo = linkGeometry(a.rect, b.rect, bent ? { dx: l.dx ?? 0, dy: l.dy ?? 0 } : null);
    out.push({
      id: l.id,
      from,
      to,
      fromName: a.name,
      toName: b.name,
      label: l.label ?? "",
      color: a.color,
      bent,
      ...geo,
    });
  }
  return out;
}
