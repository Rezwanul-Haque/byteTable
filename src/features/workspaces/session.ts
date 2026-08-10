// Per-connection session persistence — what makes Settings › Behavior ›
// "Restore tabs" real.
//
// Model: the session is keyed by **saved connection id**, not by launch. When
// you open a connection — at startup, later in the day, in a second window —
// its tabs, focused tab, schema, unsaved SQL, and grid filters/sorts come back.
// Nothing auto-connects: opening a connection is always the user's move, so a
// stopped server or a production database never costs anything at launch.
//
// Storage is localStorage, the same place the settings fast-path lives: a
// session is cheap to rebuild and not worth a backend round trip. Closing a
// workspace deliberately KEEPS its entry — closing and reopening is the most
// common way to get your tabs back.
//
// What is deliberately NOT stored:
//   - SQL result sets (`runs`) — potentially huge, and re-running is one click.
//   - Structure-editor drafts — a pending ALTER restored against a table that
//     changed underneath would be worse than losing it.
//   - Live handles, of course; every restored tab refetches on mount.

import type { Tab, WorkspaceUiState } from "./types";

const STORAGE_KEY = "bytetable.session.v1";

/** Most connections kept. Oldest entries are dropped first. */
const MAX_CONNECTIONS = 20;

/** Tab kinds this build can render — anything else (a newer build's tab) is
 *  dropped on read so the content router never meets an unknown kind. */
const KNOWN_KINDS = new Set<Tab["kind"]>([
  "table",
  "sql",
  "map",
  "processes",
  "object",
  "objexplorer",
  "diff",
]);

interface StoredSession {
  ui: WorkspaceUiState;
  /** Epoch ms of the last write — the pruning order. */
  savedAt: number;
  /**
   * Schema sub-workspaces of this connection that the user KEPT (M32), and
   * their own sessions. Nested under the connection rather than keyed
   * separately so one entry still holds everything for one connection — the
   * pruning above stays correct, and a child can never outlive its parent's
   * entry.
   *
   * Temporary sub-workspaces are deliberately absent: not restoring them is
   * what "temporary" means.
   *
   * The tile `color` rides along because a sub-workspace picks its own from the
   * palette (and can be recoloured): without it a kept child would come back
   * wearing its parent's colour, silently discarding the user's choice.
   */
  schemas?: Record<string, { ui: WorkspaceUiState; color?: string }>;
}

type StoredSessions = Record<string, StoredSession>;

function readAll(): StoredSessions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as StoredSessions;
  } catch {
    // Unreadable or corrupt storage is not worth surfacing: the user simply
    // starts with no restored tabs.
    return {};
  }
}

function writeAll(sessions: StoredSessions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Quota or a locked-down webview — best-effort, exactly like the settings
    // mirror.
  }
}

/**
 * Strip a UI state down to what is worth persisting. Notably: a SQL tab keeps
 * its buffer and history but loses its result sets, and structure-editor drafts
 * are dropped entirely.
 */
function forStorage(ui: WorkspaceUiState): WorkspaceUiState {
  const tabs = (ui.tabs ?? []).map((tab) =>
    tab.kind === "sql" ? { ...tab, runs: [], activeRunId: null } : tab,
  );
  const activeTabId =
    ui.activeTabId !== undefined && tabs.some((t) => t.id === ui.activeTabId)
      ? ui.activeTabId
      : (tabs[0]?.id ?? null);
  return {
    schemaName: ui.schemaName,
    expandedTables: ui.expandedTables,
    tabs,
    activeTabId,
    filters: ui.filters,
    tableViews: ui.tableViews,
  };
}

/** Defensively narrow a stored blob back to a usable UI state. */
function fromStorage(ui: unknown): WorkspaceUiState | null {
  if (!ui || typeof ui !== "object") return null;
  const candidate = ui as WorkspaceUiState;
  const tabs = Array.isArray(candidate.tabs) ? candidate.tabs : [];
  const usable = tabs.filter(
    (tab): tab is Tab =>
      !!tab && typeof tab.id === "string" && KNOWN_KINDS.has(tab.kind as Tab["kind"]),
  );
  if (usable.length === 0) return null;
  const activeTabId =
    typeof candidate.activeTabId === "string" && usable.some((t) => t.id === candidate.activeTabId)
      ? candidate.activeTabId
      : (usable[0]?.id ?? null);
  return {
    schemaName: typeof candidate.schemaName === "string" ? candidate.schemaName : undefined,
    expandedTables: Array.isArray(candidate.expandedTables) ? candidate.expandedTables : undefined,
    tabs: usable,
    activeTabId,
    filters: candidate.filters,
    tableViews: candidate.tableViews,
  };
}

/**
 * The stored session for one saved connection, or `null` when there is none
 * (or it held nothing worth restoring). Callers gate on the user's setting.
 */
export function readSession(connectionId: string): WorkspaceUiState | null {
  if (!connectionId) return null;
  const stored = readAll()[connectionId];
  return stored ? fromStorage(stored.ui) : null;
}

/** The kept schema sub-workspaces of a connection, in stored order (M32). */
export function readKeptSchemas(connectionId: string): string[] {
  if (!connectionId) return [];
  return Object.keys(readAll()[connectionId]?.schemas ?? {});
}

/** One kept sub-workspace's own session, or `null`. */
export function readSchemaSession(connectionId: string, schema: string): WorkspaceUiState | null {
  if (!connectionId) return null;
  const stored = readAll()[connectionId]?.schemas?.[schema];
  return stored?.ui ? fromStorage(stored.ui) : null;
}

/** One kept sub-workspace's stored tile colour, or `null` to pick a fresh one. */
export function readSchemaColor(connectionId: string, schema: string): string | null {
  if (!connectionId) return null;
  return readAll()[connectionId]?.schemas?.[schema]?.color ?? null;
}

/**
 * Persist one connection's KEPT schema sub-workspaces, replacing whatever was
 * stored. Passing an empty list clears them — which is what closing or
 * un-keeping the last one should do.
 */
export function writeSchemaSessions(
  connectionId: string,
  schemas: { schema: string; ui: WorkspaceUiState; color: string }[],
): void {
  if (!connectionId) return;
  const sessions = readAll();
  const entry = sessions[connectionId];
  // Nothing to attach to yet: the parent's own session is written first (both
  // happen in the same flush), so this is only reachable for a connection with
  // no id — already guarded above.
  if (!entry) return;
  if (schemas.length === 0) {
    delete entry.schemas;
  } else {
    entry.schemas = Object.fromEntries(
      schemas.map((s) => [s.schema, { ui: forStorage(s.ui), color: s.color }]),
    );
  }
  writeAll(sessions);
}

/**
 * Persist one connection's session. Entries for connections that are not open
 * right now are left untouched — that is what lets a closed workspace come
 * back with its tabs.
 */
export function writeSession(connectionId: string, ui: WorkspaceUiState): void {
  if (!connectionId) return;
  const sessions = readAll();
  sessions[connectionId] = { ui: forStorage(ui), savedAt: Date.now() };

  const ids = Object.keys(sessions);
  if (ids.length > MAX_CONNECTIONS) {
    const oldestFirst = ids.sort(
      (a, b) => (sessions[a]?.savedAt ?? 0) - (sessions[b]?.savedAt ?? 0),
    );
    for (const id of oldestFirst.slice(0, ids.length - MAX_CONNECTIONS)) delete sessions[id];
  }
  writeAll(sessions);
}

/** Forget every stored session — used when the user turns the setting off. */
export function clearSessions(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the next write will overwrite it anyway.
  }
}
