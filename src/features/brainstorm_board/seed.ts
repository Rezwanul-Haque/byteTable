// What a board starts as, and the worked example it can be filled with
// (M37 Tasks 1 + 7).
//
// A NEW BOARD IS EMPTY. It has to be: this is the user's own thinking space, and
// opening it to someone else's menu service — the same one, every time, on every
// schema — is a page of someone else's notes to clear before starting. The
// example is reachable on demand instead, from the empty-state card and the
// inspector.
//
// The menu-service example still earns its place as a DEMONSTRATION: it uses all
// three layers at once and every object family — open questions on Domain, a
// sketch that has already become a table, the ingest pipeline on Flow, and a
// schema that is partly live and partly proposed — so one click shows what the
// board is for rather than describing it.
//
// The sample schema (`SAMPLE_LIVE`, a food-delivery platform) is what the board
// compares against while the source is "Sample DB", and it is what makes the
// example's diff meaningful: four of its five table cards don't exist upstream
// (CREATE) and `restaurants` has one extra column (ALTER).

import type { BoardDoc, BoardEdge, BoardGroup, BoardObject, LiveSchema } from "./model";
import { cloneColumns } from "./model";

/** The attached connection's live schema in the sample: `food_platform · public`.
 *  `satisfies` rather than an annotation, so the seed below can reference
 *  `SAMPLE_LIVE.restaurants` without re-checking for a table it declares itself. */
export const SAMPLE_LIVE = {
  restaurants: cloneColumns([
    { name: "id", type: "bigint", pk: true },
    { name: "name", type: "text" },
    { name: "city_id", type: "bigint", fk: "cities" },
    { name: "cuisine", type: "text", nullable: true },
    { name: "rating", type: "numeric(2,1)", nullable: true },
    { name: "is_open", type: "boolean" },
    { name: "created_at", type: "timestamptz" },
  ]),
  cities: cloneColumns([
    { name: "id", type: "bigint", pk: true },
    { name: "name", type: "text" },
    { name: "country", type: "text" },
  ]),
  users: cloneColumns([
    { name: "id", type: "bigint", pk: true },
    { name: "email", type: "text" },
    { name: "name", type: "text" },
    { name: "created_at", type: "timestamptz" },
  ]),
  orders: cloneColumns([
    { name: "id", type: "bigint", pk: true },
    { name: "user_id", type: "bigint", fk: "users" },
    { name: "restaurant_id", type: "bigint", fk: "restaurants" },
    { name: "total", type: "numeric(10,2)" },
    { name: "status", type: "text" },
    { name: "placed_at", type: "timestamptz" },
  ]),
} satisfies LiveSchema;

/**
 * A blank board for `schema`. Named after the schema so the tab reads
 * `public · board`, matching the schema map's `public · map` — an untitled board
 * should not announce itself as "Untitled".
 */
export function emptyBoard(schema: string): BoardDoc {
  return {
    name: schema,
    scope: "attached",
    liveSource: "workspace",
    objects: {},
    order: [],
    edges: [],
    groups: [],
  };
}

/** Left edge of the Schema layer's first column of table cards. */
const SCHEMA_X = 900;

/** The menu-service example board. Ids are stable literals (not `uid()`) so the
 *  groups and the sketch→table link can reference them, and so loading it twice
 *  is byte-identical. */
export function seedBoard(): BoardDoc {
  const objects: Record<string, BoardObject> = {};
  const add = (object: BoardObject) => {
    objects[object.id] = object;
  };

  // --- Domain: what we don't know yet ---------------------------------
  add({ id: "h1", type: "text", layer: "domain", x: 40, y: 24, text: "Menu service", size: "h1" });
  add({
    id: "h2",
    type: "text",
    layer: "domain",
    x: 42,
    y: 62,
    text: "Who owns a menu, and how it changes per channel",
    size: "body",
  });
  add({
    id: "fr1",
    type: "frame",
    layer: "domain",
    x: 24,
    y: 104,
    w: 392,
    h: 300,
    label: "Open questions",
  });
  add({
    id: "st1",
    type: "sticky",
    layer: "domain",
    x: 44,
    y: 128,
    color: "y",
    tag: "question",
    text: "Can one restaurant have different menus for breakfast vs dinner?",
  });
  add({
    id: "st2",
    type: "sticky",
    layer: "domain",
    x: 222,
    y: 138,
    color: "p",
    tag: "risk",
    text: "POS pushes the full menu every 5 min — 12k restaurants",
  });
  add({
    id: "st3",
    type: "sticky",
    layer: "domain",
    x: 54,
    y: 266,
    color: "g",
    tag: "decision",
    text: "Prices can differ by channel (app vs kiosk)",
  });
  add({
    id: "st4",
    type: "sticky",
    layer: "domain",
    x: 232,
    y: 276,
    color: "b",
    tag: "idea",
    text: "Sold-out should reach the app in under 5 s",
  });
  add({
    id: "sk1",
    type: "sketch",
    layer: "domain",
    x: 448,
    y: 136,
    w: 190,
    title: "Menu item",
    lines: [
      "name",
      "price (per channel?)",
      "section -> Mains, Drinks",
      "is it available now?",
      "photo",
    ],
    promotedTo: "tb_items",
  });
  add({
    id: "sn1",
    type: "snippet",
    layer: "domain",
    x: 448,
    y: 330,
    title: "sample · POS payload",
    body:
      '{ "item": "Paneer Tikka",\n  "price": { "app": 249, "kiosk": 229 },\n' +
      '  "section": "Starters",\n  "mods": ["extra cheese"] }',
  });
  add({
    id: "ink1",
    type: "ink",
    layer: "domain",
    color: "#9fe0c2",
    points: [
      [200, 360],
      [240, 372],
      [300, 380],
      [360, 372],
      [420, 352],
      [444, 340],
    ],
  });

  // --- Schema: one live table with a proposed column, four drafts -----
  // The two columns start at SCHEMA_X, far enough right that the Schema group's
  // outline clears the Domain group's. The binding constraint is the snippet,
  // which is content-sized up to `.bb-snip`'s 360px max-width (+20 padding) from
  // x=448 — at its widest it reaches 828, and the group outlines add 18px each.
  // Too close and the two frames read as one container.
  add({
    id: "tb_rest",
    type: "table",
    layer: "schema",
    origin: "live",
    x: SCHEMA_X,
    y: 40,
    name: "restaurants",
    columns: cloneColumns([...SAMPLE_LIVE.restaurants, { name: "timezone", type: "text" }]),
  });
  add({
    id: "tb_menus",
    type: "table",
    layer: "schema",
    origin: "draft",
    x: SCHEMA_X + 280,
    y: 40,
    name: "menus",
    columns: cloneColumns([
      { name: "id", type: "bigint", pk: true },
      { name: "restaurant_id", type: "bigint", fk: "restaurants" },
      { name: "name", type: "text" },
      { name: "is_default", type: "boolean" },
    ]),
  });
  add({
    id: "tb_sections",
    type: "table",
    layer: "schema",
    origin: "draft",
    x: SCHEMA_X + 280,
    y: 230,
    name: "menu_sections",
    columns: cloneColumns([
      { name: "id", type: "bigint", pk: true },
      { name: "menu_id", type: "bigint", fk: "menus" },
      { name: "name", type: "text" },
      { name: "position", type: "integer" },
    ]),
  });
  add({
    id: "tb_items",
    type: "table",
    layer: "schema",
    origin: "draft",
    from: "sk1",
    x: SCHEMA_X,
    y: 300,
    name: "menu_items",
    columns: cloneColumns([
      { name: "id", type: "bigint", pk: true },
      { name: "menu_section_id", type: "bigint", fk: "menu_sections" },
      { name: "name", type: "text" },
      { name: "base_price", type: "numeric(10,2)" },
      { name: "photo_url", type: "text", nullable: true },
      { name: "is_available", type: "boolean" },
    ]),
  });
  add({
    id: "tb_prices",
    type: "table",
    layer: "schema",
    origin: "draft",
    x: SCHEMA_X + 280,
    y: 420,
    name: "item_channel_prices",
    columns: cloneColumns([
      { name: "id", type: "bigint", pk: true },
      { name: "menu_item_id", type: "bigint", fk: "menu_items" },
      { name: "channel", type: "text" },
      { name: "price", type: "numeric(10,2)" },
    ]),
  });

  // --- Flow: how a menu actually gets in ------------------------------
  add({
    id: "f_pos",
    type: "flow",
    layer: "flow",
    kind: "source",
    x: 60,
    y: 620,
    name: "POS webhook",
    detail: "full menu JSON",
  });
  add({
    id: "f_portal",
    type: "flow",
    layer: "flow",
    kind: "source",
    x: 60,
    y: 740,
    name: "Merchant portal",
    detail: "manual edits",
  });
  add({
    id: "f_norm",
    type: "flow",
    layer: "flow",
    kind: "process",
    x: 330,
    y: 680,
    name: "Normalizer",
    detail: "diff · dedupe · map mods",
  });
  add({
    id: "f_db",
    type: "flow",
    layer: "flow",
    kind: "store",
    x: 600,
    y: 620,
    name: "menu_db",
    detail: "Postgres · menu_items",
  });
  add({
    id: "f_cache",
    type: "flow",
    layer: "flow",
    kind: "store",
    x: 600,
    y: 740,
    name: "menu cache",
    detail: "Redis · menu:{rid}",
  });
  add({
    id: "f_search",
    type: "flow",
    layer: "flow",
    kind: "sink",
    x: 880,
    y: 620,
    name: "Search index",
    detail: "Typesense · items",
  });
  add({
    id: "f_app",
    type: "flow",
    layer: "flow",
    kind: "sink",
    x: 880,
    y: 740,
    name: "Customer app",
    detail: "GET /menu/:rid",
  });

  const edges: BoardEdge[] = [
    { id: "e1", from: "f_pos", to: "f_norm", label: "40 /min" },
    { id: "e2", from: "f_portal", to: "f_norm", label: "2 /min" },
    { id: "e3", from: "f_norm", to: "f_db", label: "600 rows/s" },
    { id: "e4", from: "f_db", to: "f_search", label: "async" },
    { id: "e5", from: "f_db", to: "f_cache", label: "write-through" },
    { id: "e6", from: "f_cache", to: "f_app", label: "3000 rps" },
    { id: "e7", from: "sn1", to: "sk1", label: "maps to" },
  ];

  const groups: BoardGroup[] = [
    {
      id: "g_disc",
      name: "Discovery",
      color: "#f2d675",
      ids: ["h1", "h2", "fr1", "st1", "st2", "st3", "st4", "sk1", "sn1", "ink1"],
    },
    {
      id: "g_schema",
      name: "Menu schema",
      color: "#2dd4a7",
      ids: ["tb_rest", "tb_menus", "tb_sections", "tb_items", "tb_prices"],
    },
    {
      id: "g_ingest",
      name: "Menu ingest flow",
      color: "#c792ea",
      ids: ["f_pos", "f_portal", "f_norm", "f_db", "f_cache", "f_search", "f_app"],
    },
  ];

  return {
    name: "Menu service",
    scope: "attached",
    liveSource: "sample",
    objects,
    order: Object.keys(objects),
    edges,
    groups,
  };
}
