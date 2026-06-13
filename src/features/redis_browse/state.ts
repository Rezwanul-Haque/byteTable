// Redis renderer slice's per-workspace UI store (M13). Separate from the
// workspaces store on purpose: REDIS_SPEC §11 keeps the relational and
// key-value renderers from importing each other. The shared workspaces store
// stays SQL-shaped (table/sql/map tabs); the Redis tab model + selected db
// live here, keyed by workspace id so they survive workspace switches exactly
// like the SQL tabs do (the workspaces store owns no Redis state, the App just
// routes `kind === "kv"` to the Redis workspace which reads this store).
//
// Tasks 3 (key viewers) and 4 (CLI + dashboard) fill the *content* of the tab
// kinds this store already models; they consume `openKeyTab` / `openCliTab` /
// `openDashboardTab` + `setDbIndex` + the `bumpVersion` invalidation nonce.

import { create } from "zustand";

import { useWorkspacesStore } from "../workspaces/state";
import type { KeyType } from "./api";

/**
 * One open Redis tab. Discriminated by `kind`; closed union so the content
 * router exhaustively switches.
 *
 * - **dashboard** — the keyspace dashboard. One per workspace, non-closable,
 *   the default tab (REDIS_SPEC §5). Content is Task 4.
 * - **key** — a single key's viewer, scoped to the db it was opened in (a key
 *   name is only unique within a db). `keyType` drives the leading type badge.
 *   Content (type-aware Value/Info viewers) is Task 3.
 * - **cli** — a redis-cli console ("CLI N"). Content is Task 4.
 */
export type RedisTab =
  | { id: string; kind: "dashboard"; closable: false }
  | { id: string; kind: "key"; db: number; key: string; keyType: KeyType }
  | { id: string; kind: "cli"; title: string };

/** Per-workspace Redis UI state, preserved across workspace switches. */
export interface RedisWorkspaceState {
  /** Open tabs, left-to-right. Always starts with the non-closable dashboard. */
  tabs: RedisTab[];
  /** The focused tab id (always references a tab in `tabs`). */
  activeTabId: string;
  /** The selected logical db (0–15) the sidebar lists + tabs open against. */
  dbIndex: number;
  /**
   * Monotonic invalidation nonce. The sidebar + open tabs watch it; a write
   * (Tasks 3–4) or a manual "refresh keyspace" bumps it to force a re-scan /
   * re-fetch. Decouples refresh from a registered callback (the tabMeta seam
   * pattern), so any component can request a reload declaratively.
   */
  version: number;
}

interface RedisBrowseState {
  /** Per-workspace Redis UI, keyed by workspace id. Sparse — populated lazily
   *  the first time a Redis workspace touches the store. */
  byWorkspace: Record<string, RedisWorkspaceState>;
  /**
   * Read a workspace's state, seeding the default (dashboard tab active, db at
   * `initialDb`) on first access. Pure read for render; the seed is written
   * lazily by the actions below, so a plain reader never mutates.
   */
  ensure: (workspaceId: string, initialDb: number) => RedisWorkspaceState;
  /** Switch the selected db and bump the version (re-scan). */
  setDbIndex: (workspaceId: string, initialDb: number, db: number) => void;
  /** Bump the version to force a sidebar re-scan / tab re-fetch. */
  bumpVersion: (workspaceId: string, initialDb: number) => void;
  /**
   * Open (or focus) a key tab for `db`+`key`. An already-open tab for the same
   * db+key is focused instead of duplicating (REDIS_SPEC §5). `keyType` sets
   * the tab's leading badge.
   */
  openKeyTab: (workspaceId: string, initialDb: number, db: number, key: string, keyType: KeyType) => void;
  /** Open a fresh CLI console ("CLI N") and focus it. */
  openCliTab: (workspaceId: string, initialDb: number) => void;
  /** Focus the (single) dashboard tab — it always exists. */
  openDashboardTab: (workspaceId: string, initialDb: number) => void;
  /** Set the active tab (no-op if the id is unknown). */
  setActiveTab: (workspaceId: string, initialDb: number, tabId: string) => void;
  /**
   * Close a tab. The non-closable dashboard is never closed. The left (else
   * right) neighbour becomes active when the closed tab was active.
   */
  closeTab: (workspaceId: string, initialDb: number, tabId: string) => void;
  /** Drop a workspace's entry (workspace closed). */
  clear: (workspaceId: string) => void;
}

const DASHBOARD_ID = "redis-dashboard";

/** The default state a Redis workspace starts with: the dashboard tab only. */
function seed(initialDb: number): RedisWorkspaceState {
  return {
    tabs: [{ id: DASHBOARD_ID, kind: "dashboard", closable: false }],
    activeTabId: DASHBOARD_ID,
    dbIndex: initialDb,
    version: 0,
  };
}

/**
 * Per-workspace "CLI N" numbering — module-local naming state (mirrors the SQL
 * `sqlCounters` pattern in the workspaces store): it only increments and is
 * not renderable UI, so it stays out of the store.
 */
const cliCounters = new Map<string, number>();
function nextCliTitle(workspaceId: string): string {
  const n = (cliCounters.get(workspaceId) ?? 0) + 1;
  cliCounters.set(workspaceId, n);
  return "CLI " + n;
}

/** A workspace-scoped unique tab id. */
function newTabId(kind: RedisTab["kind"]): string {
  return "rtab-" + kind + "-" + crypto.randomUUID();
}

export const useRedisBrowseStore = create<RedisBrowseState>((set, get) => {
  /** Get-or-seed a workspace's state without writing (for the actions below). */
  const current = (workspaceId: string, initialDb: number): RedisWorkspaceState =>
    get().byWorkspace[workspaceId] ?? seed(initialDb);

  /** Commit a workspace's next state. */
  const put = (workspaceId: string, next: RedisWorkspaceState) =>
    set((state) => ({ byWorkspace: { ...state.byWorkspace, [workspaceId]: next } }));

  return {
    byWorkspace: {},

    ensure: (workspaceId, initialDb) => current(workspaceId, initialDb),

    setDbIndex: (workspaceId, initialDb, db) => {
      const ws = current(workspaceId, initialDb);
      put(workspaceId, { ...ws, dbIndex: db, version: ws.version + 1 });
    },

    bumpVersion: (workspaceId, initialDb) => {
      const ws = current(workspaceId, initialDb);
      put(workspaceId, { ...ws, version: ws.version + 1 });
    },

    openKeyTab: (workspaceId, initialDb, db, key, keyType) => {
      const ws = current(workspaceId, initialDb);
      const existing = ws.tabs.find((t) => t.kind === "key" && t.db === db && t.key === key);
      if (existing) {
        put(workspaceId, { ...ws, activeTabId: existing.id });
        return;
      }
      const tab: RedisTab = { id: newTabId("key"), kind: "key", db, key, keyType };
      put(workspaceId, { ...ws, tabs: [...ws.tabs, tab], activeTabId: tab.id });
    },

    openCliTab: (workspaceId, initialDb) => {
      const ws = current(workspaceId, initialDb);
      const tab: RedisTab = { id: newTabId("cli"), kind: "cli", title: nextCliTitle(workspaceId) };
      put(workspaceId, { ...ws, tabs: [...ws.tabs, tab], activeTabId: tab.id });
    },

    openDashboardTab: (workspaceId, initialDb) => {
      const ws = current(workspaceId, initialDb);
      const dash = ws.tabs.find((t) => t.kind === "dashboard");
      if (dash) put(workspaceId, { ...ws, activeTabId: dash.id });
    },

    setActiveTab: (workspaceId, initialDb, tabId) => {
      const ws = current(workspaceId, initialDb);
      if (ws.tabs.some((t) => t.id === tabId)) put(workspaceId, { ...ws, activeTabId: tabId });
    },

    closeTab: (workspaceId, initialDb, tabId) => {
      const ws = current(workspaceId, initialDb);
      const idx = ws.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;
      const target = ws.tabs[idx];
      // The dashboard is non-closable (REDIS_SPEC §5).
      if (target?.kind === "dashboard") return;
      const tabs = ws.tabs.filter((t) => t.id !== tabId);
      const activeTabId =
        ws.activeTabId === tabId
          ? (tabs[Math.max(0, idx - 1)]?.id ?? DASHBOARD_ID)
          : ws.activeTabId;
      put(workspaceId, { ...ws, tabs, activeTabId });
    },

    clear: (workspaceId) => {
      cliCounters.delete(workspaceId);
      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const byWorkspace = { ...state.byWorkspace };
        delete byWorkspace[workspaceId];
        return { byWorkspace };
      });
    },
  };
});

// Prune a workspace's Redis UI when it closes. Rather than have the SQL
// workspaces store reach into this slice (it must not — REDIS_SPEC §11), this
// slice subscribes to the workspaces store and drops entries for ids that no
// longer exist — the same one-way prune the SQL "Query N" counters use. Cheap
// (workspace count is tiny) and keeps both stores' actions pure.
useWorkspacesStore.subscribe((state) => {
  const store = useRedisBrowseStore.getState();
  const ids = Object.keys(store.byWorkspace);
  if (ids.length === 0 && cliCounters.size === 0) return;
  const live = new Set(state.workspaces.map((ws) => ws.id));
  for (const id of ids) {
    if (!live.has(id)) store.clear(id);
  }
  for (const id of cliCounters.keys()) {
    if (!live.has(id)) cliCounters.delete(id);
  }
});
