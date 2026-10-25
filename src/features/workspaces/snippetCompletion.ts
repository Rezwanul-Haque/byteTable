// CodeMirror adapter for the user's snippet library: a second completion
// source beside the schema/keyword one in `sqlCompletion.ts`, whose options
// expand into the buffer with real tab stops.
//
// WHY a CompletionSource: `snippetCompletion` from `@codemirror/autocomplete`
// gives Tab/Shift-Tab field navigation, linked fields and a final cursor
// position for free. Writing an insert-at-caret command by hand would get the
// text in but none of that.
//
// FIELD SYNTAX — ByteTable documents `#{1:label}` for snippet fields, with
// `#{0}` as the final cursor position. CodeMirror's parser accepts `${…}` just
// the same, but `${name}` is already the braced form of a query PARAMETER
// (`sqlParams.ts`), and a `${status}` in a snippet body would be eaten as a tab
// stop on insert instead of surviving into the buffer as a placeholder. So:
// `#{…}` for "ask me as I type", and the canonical `:status` form — which the
// snippet parser never touches — for "ask me when I run".

import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

import type { Snippet } from "../snippets/api";
import { matchSnippets } from "../snippets/match";

import type { BtCompletion } from "./sqlCompletion";

/** Word characters a snippet abbreviation can be typed with. */
const WORD_BEFORE = /[A-Za-z_][\w$]*$/;

/**
 * One snippet as a CM completion option.
 *
 * Carries the `bt*` fields the shared row renderer in `sqlCompletion.ts` reads
 * (icon, kind tag, hint) so a snippet row looks like every other row rather
 * than like a renderer that forgot to handle it. The `apply` function comes
 * from `snippetCompletion`, which is what makes the fields tabbable.
 */
export function toSnippetCompletion(snippet: Snippet): Completion {
  const option = snippetCompletion(snippet.body, {
    label: snippet.abbreviation ?? snippet.name,
    displayLabel: snippet.abbreviation ?? snippet.name,
    // The name as the row's hint, so an abbreviation row says what it expands
    // to without the user having to accept it to find out.
    detail: snippet.name,
  });
  const enriched: BtCompletion = {
    ...option,
    btKind: "snippet",
    btIcon: "bolt",
    btSource: snippet.abbreviation ? snippet.name : undefined,
  };
  return enriched;
}

/**
 * Build the snippet CompletionSource. `getSnippets` is read on every invocation
 * so the source always sees the live library (a snippet saved in the manager is
 * offered immediately) without re-creating the editor's extensions.
 *
 * Returns null when there is no word before the caret and the request was not
 * explicit (Ctrl-Space), so snippets never pop up unprompted mid-whitespace;
 * an explicit request with no prefix lists the library.
 */
export function makeSnippetCompletionSource(getSnippets: () => Snippet[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const snippets = getSnippets();
    if (snippets.length === 0) return null;
    const word = context.matchBefore(WORD_BEFORE);
    if (!word && !context.explicit) return null;
    const prefix = word?.text ?? "";
    const matched = matchSnippets(snippets, prefix);
    if (matched.length === 0) return null;
    // filter:false — already prefix-filtered and ordered above, so CM must not
    // re-sort or fuzzy-narrow (matching the schema source's contract).
    return {
      from: word?.from ?? context.pos,
      to: context.pos,
      options: matched.map(toSnippetCompletion),
      filter: false,
    };
  };
}
