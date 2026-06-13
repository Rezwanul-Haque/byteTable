// Task-3 seam — per-tab result metadata the data grid reports and the table
// toolbar + status bar read.
//
// Why a separate store (not workspace `ui`): row count + query timing are
// *result* state owned by whatever renders the data, not structural
// workspace layout. The grid is Task 3; this slice is the contract it fills.
// Keeping it out of `ui` also keeps it out of any future persistence of the
// workspace layout — timing/counts are ephemeral.
//
// Keyed by tab id (globally unique — `tab-<kind>-<uuid>`), so it spans
// workspaces without collision and a closed tab's stale entry is harmless
// (readers only look up the active tab). Task 3 should call `clearTabMeta`
// when a tab closes if it wants to be tidy; not required for correctness.

import { create } from "zustand";

/**
 * What the grid knows after a `rows_fetch` for a table tab. All fields
 * optional/null so a freshly opened tab (grid mounted, not yet fetched)
 * reads as "—".
 */
export interface TabResultMeta {
  /**
   * Exact total row count of the table (unfiltered in M4 — filters are M5).
   * `null` when the backend could not compute it; `undefined` before the
   * first fetch resolves.
   */
  totalRows?: number | null;
  /**
   * Filtered/visible row count, once filters land (M5). Until then the grid
   * leaves it unset and readers show the plain "N rows".
   */
  shownRows?: number;
  /** Last fetch's elapsed time in ms (status bar context info). */
  elapsedMs?: number;
}

interface TabMetaState {
  /** Result meta by tab id. Sparse — only tabs the grid has fetched. */
  meta: Record<string, TabResultMeta>;
  /** Grid → seam: merge a tab's latest fetch result. */
  setTabMeta: (tabId: string, meta: TabResultMeta) => void;
  /** Drop a tab's entry (tab closed). */
  clearTabMeta: (tabId: string) => void;
}

export const useTabMetaStore = create<TabMetaState>((set) => ({
  meta: {},
  setTabMeta: (tabId, meta) =>
    set((state) => ({ meta: { ...state.meta, [tabId]: { ...state.meta[tabId], ...meta } } })),
  clearTabMeta: (tabId) =>
    set((state) => {
      if (!(tabId in state.meta)) return state;
      const next = { ...state.meta };
      delete next[tabId];
      return { meta: next };
    }),
}));

/**
 * Format the "N rows" / "n of N rows" status label from a tab's meta.
 * Returns "— rows" before the first fetch resolves (the M4 placeholder the
 * task calls for). Shared by the table toolbar and the status bar so they
 * never drift.
 */
export function rowCountLabel(meta: TabResultMeta | undefined): string {
  if (!meta || meta.totalRows === undefined) return "— rows";
  if (meta.totalRows === null) return "— rows";
  if (meta.shownRows !== undefined && meta.shownRows !== meta.totalRows) {
    return meta.shownRows.toLocaleString() + " of " + meta.totalRows.toLocaleString() + " rows";
  }
  return meta.totalRows.toLocaleString() + " rows";
}
