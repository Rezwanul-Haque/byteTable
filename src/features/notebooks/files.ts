// Notebooks on disk (M47 §B): new, open, save, save as, recent, and noticing
// a change made outside ByteTable.
//
// Every path comes from the user — a save / open dialog, a drop on the window,
// the OS "Open With", or the recent list built from those.

import { useWorkspacesStore } from "../workspaces/state";
import { selectedSchema, type Workspace } from "../workspaces/types";
import {
  openDialog,
  readNotebookFile,
  saveDialog,
  statNotebookFile,
  writeNotebookFile,
} from "./api";
import example from "./example.md?raw";
import {
  blank,
  fileOf,
  fromMarkdown,
  isUntitled,
  titleFromFile,
  toMarkdown,
  VERSION,
  type Notebook,
} from "./format";
import { isDirty, markdownOf, newDoc, useNotebooksStore, type NotebookDoc } from "./state";

/** The connection name a notebook records (never a host or a password). */
const connectionName = (ws: Workspace) => ws.saved.name;

/** Leaf file name, for titles and messages. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

function openTab(ws: Workspace, nb: Notebook, opts: Parameters<typeof newDoc>[3]): string | null {
  const tabId = useWorkspacesStore.getState().openNotebookTab(nb.title, nb.schema);
  if (!tabId) return null;
  useNotebooksStore.getState().open(newDoc(tabId, ws.id, nb, opts));
  return tabId;
}

/** A new, empty notebook (C2). Pristine, so closing it asks nothing. */
export function newNotebook(ws: Workspace, schema: string): string | null {
  return openTab(ws, blank(connectionName(ws), schema), {});
}

/** The bundled worked example (J5), as an unsaved copy on this connection. */
export function openExample(ws: Workspace, schema: string): string | null {
  const nb = fromMarkdown(example);
  nb.connection = connectionName(ws);
  nb.schema = schema;
  return openTab(ws, nb, { savedMd: null });
}

/** Open a notebook file into the workspace — or focus it, when it is open. */
export async function openNotebookPath(
  path: string,
  ws: Workspace,
  schema: string,
): Promise<string | null> {
  const open = Object.values(useNotebooksStore.getState().docs).find(
    (d) => d.path === path && d.workspaceId === ws.id,
  );
  if (open) {
    useWorkspacesStore.getState().setActiveTab(open.tabId);
    return open.tabId;
  }
  const [text, disk] = await Promise.all([readNotebookFile(path), statNotebookFile(path)]);
  const nb = fromMarkdown(text);
  // A hand-written file opens on its own schema only when it names one.
  if (!nb.schema) nb.schema = schema;
  const tabId = openTab(ws, nb, {
    path,
    // "Saved" is the notebook as parsed: a hand-written file that saving
    // would merely normalise is not "unsaved" the moment it opens.
    savedMd: toMarkdown(nb),
    newerVersion: nb.version > VERSION ? nb.version : null,
  });
  if (tabId) {
    useNotebooksStore.getState().patch(tabId, () => ({ disk }));
    addRecent(ws.saved.id, path, nb.title);
  }
  return tabId;
}

/** Open… — the native dialog, then the file. Null when cancelled. */
export async function openNotebookDialog(ws: Workspace, schema: string): Promise<string | null> {
  const path = await openDialog();
  return path ? openNotebookPath(path, ws, schema) : null;
}

export type SaveOutcome = "saved" | "cancelled" | "refused";

/**
 * Save (B1). The first save — and Save as — asks where, suggesting
 * `fileOf(title)`; later saves write in place. Written atomically by the
 * backend. A file from a newer ByteTable is refused: saving would drop what
 * this build does not understand.
 */
export async function saveNotebook(
  tabId: string,
  opts: { as?: boolean } = {},
): Promise<SaveOutcome> {
  const doc = useNotebooksStore.getState().docs[tabId];
  if (!doc) return "cancelled";
  if (doc.newerVersion != null) return "refused";
  const path = doc.path && !opts.as ? doc.path : await saveDialog(fileOf(doc.nb.title));
  if (!path) return "cancelled";
  // An untitled notebook takes its title from the name it was saved under —
  // before the text is built, so the file's front matter carries it too. A
  // title the user typed is never touched.
  const current = useNotebooksStore.getState().docs[tabId] ?? doc;
  const title = isUntitled(current.nb.title) ? titleFromFile(path) : current.nb.title;
  const named = { ...current, nb: { ...current.nb, title } };
  const md = markdownOf(named);
  await writeNotebookFile(path, md);
  const disk = await statNotebookFile(path).catch(() => null);
  useNotebooksStore.getState().patch(tabId, (d) => ({
    nb: { ...d.nb, title },
    path,
    savedMd: md,
    disk,
    diskChanged: null,
  }));
  useWorkspacesStore.getState().setNotebookTabTitle(tabId, title);
  const ws = useWorkspacesStore.getState().workspaces.find((w) => w.id === doc.workspaceId);
  if (ws) addRecent(ws.saved.id, path, title);
  return "saved";
}

// ---- changed on disk (B3) ---------------------------------------------------

/**
 * Look at the file behind a notebook. Unchanged: nothing. Changed with no
 * unsaved edits here: reload silently. Changed under unsaved edits: hold the
 * new text for the "Reload from disk / Keep mine" banner.
 */
export async function checkDisk(tabId: string): Promise<void> {
  const doc = useNotebooksStore.getState().docs[tabId];
  if (!doc?.path || doc.diskChanged != null) return;
  const stat = await statNotebookFile(doc.path).catch(() => null);
  if (!stat) return; // moved or deleted: keep working; Save recreates it
  const before = doc.disk;
  if (before && before.modifiedMs === stat.modifiedMs && before.size === stat.size) return;
  const text = await readNotebookFile(doc.path).catch(() => null);
  const now = useNotebooksStore.getState().docs[tabId];
  if (text == null || !now) return;
  const theirs = fromMarkdown(text);
  // A touch, or our own save, changes the stat but not the notebook.
  if (toMarkdown(theirs) === now.savedMd) {
    useNotebooksStore.getState().patch(tabId, () => ({ disk: stat }));
    return;
  }
  if (!isDirty(now)) reloadFrom(tabId, theirs, stat);
  else useNotebooksStore.getState().patch(tabId, () => ({ disk: stat, diskChanged: text }));
}

function reloadFrom(tabId: string, nb: Notebook, disk: NotebookDoc["disk"]): void {
  useNotebooksStore.getState().patch(tabId, (d) => ({
    nb,
    keep: d.keep || nb.hadResults,
    savedMd: toMarkdown(nb, { results: d.keep || nb.hadResults }),
    disk,
    diskChanged: null,
    draft: null,
    undo: null,
    newerVersion: nb.version > VERSION ? nb.version : null,
  }));
  useWorkspacesStore.getState().setNotebookTabTitle(tabId, nb.title);
}

/** "Reload from disk": take the file's version, dropping the edits here. */
export function reloadFromDisk(tabId: string): void {
  const doc = useNotebooksStore.getState().docs[tabId];
  if (doc?.diskChanged == null) return;
  reloadFrom(tabId, fromMarkdown(doc.diskChanged), doc.disk);
}

/** "Keep mine": stay on the edits here; the next save overwrites the file. */
export function keepMine(tabId: string): void {
  useNotebooksStore.getState().patch(tabId, () => ({ diskChanged: null }));
}

// ---- recent notebooks (B5) --------------------------------------------------

const RECENT_KEY = "bytetable.notebooks.recent.v1";
const MAX_RECENT = 10;

export interface RecentNotebook {
  path: string;
  title: string;
  at: number;
}

type RecentStore = Record<string, RecentNotebook[]>;

function readRecent(): RecentStore {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentStore) : {};
  } catch {
    return {};
  }
}

/** The last ten notebooks opened or saved in this connection's workspace. */
export function recentFor(connectionId: string): RecentNotebook[] {
  return readRecent()[connectionId] ?? [];
}

function addRecent(connectionId: string, path: string, title: string): void {
  try {
    const all = readRecent();
    const list = (all[connectionId] ?? []).filter((r) => r.path !== path);
    all[connectionId] = [{ path, title, at: Date.now() }, ...list].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
    window.dispatchEvent(new Event(RECENT_EVENT));
  } catch {
    // Blocked storage: Recent is a convenience, the file is still saved.
  }
}

/** Fired when a recent list changes, so the menus can refresh. */
export const RECENT_EVENT = "bytetable:notebooks-recent";

/** Which recent paths still exist — a moved or deleted file is greyed out. */
export async function existingPaths(paths: string[]): Promise<Set<string>> {
  const stats = await Promise.all(paths.map((p) => statNotebookFile(p).catch(() => null)));
  return new Set(paths.filter((_, i) => stats[i] != null));
}

/** The SQL workspace on screen and its schema — where a notebook opens. Null
 *  when none is open (or the open one is Redis, Mongo…: no SQL to run). */
export function activeSqlWorkspace(): { ws: Workspace; schema: string } | null {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!ws || ws.kind !== "sql") return null;
  return { ws, schema: selectedSchema(ws) ?? "main" };
}

/** A notebook path from a drop, the OS, or Recent: open it in the SQL
 *  workspace on screen. Returns false when there is none to open it in. */
export async function openNotebookHere(path: string): Promise<boolean> {
  const here = activeSqlWorkspace();
  if (!here) return false;
  await openNotebookPath(path, here.ws, here.schema);
  return true;
}

export { OPEN_NOTEBOOK_EVENT, requestOpenNotebook } from "./openRequest";
