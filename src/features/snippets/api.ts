// Typed invoke() wrappers for the snippets slice's Tauri commands, plus the TS
// mirror of the Rust wire type. Field names are camelCase per the serde
// attributes on the Rust side — keep in sync with
// `src-tauri/src/features/snippets/domain/mod.rs`.
//
// Snippets are a GLOBAL store: the library is the same from every workspace. A
// snippet may optionally be restricted to ONE engine, which is a dialect
// filter, not an attachment — see `engine` below.
//
// ARCHITECTURE pattern: this module (with state.ts) is the slice's public
// contract — cross-feature consumption of another feature's `api.ts` /
// `state.ts` is sanctioned; reaching into a feature's internals (components,
// hooks) is not.

import { invoke } from "@tauri-apps/api/core";

import type { Engine } from "../../shared/types";

/**
 * A reusable SQL fragment, inserted at the caret. Mirrors Rust's `Snippet`:
 * `id` is assigned on first save (send "" for new entries), `savedAt` is epoch
 * milliseconds and is assigned by the backend on save.
 *
 * `body` may contain tab stops (`#{1:table}`, with `#{0}` for the final caret)
 * — the editor resolves them on insert, and the backend stores the body
 * verbatim. The `#{…}` spelling rather than `${…}` on purpose: `${name}` is the
 * braced form of a query PARAMETER, which resolves at run time, and a snippet
 * body must be able to leave one behind rather than consume it as a tab stop.
 *
 * `abbreviation` is the completion trigger (`sel` → `SELECT …`); absent means
 * the snippet has no shorthand and is inserted from the manager instead. The
 * backend trims it and turns a blank one into absent.
 *
 * `engine` restricts the snippet to one engine's workspaces. Absent/null =
 * offered everywhere. Typed as `Engine` for the callers that set it, but the
 * backend stores it opaquely, so a value from a newer build arrives as a string
 * that simply matches no workspace rather than breaking the library.
 */
export interface Snippet {
  id: string;
  name: string;
  abbreviation?: string | null;
  body: string;
  engine?: Engine | null;
  savedAt: number;
}

/**
 * What the renderer supplies to save: id is optional ("" or omitted = new).
 */
export interface SnippetInput {
  id?: string;
  name: string;
  abbreviation?: string | null;
  body: string;
  engine?: Engine | null;
  /**
   * The entry's existing `savedAt`, for an UPDATE. The backend keeps whatever
   * it is handed on an update (it only assigns one to brand-new entries), so
   * re-saving without this would overwrite a real timestamp with 0. Omit for a
   * new snippet.
   */
  savedAt?: number;
}

export function snippetList(): Promise<Snippet[]> {
  return invoke<Snippet[]>("snippet_list");
}

/** Insert or update; returns the stored value (with assigned id/savedAt). */
export function snippetSave(snippet: SnippetInput): Promise<Snippet> {
  const payload: Snippet = {
    id: snippet.id ?? "",
    name: snippet.name,
    // Rust's Option deserializes from absent or null, so either is fine.
    abbreviation: snippet.abbreviation ?? null,
    body: snippet.body,
    engine: snippet.engine ?? null,
    savedAt: snippet.savedAt ?? 0,
  };
  return invoke<Snippet>("snippet_save", { snippet: payload });
}

export function snippetDelete(id: string): Promise<void> {
  return invoke("snippet_delete", { id });
}
