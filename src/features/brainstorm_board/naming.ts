// Identifier naming for the brainstorm board: the snake_case / pluralisation
// rules that turn what someone wrote by hand ("Menu item", "section -> Mains")
// into a table or column name.
//
// Deliberately a heuristic, not a linguistic engine — the inspector shows the
// exact result before anything is created, so the user corrects it there. Pure
// string functions, no board types, so the inference and the inspector can both
// use them without importing each other.

/**
 * Lower-case snake form of free text: parenthesised asides are dropped (they
 * are the author's notes — "price (per channel?)" is a `price` column), then
 * every run of non-alphanumerics collapses to one underscore.
 */
export function snake(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** English-ish plural of one snake word: `city → cities`, `box → boxes`. */
export function plural(word: string): string {
  if (!word) return word;
  if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  return word + "s";
}

/** Inverse of {@link plural}, used to name an FK column after its target
 *  table (`menu_items → menu_item_id`). `address` stays `address`. */
export function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Table name for a sketch title: snake, with only the LAST word pluralised —
 * "Menu item" → `menu_items`, not `menus_items`. Empty input falls back to
 * `new_table` rather than producing an unusable identifier.
 */
export function tableName(title: string): string {
  const parts = snake(title).split("_").filter(Boolean);
  const last = parts.pop();
  if (last === undefined) return "new_table";
  return [...parts, plural(last)].join("_");
}
