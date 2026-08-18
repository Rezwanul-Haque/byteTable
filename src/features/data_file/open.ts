// Opening a data file as a workspace (M35 Task 7) — the async bridge between
// the open sheet and the synchronous workspaces store, mirroring the connect
// slice's `useConnectAndOpen` / `useOpenSqliteFile`.
//
// Error contract, same as connect.ts: these hooks toast the backend's human
// message themselves and resolve to a falsy value instead of rethrowing, so
// callers only branch on the result.

import { useCallback } from "react";

import { appErrorMessage } from "../../shared/api/error";
import { useToast } from "../../shared/ui/toastContext";
import type { SavedConnection } from "../connections/api";
import { useWorkspacesStore } from "../workspaces/state";
import type { DataFileRef, WorkspaceConnection } from "../workspaces/types";
import { adhocSchema, analyze, parse, tableName } from "./core";
import type { EditBatch } from "./csvWrite";
import { saveDataFile } from "./save";
import { closeScratchDatabase, loadDataFile } from "./sqlSession";
import { useDataFileStore } from "./state";

/**
 * The registry entry a data-file workspace carries. It is never saved: `id` is
 * empty, which is exactly the "ad-hoc open" case `sessionSync` already skips,
 * and the connect screen only ever lists entries the backend returned.
 *
 * `engine: "sqlite"` is the truth about the handle — the file's rows really do
 * live in an in-memory SQLite database. What the user sees is driven by
 * `workspace.file` (the `csv` badge, the file name, the saved/unsaved tag), not by
 * this.
 */
function scratchConnection(file: DataFileRef): SavedConnection {
  return {
    id: "",
    name: file.name,
    engine: "sqlite",
    params: { engine: "sqlite", path: ":memory:" },
    env: "dev",
  };
}

/** Load `file` into a fresh scratch database and describe the connection. */
async function connectFile(file: DataFileRef): Promise<WorkspaceConnection> {
  const parsed = parse(file.text, file.opts);
  const analysis = analyze(parsed);
  const schema = adhocSchema(tableName(file.name), analysis.cols, parsed.rows.length);
  const session = await loadDataFile(schema, analysis.cols, parsed.rows);
  return {
    saved: scratchConnection(file),
    handleId: session.handleId,
    info: { engine: "sqlite", serverVersion: session.serverVersion },
    // One schema, one table — the viewer never shows a schema switcher, but
    // the shared plumbing expects a non-empty list.
    schemas: [{ name: "main", tableCount: 1, isSystem: false }],
    kind: "sql",
  };
}

/**
 * Open a delimited file as a new workspace. Resolves to the file name
 * on success; null means the failure was already toasted here.
 */
export function useOpenDataFile(): (file: DataFileRef) => Promise<string | null> {
  const openFileWorkspace = useWorkspacesStore((state) => state.openFileWorkspace);
  const toast = useToast();

  return useCallback(
    async (file) => {
      try {
        openFileWorkspace(await connectFile(file), file);
        return file.name;
      } catch (error) {
        toast(appErrorMessage(error, "Could not open “" + file.name + "”"), "err");
        return null;
      }
    },
    [openFileWorkspace, toast],
  );
}

/**
 * Re-open an EXISTING data-file workspace on a different file (or the same file
 * with different parse options), from the viewer's own parse pill.
 *
 * The new scratch database is loaded BEFORE the old one is released, so a
 * failure leaves the workspace showing the file it already had rather than an
 * empty shell.
 */
export function useReplaceDataFile(): (
  workspaceId: string,
  previousHandleId: string,
  file: DataFileRef,
) => Promise<string | null> {
  const replaceWorkspaceFile = useWorkspacesStore((state) => state.replaceWorkspaceFile);
  const toast = useToast();

  return useCallback(
    async (workspaceId, previousHandleId, file) => {
      try {
        const connection = await connectFile(file);
        replaceWorkspaceFile(workspaceId, connection, file);
        // The view state names columns and row indexes of the OLD file, so it
        // is reset here — at the one moment the file actually changes, rather
        // than from an effect that would also fire on every workspace switch.
        useDataFileStore.getState().reset(workspaceId);
        // Only now is the previous scratch database dead weight.
        if (previousHandleId !== connection.handleId) closeScratchDatabase(previousHandleId);
        return file.name;
      } catch (error) {
        toast(appErrorMessage(error, "Could not open “" + file.name + "”"), "err");
        return null;
      }
    },
    [replaceWorkspaceFile, toast],
  );
}

/** Where a save is going, and what it means for the open workspace. */
export interface SaveTarget {
  /** Absolute path to write. */
  path: string;
  /** Keep the previous contents as `<name>.bak` (an in-place overwrite does). */
  backup: boolean;
  /** The workspace's new display name — a copy re-points the viewer at itself. */
  name: string;
}

/**
 * Write the staged batch to disk and adopt the result.
 *
 * Order matters: the file is written FIRST, and only a successful write clears
 * the staged batch. A failed save leaves every edit exactly where it was, so
 * nothing is lost to a full disk or a read-only file.
 *
 * The workspace's scratch database is then rebuilt from the saved text —
 * otherwise the SQL tab would keep answering with the pre-edit rows. View state
 * (filters, sort, hidden columns) survives; only the row-index-based problem
 * filter is dropped, and only when rows were added or removed, because those
 * indexes have shifted.
 *
 * Resolves the saved file name, or null when the failure was already toasted.
 */
export function useSaveDataFile(): (
  workspaceId: string,
  previousHandleId: string,
  file: DataFileRef,
  batch: EditBatch,
  target: SaveTarget,
) => Promise<string | null> {
  const replaceWorkspaceFile = useWorkspacesStore((state) => state.replaceWorkspaceFile);
  const toast = useToast();

  return useCallback(
    async (workspaceId, previousHandleId, file, batch, target) => {
      const parsed = parse(file.text, file.opts);
      let text: string;
      try {
        text = await saveDataFile(target.path, file.text, parsed, batch, target.backup);
      } catch (error) {
        toast(appErrorMessage(error, "Could not save “" + file.name + "”"), "err");
        return null;
      }

      const saved: DataFileRef = {
        ...file,
        name: target.name,
        path: target.path,
        text,
        size: new Blob([text]).size,
      };
      const store = useDataFileStore.getState();
      // The write succeeded, so the batch is now on disk: clear it before
      // anything else can fail.
      store.commitEdits(workspaceId);
      if (batch.added.length > 0 || batch.deleted.length > 0) {
        store.patch(workspaceId, { rowFilter: null });
      }

      try {
        const connection = await connectFile(saved);
        replaceWorkspaceFile(workspaceId, connection, saved);
        if (previousHandleId !== connection.handleId) closeScratchDatabase(previousHandleId);
      } catch (error) {
        // The file IS saved; only the queryable copy is stale. Say so rather
        // than implying the save failed.
        toast(
          appErrorMessage(
            error,
            "Saved, but the SQL view could not be refreshed — re-open the file.",
          ),
          "err",
        );
      }
      return target.name;
    },
    [replaceWorkspaceFile, toast],
  );
}
