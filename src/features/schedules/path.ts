// Path display for the schedules manager (M41).
//
// A list row has one line for the output location, and an absolute path does
// not fit in it. CSS `text-overflow: ellipsis` is the wrong tool here: it cuts
// the END, which keeps `/Users/you/me/workspaces/personal/By…` — every
// character of which is the part you already know, and none of which is the
// folder you were looking for. These keep the TAIL instead.

/** Both separators, because a path from the backend may be either. */
const SEPARATORS = /[/\\]/;

/**
 * The last `segments` components of a path, prefixed with `…/` when anything
 * was dropped — `/Users/you/work/ByteTable/reports` → `…/ByteTable/reports`.
 *
 * Two segments rather than one by default: a bare `reports` is ambiguous the
 * moment a second schedule writes to a different `reports`, and the parent is
 * usually the word that tells them apart. The full path is still available —
 * callers put it in the `title`, so hovering gives the whole thing.
 *
 * A path already short enough is returned unchanged, with no ellipsis: adding
 * one would imply a prefix that is not there.
 */
export function shortenPath(path: string, segments = 2): string {
  const trimmed = path.trim();
  if (trimmed === "") return "";
  const separator = trimmed.includes("\\") ? "\\" : "/";
  // A trailing separator is not a component; `/a/b/` is `a/b`.
  const parts = trimmed.split(SEPARATORS).filter((part) => part !== "");
  if (parts.length <= segments) return trimmed;
  return `…${separator}${parts.slice(-segments).join(separator)}`;
}

/**
 * The final component of a path — the filename for a run's output.
 *
 * The history sits under a row that already names the folder, so repeating it
 * on every entry is noise; what differs between runs is the filename, which is
 * where the date token lands.
 */
export function baseName(path: string): string {
  const parts = path.trim().split(SEPARATORS);
  // `.pop()` on a path ending in a separator gives "", so walk back past them.
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts[parts.length - 1] ?? "";
}
