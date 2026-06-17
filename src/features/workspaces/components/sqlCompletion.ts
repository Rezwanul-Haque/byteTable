// CodeMirror adapter for the SQL suggestion engine (see sqlSuggest.ts for the
// shared, surface-agnostic ranking core). This file maps `suggestSql`'s output
// onto CodeMirror's autocomplete: a `CompletionSource`, the option `<li>` /
// popup classes (themed to the design's `.ac-*` rows in SqlCodeEditor.css), and
// the custom render slots (leading icon, source hint, kind tag).
//
// WHY a CompletionSource (not the prototype's mirror-a-textarea popup): the
// query editor is CodeMirror 6 (SqlCodeEditor), so caret-positioned placement,
// ↑/↓ navigation, Enter/Tab/Esc, mouse hover/click and dismiss-on-blur all come
// from `@codemirror/autocomplete` for free — we supply only content + look.

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

import { suggestSql, SUGGEST_KIND_LABEL, type EditorSchema, type Suggestion } from "./sqlSuggest";

export type { EditorSchema, EditorSchemaColumn, EditorSchemaTable } from "./sqlSuggest";

/** A CM completion enriched with the fields the design's row renders. */
export interface BtCompletion extends Completion {
  btKind: Suggestion["kind"];
  /** Source table for a column row (the `.ac-hint`). */
  btSource?: string;
  /** Material Symbols glyph name for the leading icon. */
  btIcon: string;
  /** Primary-key column — renders the key icon in accent. */
  btPk?: boolean;
}

/** Map a surface-agnostic Suggestion onto a CM completion option. */
function toCompletion(s: Suggestion): BtCompletion {
  return {
    label: s.insert,
    displayLabel: s.label,
    btKind: s.kind,
    btSource: s.source,
    btPk: s.pk,
    btIcon: s.icon,
  };
}

/**
 * Build the CompletionSource. `getSchema` is read on every invocation so the
 * source always sees the latest cached schema (columns stream in as the tab
 * warms them) without re-creating the editor's extensions.
 */
export function makeSqlCompletionSource(getSchema: () => EditorSchema) {
  return (context: CompletionContext): CompletionResult | null => {
    const result = suggestSql(context.state.doc.toString(), context.pos, getSchema(), {
      explicit: context.explicit,
    });
    if (!result) return null;
    // filter:false — we already prefix-filtered and ordered; CM must not
    // re-sort or fuzzy-narrow. No validFor, so the source re-runs per keystroke
    // (cheap, pure JS) and re-derives context/ordering each time.
    return {
      from: result.from,
      to: result.to,
      options: result.items.map(toCompletion),
      filter: false,
    };
  };
}

// ---- row rendering (themed to the design's .ac-* row) ---------------------

/** Class added to every option `<li>` so the design's `.ac-item` flex row
 *  applies. (Selected state is CM's `[aria-selected]`, themed in the CSS.) */
export function completionOptionClass(): string {
  return "ac-item";
}

/** Class added to the popup container so the design's `.ac-popup` box applies. */
export function completionTooltipClass(): string {
  return "ac-popup";
}

/** Leading type/key icon (position 10 — before CM's empty default icon slot). */
function renderIcon(completion: Completion): Node | null {
  const c = completion as BtCompletion;
  const span = document.createElement("span");
  span.className = "msym ac-icon ac-icon-" + c.btKind + (c.btPk ? " ac-icon-pk" : "");
  span.textContent = c.btIcon;
  return span;
}

/** Source-table hint for a column row (position 70). */
function renderHint(completion: Completion): Node | null {
  const c = completion as BtCompletion;
  if (c.btKind !== "column" || !c.btSource) return null;
  const span = document.createElement("span");
  span.className = "ac-hint";
  span.textContent = c.btSource;
  return span;
}

/** Kind tag at the right edge (position 90). */
function renderKind(completion: Completion): Node | null {
  const c = completion as BtCompletion;
  const span = document.createElement("span");
  span.className = "ac-kind";
  span.textContent = SUGGEST_KIND_LABEL[c.btKind];
  return span;
}

/** Extra render columns injected into each option, alongside CM's default
 *  label slot (themed as `.ac-label`). */
export const completionAddToOptions = [
  { render: renderIcon, position: 10 },
  { render: renderHint, position: 70 },
  { render: renderKind, position: 90 },
];
