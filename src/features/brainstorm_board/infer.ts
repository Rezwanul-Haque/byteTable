// Sketch → table inference (M37 Task 5): turn a handwritten entity sketch into
// a typed draft table.
//
// ByteTable has no AI assistant and this feature does not want one — the rules
// below are a deterministic heuristic the user REVIEWS before promoting. The
// inspector renders exactly what `promoteSketch` returns, so the preview and the
// result can never disagree, and every column stays editable afterwards.
//
// What a sketched line may say, in priority order:
//
//   `id`                             → bigint PRIMARY KEY
//   `x -> y` / `x_id`                → bigint FK to the matching table
//   `is …` / a trailing `?`          → `is_*` boolean
//   price / amount / total / cost    → numeric(10,2)
//   `*_at` / `*_on` / date / time    → timestamptz
//   count / qty / position / rank    → integer
//   json / meta / options / config   → jsonb
//   photo / image / url              → nullable text, `_url` suffix
//   anything else                    → text
//
// Parenthesised asides never influence the type ("price (per channel?)" is a
// numeric `price`, not a boolean), because they are the author's own notes.

import type { BoardColumn, SketchObject } from "./model";
import { plural, snake, tableName } from "./naming";

/** The preview a sketch promotes to: a table name plus its columns. */
export interface SketchPreview {
  name: string;
  columns: BoardColumn[];
}

/**
 * Resolve the table an `x -> y` / `x_id` line refers to. Prefers a known table
 * whose name IS, or ends with `_`, the plural or singular of `base` — so
 * "section" finds `menu_sections` on a board about menus. Falls back to the
 * bare plural, which then shows up in the diff as a table that does not exist
 * yet (visible, not silent).
 */
function findTable(base: string, knownTables: readonly string[]): string {
  const candidates = [plural(base), base];
  for (const table of knownTables) {
    for (const candidate of candidates) {
      if (table === candidate || table.endsWith("_" + candidate)) return table;
    }
  }
  return plural(base);
}

/**
 * One sketched line → one typed column, or `null` when the line carries no
 * usable identifier (a stray "???" or a lone bullet).
 *
 * `knownTables` is every table the board can see — its own cards plus the live
 * schema — and is only consulted for reference resolution.
 */
export function inferColumn(line: string, knownTables: readonly string[]): BoardColumn | null {
  const raw = String(line).trim();
  const arrow = /->|→/.test(raw);
  const head = raw.split(/->|→/)[0] ?? raw;
  // A `?` only asks a yes/no question when it is OUTSIDE the parenthesised
  // aside — "price (per channel?)" is still a price.
  const question = /\?/.test(head.replace(/\(.*?\)/g, ""));

  let name = snake(head).replace(/^(is_it|it_is)_/, "is_");
  if (!name) return null;
  if (question && !/^(is|has|can)_/.test(name)) name = "is_" + name;
  // "is it available now?" is a column about availability, not about now.
  name = name.replace(/_now$/, "");

  if (name === "id") return { name, type: "bigint", pk: true, fk: null, nullable: false };

  if (arrow || /_id$/.test(name)) {
    const base = name.replace(/_id$/, "");
    return {
      name: base + "_id",
      type: "bigint",
      pk: false,
      fk: findTable(base, knownTables),
      nullable: false,
    };
  }

  const column: BoardColumn = { name, type: "text", pk: false, fk: null, nullable: false };
  if (/^(is|has|can)_/.test(name)) column.type = "boolean";
  else if (/(price|amount|total|cost|fee)/.test(name)) column.type = "numeric(10,2)";
  else if (/(_at|_on|until|date|time)$/.test(name)) column.type = "timestamptz";
  else if (/(count|qty|quantity|position|sort|rank|^min|^max)/.test(name)) column.type = "integer";
  else if (/(json|meta|options|config|attrs)/.test(name)) column.type = "jsonb";
  else if (/(photo|image|url)/.test(name)) {
    // An image is a link to one, and there may not be one yet.
    column.type = "text";
    column.nullable = true;
    if (!/_url$/.test(name)) column.name = name + "_url";
  }
  return column;
}

/**
 * The whole sketch → a table name plus one column per line, de-duplicated by
 * column name (two lines that infer the same name keep the first). An `id`
 * primary key is prepended when the sketch did not write one, because a table
 * card with no key is never what the author meant.
 */
export function promoteSketch(
  sketch: Pick<SketchObject, "title" | "lines">,
  knownTables: readonly string[],
): SketchPreview {
  const columns: BoardColumn[] = [];
  const seen = new Set<string>();
  for (const line of sketch.lines ?? []) {
    const column = inferColumn(line, knownTables);
    if (!column || seen.has(column.name)) continue;
    seen.add(column.name);
    columns.push(column);
  }
  if (!columns.some((c) => c.pk)) {
    columns.unshift({ name: "id", type: "bigint", pk: true, fk: null, nullable: false });
  }
  return { name: tableName(sketch.title), columns };
}

/**
 * A free name for a promoted table: `name`, else `name_2`, `name_3`, … against
 * the names already on the board.
 *
 * Colliding with a **live** table is allowed and deliberate — that board card
 * then diffs against the real table and becomes an ALTER, which is exactly how
 * you sketch a change to something that already exists.
 */
export function freeTableName(
  wanted: string,
  boardNames: readonly string[],
  live: Readonly<Record<string, unknown>>,
): string {
  if (!boardNames.includes(wanted) || wanted in live) return wanted;
  let n = 2;
  let name = wanted + "_" + n;
  while (boardNames.includes(name) && !(name in live)) {
    n += 1;
    name = wanted + "_" + n;
  }
  return name;
}
