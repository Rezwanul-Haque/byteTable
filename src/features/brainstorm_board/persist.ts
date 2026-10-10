// Board persistence (M37 Task 1).
//
// A board belongs to a CONNECTION + SCHEMA, so the storage key carries both —
// opening the board on `staging · public` must not show the one drawn against
// `prod · public`. (Multiple boards per connection, and moving the store to the
// backend alongside the schema-map layouts, are deferred: see the milestone's
// Deferred §1. localStorage is the right size for one board per schema.)
//
// Loading is forgiving by design. A board is sketch work, not a migration: a
// store written by an older shape should degrade to "some of my notes came
// back", never to a crashing tab. `loadBoard` therefore validates the few
// structural fields the renderers index by and otherwise defaults; anything it
// cannot make sense of falls back to an EMPTY board — never to the example,
// which would look like someone else's work appearing out of nowhere.
//
// The KEY VERSION is bumped whenever the defaults or the document shape change,
// so a stale board is replaced rather than half-read.

import type { BoardDoc, BoardObject, LiveSourceId } from "./model";
import { emptyBoard } from "./seed";

/** Bump on any default/shape change. v2: a new board starts EMPTY rather than
 *  seeded with the menu-service example. */
const VERSION = "v2";

/**
 * Storage key for one board. Both identity parts are percent-encoded, so the
 * `.` separators stay unambiguous whatever a schema is called — a schema named
 * `a.b` cannot collide with a connection whose id ends in `a` on schema `b`.
 */
export function boardKey(connectionId: string, schema: string): string {
  return `bytetable.board.${VERSION}.${encodeURIComponent(connectionId)}.${encodeURIComponent(schema)}`;
}

/** Debounce for the save effect: long enough that a drag or a burst of typing
 *  writes once, short enough that nothing is lost to a quick tab close. */
export const SAVE_DEBOUNCE_MS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiveSource(value: unknown): value is LiveSourceId {
  return value === "sample" || value === "workspace" || value === "none";
}

/**
 * Coerce a parsed store into a usable document, or return null when it is too
 * damaged to be worth showing. Only the fields the renderers index by are
 * checked — `objects` must be a map and `order` must list ids that exist —
 * because those are the ones whose absence throws rather than merely looking
 * wrong.
 */
function reviveDoc(raw: unknown, schema: string): BoardDoc | null {
  if (!isRecord(raw) || !isRecord(raw.objects)) return null;
  const objects = raw.objects as Record<string, BoardObject>;
  const order = Array.isArray(raw.order)
    ? (raw.order as string[]).filter((id) => id in objects)
    : [];
  // Anything in `objects` but missing from `order` would never be drawn; append
  // it rather than lose it.
  const missing = Object.keys(objects).filter((id) => !order.includes(id));
  return {
    name: typeof raw.name === "string" ? raw.name : schema,
    scope: typeof raw.scope === "string" ? raw.scope : "attached",
    liveSource: isLiveSource(raw.liveSource) ? raw.liveSource : "workspace",
    objects,
    order: [...order, ...missing],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
    groups: Array.isArray(raw.groups) ? raw.groups : [],
  };
}

/** The stored board for one (connection, schema), else a blank one. */
export function loadBoard(connectionId: string, schema: string): BoardDoc {
  try {
    const raw = localStorage.getItem(boardKey(connectionId, schema));
    if (raw) {
      const revived = reviveDoc(JSON.parse(raw), schema);
      if (revived) return revived;
    }
  } catch {
    // Unavailable (private mode) or unparseable storage: start blank.
  }
  return emptyBoard(schema);
}

/** Persist the board. Returns false when storage refused it (quota, private
 *  mode) so the caller can decide whether to say so — it is not an error worth
 *  interrupting a drawing session for. */
export function saveBoard(connectionId: string, schema: string, doc: BoardDoc): boolean {
  try {
    localStorage.setItem(boardKey(connectionId, schema), JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}
