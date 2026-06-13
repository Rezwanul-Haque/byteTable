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
   * reports how many rows it has loaded into its sparse window so the toolbar
   * can show "n of N rows" while a large table is still being paged in.
   */
  shownRows?: number;
  /** Last fetch's elapsed time in ms (status bar context info). */
  elapsedMs?: number;
}

interface TabMetaState {
  /** Result meta by tab id. Sparse — only tabs the grid has fetched. */
  meta: Record<string, TabResultMeta>;
  /**
   * Grid vertical scroll offset by tab id (px). High-frequency state, kept
   * out of the persisted workspace `ui` per the WorkspaceUiState churn rule:
   * the grid commits here only on unmount (tab/workspace switch), and reads it
   * back to restore scroll on remount. Survives workspace switches because
   * this store is global, not per-workspace. Sparse — only tabs the grid has
   * scrolled.
   */
  scrollTop: Record<string, number>;
  /**
   * Refresh trigger by tab id: a monotonic nonce the toolbar's refresh button
   * bumps. The mounted grid watches its own tab's nonce and, on change, clears
   * its row cache + re-fetches the current window + re-counts. A nonce (rather
   * than a registered callback) keeps the seam declarative — the toolbar need
   * not know whether a grid is mounted, and there is nothing to unregister.
   */
  refetchNonce: Record<string, number>;
  /** Grid → seam: merge a tab's latest fetch result. */
  setTabMeta: (tabId: string, meta: TabResultMeta) => void;
  /** Grid → seam: remember a tab's scroll offset (on unmount). */
  setTabScrollTop: (tabId: string, scrollTop: number) => void;
  /** Toolbar → grid: bump a tab's refresh nonce. */
  requestRefetch: (tabId: string) => void;
  /** Drop a tab's entry (tab closed). */
  clearTabMeta: (tabId: string) => void;
}

export const useTabMetaStore = create<TabMetaState>((set) => ({
  meta: {},
  scrollTop: {},
  refetchNonce: {},
  setTabMeta: (tabId, meta) =>
    set((state) => ({ meta: { ...state.meta, [tabId]: { ...state.meta[tabId], ...meta } } })),
  setTabScrollTop: (tabId, scrollTop) =>
    set((state) => ({ scrollTop: { ...state.scrollTop, [tabId]: scrollTop } })),
  requestRefetch: (tabId) =>
    set((state) => ({
      refetchNonce: { ...state.refetchNonce, [tabId]: (state.refetchNonce[tabId] ?? 0) + 1 },
    })),
  clearTabMeta: (tabId) =>
    set((state) => {
      const hadMeta = tabId in state.meta;
      const hadScroll = tabId in state.scrollTop;
      const hadNonce = tabId in state.refetchNonce;
      if (!hadMeta && !hadScroll && !hadNonce) return state;
      const meta = { ...state.meta };
      const scrollTop = { ...state.scrollTop };
      const refetchNonce = { ...state.refetchNonce };
      delete meta[tabId];
      delete scrollTop[tabId];
      delete refetchNonce[tabId];
      return { meta, scrollTop, refetchNonce };
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
