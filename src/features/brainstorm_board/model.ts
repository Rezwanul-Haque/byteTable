// Brainstorm board (M37) document model — the shapes everything else in the
// slice speaks, plus the palettes the canvas and inspector draw from.
//
// A board is a free-form canvas with THREE focusable layers over one document:
// `domain` (sticky notes, ink, entity sketches), `flow` (data-movement nodes and
// edges) and `schema` (draft/live table cards). Objects are a MAP, not an array,
// so a patch is O(1) and React can diff one entry; `order` carries z-order.
//
// Two invariants the rest of the slice relies on:
//
//   1. **FK relations are derived, never stored.** A table card's `columns[].fk`
//      is the only record of a reference; the canvas re-derives the relation
//      lines on every render. Storing them as edges would leave dangling lines
//      behind a column rename or delete.
//   2. **`removeObjects` is the only delete path** (see doc.ts), so every delete
//      prunes edges, group membership and `promotedTo` back-links together.
//
// The board NEVER writes to the database: `diff.ts` generates DDL that the user
// reviews and runs themselves.

import { t, type StringKey } from "../../shared/i18n";

/** The three layers, in switcher order. `1`/`2`/`3` select them; `0` = All.
 *
 *  `labelKey`, not `label`: this is module-level data, so a baked-in string
 *  would be resolved once at import and never follow a language switch. Render
 *  sites call `t(labelKey)` instead, which reads the live locale. */
export const LAYERS = [
  { id: "domain", labelKey: "board.layer.domain", color: "#f2d675", icon: "sticky_note_2" },
  { id: "flow", labelKey: "board.layer.flow", color: "#c792ea", icon: "alt_route" },
  { id: "schema", labelKey: "board.layer.schema", color: "#2dd4a7", icon: "table_view" },
] as const;

/** A layer id, or `"all"` when nothing is isolated. */
export type LayerId = (typeof LAYERS)[number]["id"];
export type LayerFocus = LayerId | "all";

/** Lookup for a layer's label/colour without scanning {@link LAYERS}. */
export const LAYER_BY_ID: Record<LayerId, (typeof LAYERS)[number]> = {
  domain: LAYERS[0],
  flow: LAYERS[1],
  schema: LAYERS[2],
};

/** The four kinds of flow node, in flyout order. */
export const FLOW_KINDS = {
  source: { labelKey: "board.flow.source", icon: "input", color: "#61afef" },
  process: { labelKey: "board.flow.process", icon: "memory", color: "#c792ea" },
  store: { labelKey: "board.flow.store", icon: "database", color: "#2dd4a7" },
  sink: { labelKey: "board.flow.sink", icon: "output", color: "#e2b340" },
} as const;

export type FlowKindId = keyof typeof FLOW_KINDS;

/** Flow kinds in declaration order — the flyout and the inspector's segmented
 *  control both iterate this, so they can never disagree. */
export const FLOW_KIND_IDS = Object.keys(FLOW_KINDS) as FlowKindId[];

/** Sticky-note paper colours, keyed by the single letter stored on the object. */
export const STICKY_COLORS = {
  y: "#f2d675",
  p: "#f3a7c0",
  g: "#9fe0c2",
  b: "#a9c9f5",
} as const;

export type StickyColorId = keyof typeof STICKY_COLORS;

/** What a sticky is FOR — printed as its eyebrow and picked in the inspector. */
export const STICKY_TAGS = ["note", "question", "risk", "decision", "idea"] as const;
export type StickyTag = (typeof STICKY_TAGS)[number];

/** Tag → its label key. A lookup rather than `"board.stickyTag." + tag`, so the
 *  key set stays statically checkable against the English table. */
export const STICKY_TAG_KEYS: Record<StickyTag, StringKey> = {
  note: "board.stickyTag.note",
  question: "board.stickyTag.question",
  risk: "board.stickyTag.risk",
  decision: "board.stickyTag.decision",
  idea: "board.stickyTag.idea",
};

/** Column types offered in the inspector's type select. A column whose type
 *  came from a live table and is not in this list is prepended to the options,
 *  so an engine-specific type is never silently rewritten. */
export const TYPES = [
  "bigint",
  "integer",
  "numeric(10,2)",
  "text",
  "boolean",
  "timestamptz",
  "date",
  "jsonb",
  "uuid",
] as const;

/** Group colours, assigned round-robin as groups are created. */
export const GROUP_COLORS = [
  "#f2d675",
  "#2dd4a7",
  "#c792ea",
  "#61afef",
  "#f3a7c0",
  "#e2b340",
] as const;

/** The freehand pen's palette (also the ink object's inspector swatches). */
export const INK_COLORS = ["#9fe0c2", "#f2d675", "#f3a7c0", "#a9c9f5", "#e6e9ef"] as const;

/** `index`-th group colour, wrapping — so two groups made in a row differ. */
export function groupColor(index: number): string {
  return GROUP_COLORS[index % GROUP_COLORS.length] ?? GROUP_COLORS[0];
}

// ---------------------------------------------------------------- objects ---

/** One column on a table card. `fk` holds the TARGET TABLE NAME (not an id), so
 *  a reference survives the target card being deleted and re-added, and resolves
 *  equally against a board card or a live table. */
export interface BoardColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: string | null;
  nullable: boolean;
}

/** A point in world (unzoomed) coordinates. */
export type Point = [number, number];

interface ObjectBase {
  id: string;
  layer: LayerId;
}

/** Everything except ink is placed by its top-left corner. */
interface PlacedObject extends ObjectBase {
  x: number;
  y: number;
}

export interface StickyObject extends PlacedObject {
  type: "sticky";
  color: StickyColorId;
  tag: StickyTag;
  text: string;
}

export interface TextObject extends PlacedObject {
  type: "text";
  text: string;
  size: "h1" | "body";
}

export interface FrameObject extends PlacedObject {
  type: "frame";
  w: number;
  h: number;
  label: string;
}

/** A handwritten entity sketch: a title plus one field per line. Promoting it
 *  (see infer.ts) creates a table card and links the two with
 *  `promotedTo` / {@link TableObject.from}. */
export interface SketchObject extends PlacedObject {
  type: "sketch";
  w: number;
  title: string;
  lines: string[];
  /** The table card this sketch became, or null/absent while unpromoted. */
  promotedTo?: string | null;
}

export interface SnippetObject extends PlacedObject {
  type: "snippet";
  title: string;
  body: string;
}

/** A freehand stroke. Stores `points` INSTEAD of x/y — moving it translates
 *  every point, which is why the drag path special-cases this type. */
export interface InkObject extends ObjectBase {
  type: "ink";
  color: string;
  points: Point[];
}

export interface FlowObject extends PlacedObject {
  type: "flow";
  kind: FlowKindId;
  name: string;
  detail: string;
}

export interface TableObject extends PlacedObject {
  type: "table";
  /** `live` = a reference card mirroring an existing table; `draft` = the
   *  board's own proposal. Only the origin changes the card's chrome — the diff
   *  decides CREATE vs ALTER purely by whether the NAME exists upstream. */
  origin: "live" | "draft";
  name: string;
  columns: BoardColumn[];
  /** The sketch this card was promoted from, when it was. */
  from?: string | null;
}

export type BoardObject =
  | StickyObject
  | TextObject
  | FrameObject
  | SketchObject
  | SnippetObject
  | InkObject
  | FlowObject
  | TableObject;

export type BoardObjectType = BoardObject["type"];

/** Object types whose content is edited in place (double-click / Enter). */
export const EDITABLE_TYPES: BoardObjectType[] = [
  "sticky",
  "text",
  "sketch",
  "snippet",
  "flow",
  "frame",
];

/** True when double-click should open an inline editor on `object`. */
export function isEditable(object: BoardObject): boolean {
  return EDITABLE_TYPES.includes(object.type);
}

/**
 * What to call an object in a sentence — its own name or title when it has one,
 * else what kind of thing it is. Used wherever the board has to report on an
 * object it is not drawing: the eraser's toast, the edge inspector's endpoints.
 */
export function objectLabel(object: BoardObject): string {
  switch (object.type) {
    case "sticky":
      return t("board.obj.sticky");
    case "text":
      return object.text.split("\n")[0]?.trim() || t("board.obj.text");
    case "frame":
      return object.label || t("board.obj.frame");
    case "sketch":
      return object.title || t("board.obj.sketch");
    case "snippet":
      return object.title || t("board.obj.snippet");
    case "ink":
      return t("board.obj.ink");
    case "flow":
      return object.name || t("board.obj.flow");
    case "table":
      return object.name || t("board.obj.table");
  }
}

/**
 * An explicit connector: a flow edge, or a free annotation between any two
 * objects. FK relations are NOT edges (see the file header) — they are derived
 * from `columns[].fk` on every render.
 */
export interface BoardEdge {
  id: string;
  from: string;
  to: string;
  /** Flow edges read it as a volume ("600 rows/s") and scale their stroke by
   *  it; everything else treats it as a plain caption. */
  label: string;
}

/**
 * A named set of objects. An object belongs to **at most one** group — grouping
 * strips its id from any other group, and a group left empty is dropped. Groups
 * may span layers ("the ingest flow plus the tables it writes" is legitimate).
 */
export interface BoardGroup {
  id: string;
  name: string;
  color: string;
  ids: string[];
}

/** Which schema the board diffs against. `none` = a standalone board: no diff
 *  bar, no DDL. */
export type LiveSourceId = "sample" | "workspace" | "none";

/** A live schema in board shape: table name → columns. */
export type LiveSchema = Record<string, BoardColumn[]>;

/** One whole board. */
export interface BoardDoc {
  name: string;
  /** Free-text note on what the board is bound to; display only. */
  scope: string;
  /** Persisted so reopening the tab restores the comparison the user chose. */
  liveSource?: LiveSourceId;
  objects: Record<string, BoardObject>;
  /** z-order, back to front. Every id here exists in `objects`. */
  order: string[];
  edges: BoardEdge[];
  groups: BoardGroup[];
}

/** What is selected: a set of objects, OR one edge (never both). */
export interface BoardSelection {
  ids: string[];
  edge: string | null;
}

/** Measured on-screen size of each object, filled after render — edges anchor
 *  on real bounds rather than guesses. Keyed by object id. */
export type BoardSizes = Record<string, { w: number; h: number }>;

/** The canvas transform: `translate(x, y) scale(k)`. */
export interface BoardView {
  x: number;
  y: number;
  k: number;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2.5;

// ------------------------------------------------------------------ utils ---

let seq = 0;

/** A board-unique id with a readable prefix (`st`, `tb`, `e`, `g`, …). Not
 *  globally unique by construction — board-local is all any reference needs. */
export function uid(prefix: string): string {
  seq += 1;
  return prefix + Date.now().toString(36) + seq.toString(36);
}

/** Fill in a column's optional flags, so every card holds complete columns and
 *  no renderer has to re-default them. */
export function cloneColumns(
  columns: readonly (Partial<BoardColumn> & { name: string; type: string })[],
): BoardColumn[] {
  return columns.map((c) => ({
    pk: false,
    fk: null,
    nullable: false,
    ...c,
  }));
}

/** Every table card on the board, in z-order-independent map order. */
export function boardTables(doc: BoardDoc): TableObject[] {
  return Object.values(doc.objects).filter((o): o is TableObject => o.type === "table");
}

/** Layer an edge belongs to: its endpoints' shared layer, else Domain. */
export function edgeLayer(a: BoardObject, b: BoardObject): LayerId {
  return a.layer === b.layer ? a.layer : "domain";
}
