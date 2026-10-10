// Document mutations (M37 Tasks 1 + 8). Every function here is pure: it takes a
// {@link BoardDoc} and returns a new one, which is what makes the undo stack a
// plain array of snapshots.
//
// `removeObjects` is the ONLY delete path in the slice. Deleting an object has
// four consequences that must happen together — the object, its edges, its group
// membership, and any sketch's `promotedTo` back-link — and every one of them
// leaves a visible bug if it is forgotten (a line to nowhere, a group counting
// members it no longer has, a sketch claiming a table that is gone). Routing
// every delete through one function is how they stay in step.

import type { BoardDoc, BoardGroup, BoardObject, BoardSelection } from "./model";
import { groupColor, uid } from "./model";

/**
 * Drop `ids` and everything that referred to them: their edges (either end),
 * their membership in any group (and the group itself once empty), and the
 * `promotedTo` link on any sketch that pointed at a removed table card.
 */
export function removeObjects(doc: BoardDoc, ids: readonly string[]): BoardDoc {
  const removed = new Set(ids);
  const objects: Record<string, BoardObject> = {};
  for (const [key, object] of Object.entries(doc.objects)) {
    if (removed.has(key)) continue;
    objects[key] =
      object.type === "sketch" && object.promotedTo && removed.has(object.promotedTo)
        ? { ...object, promotedTo: null }
        : object;
  }
  return {
    ...doc,
    objects,
    order: doc.order.filter((id) => !removed.has(id)),
    edges: doc.edges.filter((e) => !removed.has(e.from) && !removed.has(e.to)),
    groups: doc.groups
      .map((g) => ({ ...g, ids: g.ids.filter((id) => !removed.has(id)) }))
      .filter((g) => g.ids.length > 0),
  };
}

/** Add one object on top of the z-order. */
export function addObject(doc: BoardDoc, object: BoardObject): BoardDoc {
  return {
    ...doc,
    objects: { ...doc.objects, [object.id]: object },
    order: [...doc.order, object.id],
  };
}

/** Merge a partial patch into one object. Typed loosely on purpose: callers
 *  patch a field they already know the object has, and narrowing per variant at
 *  every call site would add nothing. */
export function patchObject(doc: BoardDoc, id: string, patch: Partial<BoardObject>): BoardDoc {
  const object = doc.objects[id];
  if (!object) return doc;
  return {
    ...doc,
    objects: { ...doc.objects, [id]: { ...object, ...patch } as BoardObject },
  };
}

/** Translate several objects by (dx, dy) — ink by moving every point. */
export function moveObjects(
  doc: BoardDoc,
  ids: readonly string[],
  dx: number,
  dy: number,
): BoardDoc {
  const objects = { ...doc.objects };
  for (const id of ids) {
    const object = objects[id];
    if (!object) continue;
    objects[id] =
      object.type === "ink"
        ? {
            ...object,
            points: object.points.map((p) => [p[0] + dx, p[1] + dy] as [number, number]),
          }
        : { ...object, x: object.x + dx, y: object.y + dy };
  }
  return { ...doc, objects };
}

/** Merge a patch into one group. */
export function patchGroupIn(doc: BoardDoc, id: string, patch: Partial<BoardGroup>): BoardDoc {
  return { ...doc, groups: doc.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) };
}

/**
 * Group `ids` under a new auto-named group, taking those ids out of whichever
 * group held them (one group per object) and dropping any group that is left
 * empty. The colour cycles through {@link GROUP_COLORS} by group count, so two
 * groups created in a row are visually distinct without the user choosing.
 */
export function groupObjects(doc: BoardDoc, ids: readonly string[]): BoardDoc {
  const n = doc.groups.length;
  const group: BoardGroup = {
    id: uid("g"),
    name: "Group " + (n + 1),
    color: groupColor(n),
    ids: [...ids],
  };
  const kept = doc.groups
    .map((g) => ({ ...g, ids: g.ids.filter((id) => !ids.includes(id)) }))
    .filter((g) => g.ids.length > 0);
  return { ...doc, groups: [...kept, group] };
}

/** Drop one group, leaving its members on the board. */
export function ungroup(doc: BoardDoc, groupId: string): BoardDoc {
  return { ...doc, groups: doc.groups.filter((g) => g.id !== groupId) };
}

/** Every group with at least one member in `ids` — what ⇧⌘G dissolves, and what
 *  the multi-select inspector warns is about to lose members. */
export function groupsTouching(doc: BoardDoc, ids: readonly string[]): BoardGroup[] {
  return doc.groups.filter((g) => g.ids.some((id) => ids.includes(id)));
}

/**
 * The group the selection IS, exactly — same membership, nothing more. The
 * group inspector variant appears only for this: a selection that merely
 * overlaps a group is a multi-select, and showing "Ungroup" for it would be a
 * lie about what the buttons act on.
 */
export function exactGroup(doc: BoardDoc, selection: BoardSelection): BoardGroup | null {
  const { ids } = selection;
  if (ids.length === 0) return null;
  return (
    doc.groups.find((g) => g.ids.length === ids.length && g.ids.every((id) => ids.includes(id))) ??
    null
  );
}

/** Reverse one edge's direction. */
export function reverseEdge(doc: BoardDoc, edgeId: string): BoardDoc {
  return {
    ...doc,
    edges: doc.edges.map((e) => (e.id === edgeId ? { ...e, from: e.to, to: e.from } : e)),
  };
}

/** Patch one edge (its label, in practice). */
export function patchEdge(doc: BoardDoc, edgeId: string, patch: { label?: string }): BoardDoc {
  return { ...doc, edges: doc.edges.map((e) => (e.id === edgeId ? { ...e, ...patch } : e)) };
}

/** Drop one edge. */
export function removeEdge(doc: BoardDoc, edgeId: string): BoardDoc {
  return { ...doc, edges: doc.edges.filter((e) => e.id !== edgeId) };
}

/** Count of objects per layer, for the layer switcher's live badges. */
export function layerCounts(doc: BoardDoc): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const object of Object.values(doc.objects)) {
    counts[object.layer] = (counts[object.layer] ?? 0) + 1;
  }
  return counts;
}
