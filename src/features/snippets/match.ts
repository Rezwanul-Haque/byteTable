// Prefix matching and ordering for the snippet library — the logic behind the
// editor's snippet completion rows.
//
// Kept apart from `workspaces/snippetCompletion.ts` (which binds this to
// CodeMirror) so it stays a pure, DOM-free module its unit tests can import
// directly.

import type { Snippet } from "./api";

/** Hard cap on snippet rows, so a big library cannot bury the schema rows. */
export const MAX_SNIPPET_OPTIONS = 12;

/**
 * Snippets whose abbreviation — or, failing that, name — starts with `prefix`,
 * case-insensitively.
 *
 * Abbreviation matches come FIRST: typing `sel` should put the snippet the user
 * named `sel` at the top, ahead of one merely called "Select recent". Within
 * each group the library's own order is kept, so the list does not reshuffle
 * between keystrokes.
 *
 * An empty prefix matches everything (the explicit Ctrl-Space case), ordered by
 * name since no abbreviation is more relevant than another.
 */
export function matchSnippets(snippets: Snippet[], prefix: string): Snippet[] {
  const lower = prefix.trim().toLowerCase();
  if (lower === "") return snippets.slice(0, MAX_SNIPPET_OPTIONS);

  const byAbbreviation: Snippet[] = [];
  const byName: Snippet[] = [];
  for (const snippet of snippets) {
    const abbreviation = snippet.abbreviation?.toLowerCase();
    if (abbreviation && abbreviation.startsWith(lower)) byAbbreviation.push(snippet);
    else if (snippet.name.toLowerCase().startsWith(lower)) byName.push(snippet);
  }
  return [...byAbbreviation, ...byName].slice(0, MAX_SNIPPET_OPTIONS);
}
