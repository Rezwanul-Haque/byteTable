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

import type { CellValue, ColumnMeta } from "../../shared/api/engine";

/**
 * A tab's last fetched page, kept so switching back to the tab paints from
 * memory instead of flashing a loading line while the same query runs again.
 *
 * `key` is the identity the page was read under (connection + table + sort +
 * filter + paging). The grid only seeds from a cache whose key still matches
 * what it is about to show; anything else — a new sort, a filter, another page —
 * is a different page and loads normally.
 */
export interface TabPageCache {
  key: string;
  columns: ColumnMeta[];
  /** Rows in page order; the grid re-keys them by absolute index on seed. */
  rows: CellValue[][];
  offset: number;
  totalRows: number | null;
}

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
  /**
   * Discard-staging trigger by tab id — same nonce pattern as `refetchNonce`,
   * and needed for the same reason: the MOUNTED grid holds its staged batch in
   * local state and mirrors it into `ui.gridEdits`, so clearing the store alone
   * would be undone on the grid's next mirror. The grid watches its own tab's
   * nonce and drops its staging when it changes. Unmounted tabs have no local
   * copy, so clearing the store is enough for them.
   */
  discardNonce: Record<string, number>;
  /**
   * Last fetched page by tab id — the switch-back cache (see {@link TabPageCache}).
   * Ephemeral like the rest of this store: it never persists, so a fresh session
   * always reads from the database. One page per tab (≤ the tab's page size), so
   * the ceiling is bounded by how many tabs are open.
   */
  pageCache: Record<string, TabPageCache>;
  /**
   * Tabs whose close is waiting on a discard-unsaved confirm, in the order the
   * close would apply — or null when no confirm is open. Same declarative-seam
   * reasoning as `refetchNonce`: the close can be triggered from the tab's ×,
   * its context menu (which closes a whole set) or ⌘W, and all of them just
   * park the request here so ONE dialog answers for every entry point instead
   * of each owning its own copy of the prompt.
   */
  closeRequest: string[] | null;
  /** Grid → seam: merge a tab's latest fetch result. */
  setTabMeta: (tabId: string, meta: TabResultMeta) => void;
  /** Grid → seam: remember a tab's scroll offset (on unmount). */
  setTabScrollTop: (tabId: string, scrollTop: number) => void;
  /** Toolbar → grid: bump a tab's refresh nonce. */
  requestRefetch: (tabId: string) => void;
  /** Grid → seam: remember the page it just fetched, for the next switch back. */
  setTabPage: (tabId: string, page: TabPageCache) => void;
  /** Tab bar → grid: drop these tabs' staged edits (after the confirm). */
  requestDiscard: (tabIds: string[]) => void;
  /** Close entry point → confirm dialog: ask before discarding these tabs. */
  requestTabClose: (tabIds: string[]) => void;
  /** Confirm dialog → seam: the prompt is answered (either way). */
  clearTabClose: () => void;
  /** Drop a tab's entry (tab closed). */
  clearTabMeta: (tabId: string) => void;
}

export const useTabMetaStore = create<TabMetaState>((set) => ({
  meta: {},
  scrollTop: {},
  refetchNonce: {},
  discardNonce: {},
  pageCache: {},
  closeRequest: null,
  setTabMeta: (tabId, meta) =>
    set((state) => ({ meta: { ...state.meta, [tabId]: { ...state.meta[tabId], ...meta } } })),
  setTabScrollTop: (tabId, scrollTop) =>
    set((state) => ({ scrollTop: { ...state.scrollTop, [tabId]: scrollTop } })),
  requestRefetch: (tabId) =>
    set((state) => {
      // A refresh request means "what you have is stale" — from the toolbar, or
      // from a truncate/import/save that touched this table. Drop the cached
      // page with it, so the tab (mounted or not) reloads for real instead of
      // painting the old rows first.
      const pageCache = { ...state.pageCache };
      delete pageCache[tabId];
      return {
        refetchNonce: { ...state.refetchNonce, [tabId]: (state.refetchNonce[tabId] ?? 0) + 1 },
        pageCache,
      };
    }),
  setTabPage: (tabId, page) =>
    set((state) => ({ pageCache: { ...state.pageCache, [tabId]: page } })),
  requestDiscard: (tabIds) =>
    set((state) => {
      const discardNonce = { ...state.discardNonce };
      for (const tabId of tabIds) discardNonce[tabId] = (discardNonce[tabId] ?? 0) + 1;
      return { discardNonce };
    }),
  requestTabClose: (tabIds) => set({ closeRequest: tabIds }),
  clearTabClose: () => set({ closeRequest: null }),
  clearTabMeta: (tabId) =>
    set((state) => {
      const hadMeta = tabId in state.meta;
      const hadScroll = tabId in state.scrollTop;
      const hadNonce = tabId in state.refetchNonce;
      const hadDiscard = tabId in state.discardNonce;
      const hadPage = tabId in state.pageCache;
      if (!hadMeta && !hadScroll && !hadNonce && !hadDiscard && !hadPage) return state;
      const meta = { ...state.meta };
      const scrollTop = { ...state.scrollTop };
      const refetchNonce = { ...state.refetchNonce };
      const discardNonce = { ...state.discardNonce };
      const pageCache = { ...state.pageCache };
      delete meta[tabId];
      delete scrollTop[tabId];
      delete refetchNonce[tabId];
      delete discardNonce[tabId];
      delete pageCache[tabId];
      return { meta, scrollTop, refetchNonce, discardNonce, pageCache };
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
