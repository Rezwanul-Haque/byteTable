// Open notebooks (M47), one document per notebook TAB.
//
// The workspace store holds the tab itself (id, title, schema), like any tab;
// the notebook's cells, results and file state live here, keyed by tab id,
// because WorkspaceContent mounts only the active tab and a notebook must
// survive being switched away from — including a query still running in it.
//
// Not persisted across launches: the FILE is the notebook. A saved notebook
// comes back from Recent; an unsaved one is protected by the close and quit
// prompts instead.

import { create } from "zustand";

import { isCurrent, toMarkdown, type Cell, type Notebook, type QueryCell } from "./format";

export interface NotebookDoc {
  tabId: string;
  /** The workspace the tab belongs to. */
  workspaceId: string;
  nb: Notebook;
  /** "Keep results in the file". */
  keep: boolean;
  mode: "cells" | "file";
  /** Where it is saved; null until the first save. */
  path: string | null;
  /** The text last saved or opened — dirty is "the file would differ".
   *  Null for a copy never saved (the bundled example). */
  savedMd: string | null;
  /** The File view's edits, not yet applied. */
  draft: string | null;
  /** The last deleted cell, for Undo. */
  undo: { cell: Cell; index: number } | null;
  /** A cell just added: it takes focus once. */
  fresh: string | null;
  /** Run all in progress. */
  runAll: { done: number; total: number; stopping: boolean } | null;
  /** The file's last known stat, for noticing outside changes (B3). */
  disk: { modifiedMs: number; size: number } | null;
  /** The file changed on disk while this had unsaved edits: its new text. */
  diskChanged: string | null;
  /** The file was written by a newer ByteTable (`notebook/N`, N > ours). It
   *  opens read-only and cannot be saved over (A5). */
  newerVersion: number | null;
}

export interface NotebooksState {
  docs: Record<string, NotebookDoc>;
  /** A workspace close waiting on the unsaved-notebooks prompt (B4). */
  pendingWorkspaceClose: { workspaceId: string; close: () => void } | null;
  setPendingWorkspaceClose: (pending: NotebooksState["pendingWorkspaceClose"]) => void;
  open: (doc: NotebookDoc) => void;
  close: (tabId: string) => void;
  patch: (tabId: string, update: (doc: NotebookDoc) => Partial<NotebookDoc>) => void;
  patchNb: (tabId: string, update: (nb: Notebook) => Partial<Notebook>) => void;
  patchCell: (tabId: string, cellId: string, patch: Partial<QueryCell> | Partial<Cell>) => void;
}

export const useNotebooksStore = create<NotebooksState>((set) => ({
  docs: {},
  pendingWorkspaceClose: null,
  setPendingWorkspaceClose: (pendingWorkspaceClose) => set({ pendingWorkspaceClose }),
  open: (doc) => set((s) => ({ docs: { ...s.docs, [doc.tabId]: doc } })),
  close: (tabId) =>
    set((s) => {
      if (!(tabId in s.docs)) return s;
      const docs = { ...s.docs };
      delete docs[tabId];
      return { docs };
    }),
  patch: (tabId, update) =>
    set((s) => {
      const doc = s.docs[tabId];
      if (!doc) return s;
      return { docs: { ...s.docs, [tabId]: { ...doc, ...update(doc) } } };
    }),
  patchNb: (tabId, update) =>
    set((s) => {
      const doc = s.docs[tabId];
      if (!doc) return s;
      return { docs: { ...s.docs, [tabId]: { ...doc, nb: { ...doc.nb, ...update(doc.nb) } } } };
    }),
  patchCell: (tabId, cellId, patch) =>
    set((s) => {
      const doc = s.docs[tabId];
      if (!doc) return s;
      const cells = doc.nb.cells.map((c) => (c.id === cellId ? ({ ...c, ...patch } as Cell) : c));
      return { docs: { ...s.docs, [tabId]: { ...doc, nb: { ...doc.nb, cells } } } };
    }),
}));

/** The file text this notebook would save. */
export const markdownOf = (doc: NotebookDoc) => toMarkdown(doc.nb, { results: doc.keep });

/** Saving would change the file (or it was never saved). */
export const isDirty = (doc: NotebookDoc) => markdownOf(doc) !== doc.savedMd;

/** Tabs whose notebook has unsaved changes. */
export function dirtyNotebookTabs(docs: Record<string, NotebookDoc>): Set<string> {
  const out = new Set<string>();
  for (const doc of Object.values(docs)) if (isDirty(doc)) out.add(doc.tabId);
  return out;
}

/** Query cells and how many hold a current result — the document footer. */
export function counts(nb: Notebook): { queries: number; current: number } {
  const q = nb.cells.filter((c): c is QueryCell => c.type === "query");
  return { queries: q.length, current: q.filter(isCurrent).length };
}

/** A fresh document for a tab. */
export function newDoc(
  tabId: string,
  workspaceId: string,
  nb: Notebook,
  opts: { path?: string | null; savedMd?: string | null; newerVersion?: number | null } = {},
): NotebookDoc {
  return {
    tabId,
    workspaceId,
    nb,
    keep: true,
    mode: "cells",
    path: opts.path ?? null,
    savedMd: opts.savedMd === undefined ? toMarkdown(nb) : opts.savedMd,
    draft: null,
    undo: null,
    fresh: null,
    runAll: null,
    disk: null,
    diskChanged: null,
    newerVersion: opts.newerVersion ?? null,
  };
}

/** The workspace's notebook tabs with unsaved changes. */
export function dirtyNotebooksIn(docs: Record<string, NotebookDoc>, workspaceId: string): string[] {
  return [...dirtyNotebookTabs(docs)].filter((id) => docs[id]?.workspaceId === workspaceId);
}

/**
 * Close a workspace — unless notebooks in it have unsaved changes, in which
 * case the close waits for the Save / Discard / Cancel prompt (App renders
 * it). Every way of closing a workspace goes through here.
 */
export function guardWorkspaceClose(workspaceId: string, close: () => void): void {
  const { docs, setPendingWorkspaceClose } = useNotebooksStore.getState();
  if (dirtyNotebooksIn(docs, workspaceId).length > 0)
    setPendingWorkspaceClose({ workspaceId, close });
  else close();
}
