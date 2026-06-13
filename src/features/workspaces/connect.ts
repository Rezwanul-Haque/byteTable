// Connect flow — the async bridge between the connections backend and the
// synchronous workspaces store. Lives outside the store on purpose: a store
// action that awaits IPC would smear connection latency into every state
// transition; instead these hooks await `connection_open` and only then call
// `openWorkspace` with the real payload.
//
// Error contract: both hooks toast the backend's human message (spec §5)
// themselves and resolve to a falsy value instead of rethrowing — falsy =
// already handled + toasted, so callers only branch on the result (success
// toast, spinner reset) and never need their own catch.

import { useCallback } from "react";

import { appErrorMessage } from "../../shared/api/error";
import { useToast } from "../../shared/ui/toastContext";
import {
  connectionOpen,
  type ConnectionParams,
  type OpenResult,
  type SavedConnection,
} from "../connections/api";
import { useConnectionsStore } from "../connections/state";
import { useWorkspacesStore } from "./state";
import type { WorkspaceConnection } from "./types";

function toWorkspaceConnection(saved: SavedConnection, opened: OpenResult): WorkspaceConnection {
  return {
    saved,
    handleId: opened.handleId,
    info: opened.engineInfo,
    schemas: opened.schemas,
    // M13: the engine family the App routes on, plus the Redis overview (only
    // populated for kind === "kv"). Both ride straight off the open result.
    kind: opened.kind,
    keyspace: opened.keyspace,
  };
}

/** "name.db" → "name"; a stem-less name like ".db" falls back whole. */
function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const stem = base.replace(/\.[^.]+$/, "");
  return stem || base;
}

/**
 * Connect to a saved registry entry and open a workspace around it.
 * Resolves true when the workspace opened; false means the failure was
 * already handled and toasted here (see module note).
 */
export function useConnectAndOpen(): (saved: SavedConnection) => Promise<boolean> {
  const openWorkspace = useWorkspacesStore((state) => state.openWorkspace);
  const toast = useToast();

  return useCallback(
    async (saved) => {
      try {
        const opened = await connectionOpen({ id: saved.id });
        openWorkspace(toWorkspaceConnection(saved, opened));
        return true;
      } catch (error) {
        toast(appErrorMessage(error, "Could not connect to “" + saved.name + "”"), "err");
        return false;
      }
    },
    [openWorkspace, toast],
  );
}

/**
 * "Open SQLite file…": connect to a picked file path ad-hoc (no
 * `connection_test` round-trip — open *is* the test for a local file; the
 * test command is for the new-connection modal, Task 3), then open a
 * workspace. Resolves to the workspace display name (for the success toast)
 * when opened; null means the failure was already handled and toasted here
 * (falsy = handled, see module note).
 *
 * Product decision: a successfully opened file is auto-saved to the registry
 * (name = file stem, env "dev") so it appears in the connect list next
 * launch — "open once, saved forever" beats a separate save step for local
 * files. If the registry already holds an entry for the same file path, that
 * entry is reused instead (repeated opens must not stack duplicate cards).
 * If the auto-save itself fails, the open still succeeded, so the workspace
 * opens with an ephemeral (unsaved) entry and the failure is surfaced as its
 * own toast.
 */
export function useOpenSqliteFile(): (path: string) => Promise<string | null> {
  const openWorkspace = useWorkspacesStore((state) => state.openWorkspace);
  const saveConnection = useConnectionsStore((state) => state.save);
  const toast = useToast();

  return useCallback(
    async (path) => {
      const params: ConnectionParams = { engine: "sqlite", path };
      let opened: OpenResult;
      try {
        opened = await connectionOpen({ params });
      } catch (error) {
        toast(appErrorMessage(error, "Could not open " + path), "err");
        return null;
      }

      // Reuse an existing registry entry for this exact file before saving a
      // new one — auto-save on every open would otherwise stack duplicate
      // cards. Read via getState() at call time: no subscription needed, and
      // the list is current even if it changed since this callback was made.
      const existing = useConnectionsStore
        .getState()
        .savedConnections.find((c) => c.params.engine === "sqlite" && c.params.path === path);
      if (existing) {
        openWorkspace(toWorkspaceConnection(existing, opened));
        return existing.name;
      }

      let saved: SavedConnection = {
        id: "",
        name: fileStem(path),
        engine: "sqlite",
        params,
        env: "dev",
      };
      try {
        saved = await saveConnection(saved);
      } catch (error) {
        toast(
          appErrorMessage(error, "Connected, but the file could not be added to saved connections"),
          "err",
        );
      }

      openWorkspace(toWorkspaceConnection(saved, opened));
      return saved.name;
    },
    [openWorkspace, saveConnection, toast],
  );
}
