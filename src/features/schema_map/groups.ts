// Table groups for the schema map: a named rectangle drawn behind a chosen set
// of table cards (e.g. "Billing", "Auth"), so a large diagram reads as a few
// bounded domains instead of one flat sea of cards.
//
// THE RECTANGLE IS THE GROUP. A group stores its own frame (`rect`) and nothing
// else; its members are whichever cards currently sit inside that frame. So
// resizing the frame is how a group grows, dragging a card in or out is how it
// changes hands, and there is no membership list that can disagree with what the
// diagram shows. (The first cut derived the rectangle from a stored table list,
// which made the frame un-resizable — the thing you most want to do to it.)
//
// A card belongs to the first frame whose area contains its centre, so
// overlapping frames never both claim a card and an export scope stays
// unambiguous.

import type { CardModel, EdgeModel } from "./diagram";

/** A group's frame in world coords. */
export interface GroupRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A named frame. Persisted verbatim in `MapLayout.groups` — this is a
 *  structural mirror of api.ts's wire type (the same split diagram.ts keeps for
 *  `CardinalityKind`) so this module stays pure: no DOM, no IPC. */
export interface TableGroup {
  /** Stable id (also the export-scope key). */
  id: string;
  name: string;
  /** The frame. Absent only in a layout saved before frames were storable, in
   *  which case {@link groupRect} falls back to `tables`. */
  rect?: GroupRect;
  /** Legacy member list from that same early format — a seed for the fallback
   *  rectangle, never written back. */
  tables?: string[];
  /** Literal frame colour, baked at creation so the export matches the canvas
   *  without re-deriving the palette. */
  color?: string;
}

/** Padding left around the cards when a frame is first drawn around them. */
export const GROUP_PAD = 20;
/** Extra top padding — the band the group's title bar sits in. */
export const GROUP_PAD_TOP = 34;
/** Height of the title bar drawn inside the top band. */
export const GROUP_HEAD_H = 24;
/** Smallest a frame can be dragged down to (room for its title bar). */
export const MIN_GROUP_W = 150;
export const MIN_GROUP_H = 70;

/**
 * Frame colours, assigned round-robin as groups are created so neighbouring
 * groups stay distinguishable. Hues are spread across the wheel and kept
 * mid-saturation so they read on both the light and dark canvas.
 */
export const GROUP_COLORS = [
  "#4f9dff", // blue
  "#c08cff", // violet
  "#ff9f6b", // amber
  "#54c9a0", // green
  "#ff7ba6", // pink
  "#5ecbdd", // cyan
] as const;

/** The colour for the Nth created group (wraps around the palette). */
export function paletteColor(index: number): string {
  return GROUP_COLORS[index % GROUP_COLORS.length] ?? GROUP_COLORS[0];
}

/** A group's resolved colour — its baked one, else a palette slot by position. */
export function groupColor(group: TableGroup, index: number): string {
  return group.color ?? paletteColor(index);
}

/** The tight box around some cards, grown by the frame padding (extra on top
 *  for the title bar). Returns null when none of the tables are on the canvas. */
export function rectAroundCards(
  cards: Record<string, CardModel>,
  tables: string[],
): GroupRect | null {
  const members = tables.map((t) => cards[t]).filter((c): c is CardModel => Boolean(c));
  if (members.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of members) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  return {
    x: minX - GROUP_PAD,
    y: minY - GROUP_PAD_TOP,
    w: maxX - minX + 2 * GROUP_PAD,
    h: maxY - minY + GROUP_PAD_TOP + GROUP_PAD,
  };
}

/** A group's frame: its own rectangle, or (legacy layouts) one drawn around the
 *  tables it used to list. Null when neither resolves. */
export function groupRect(group: TableGroup, cards: Record<string, CardModel>): GroupRect | null {
  if (group.rect) return group.rect;
  return group.tables ? rectAroundCards(cards, group.tables) : null;
}

/** Keep a frame on the canvas and above its minimum size. */
export function clampRect(r: GroupRect): GroupRect {
  return {
    x: Math.max(0, r.x),
    y: Math.max(0, r.y),
    w: Math.max(MIN_GROUP_W, r.w),
    h: Math.max(MIN_GROUP_H, r.h),
  };
}

/** True when a card's centre lies inside `rect` — the membership test. */
export function rectHoldsCard(rect: GroupRect, card: CardModel): boolean {
  const cx = card.x + card.w / 2;
  const cy = card.y + card.h / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
}

/** A group resolved to a drawable frame plus the cards currently inside it. */
export interface GroupBox extends GroupRect {
  id: string;
  name: string;
  color: string;
  /** Tables inside the frame right now. */
  tables: string[];
}

/**
 * Every group's frame, with membership resolved. A card counts for the first
 * frame that contains it, so two overlapping frames never both claim it.
 */
export function groupBoxes(groups: TableGroup[], cards: Record<string, CardModel>): GroupBox[] {
  const claimed = new Set<string>();
  const out: GroupBox[] = [];
  groups.forEach((g, i) => {
    const rect = groupRect(g, cards);
    if (!rect) return;
    const tables: string[] = [];
    for (const c of Object.values(cards)) {
      if (claimed.has(c.table) || !rectHoldsCard(rect, c)) continue;
      claimed.add(c.table);
      tables.push(c.table);
    }
    out.push({ ...rect, id: g.id, name: g.name, color: groupColor(g, i), tables: tables.sort() });
  });
  return out;
}

/** Which corner/edge of a frame a resize drag grabbed. */
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * Apply a resize drag to a frame: the grabbed handle moves the one or two edges
 * it touches, and NOTHING else moves.
 *
 * Stated in edges rather than (x, w) on purpose. Written as a position plus a
 * size, a clamp on `x` silently becomes a change of width: dragging the west
 * edge past the canvas origin pinned `x` at 0 while the width kept growing, so
 * the far side of the frame ran away with it. Each edge is clamped in its own
 * terms here — against the canvas at 0 and against its opposite edge at the
 * minimum size — so the anchored side always stays exactly where it was.
 */
export function resizeRect(
  rect: GroupRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): GroupRect {
  let left = rect.x;
  let right = rect.x + rect.w;
  let top = rect.y;
  let bottom = rect.y + rect.h;

  if (handle.endsWith("w")) left = Math.max(0, Math.min(left + dx, right - MIN_GROUP_W));
  else if (handle.endsWith("e")) right = Math.max(right + dx, left + MIN_GROUP_W);

  if (handle.startsWith("n")) top = Math.max(0, Math.min(top + dy, bottom - MIN_GROUP_H));
  else if (handle.startsWith("s")) bottom = Math.max(bottom + dy, top + MIN_GROUP_H);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** A fresh group id — timestamp + random so ids stay unique across sessions. */
export function newGroupId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** The next free default name ("Group 1", "Group 2", …). */
export function nextGroupName(groups: TableGroup[]): string {
  const taken = new Set(groups.map((g) => g.name));
  for (let i = 1; ; i++) {
    const name = `Group ${i}`;
    if (!taken.has(name)) return name;
  }
}

/** Frame the given tables as a new group. Returns the new list and the group. */
export function createGroup(
  groups: TableGroup[],
  rect: GroupRect,
  name?: string,
): { groups: TableGroup[]; group: TableGroup } {
  const group: TableGroup = {
    id: newGroupId(),
    name: name ?? nextGroupName(groups),
    rect: clampRect(rect),
    color: paletteColor(groups.length),
  };
  return { groups: [...groups, group], group };
}

/**
 * Narrow a diagram to one group, for a group-scoped export: its member cards,
 * only the relationships whose BOTH ends are inside the group, and the group's
 * own frame. An edge to a table outside the group is dropped rather than left
 * dangling into empty space — the export is meant to read as a standalone
 * picture of that domain. The caller frames the result from these cards, so no
 * separate crop is needed.
 */
export function scopeToGroup(
  box: GroupBox,
  cards: CardModel[],
  edges: EdgeModel[],
): { cards: CardModel[]; edges: EdgeModel[]; groups: GroupBox[] } {
  const inside = new Set(box.tables);
  return {
    cards: cards.filter((c) => inside.has(c.table)),
    edges: edges.filter((e) => inside.has(e.childTable) && inside.has(e.refTable)),
    groups: [box],
  };
}
