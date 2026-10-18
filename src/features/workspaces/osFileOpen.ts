// OS file-association bridge: opening a `.sqlite` / `.sqlite3` / `.db` database
// or a `.sql` script by double-clicking it in Finder / Explorer / a file
// manager.
//
// The Rust slice (`features/file_open`) receives the path — an Apple Event on
// macOS, argv on Windows/Linux — classifies it, and QUEUES it. This module
// PULLS; nothing is ever pushed to it:
//
//   1. DRAIN on mount — the cold start, where the double-click is what launched
//      the app and the path was queued before this code existed.
//   2. DRAIN again on every `file-open://pending` nudge — the warm case, where
//      ByteTable is already running and the OS hands it another file.
//
// Both call the same command, which is the only way a path leaves the queue, so
// they cannot double-open and a missed nudge cannot lose a file. The event
// carries no payload for exactly that reason: a cold open fires it before this
// listener is attached, and a payload delivered to nobody would be gone.
//
// A DATABASE AND A SCRIPT ARE NOT THE SAME ERRAND. A database becomes a
// workspace, so it can always be opened. A script is just text, and ByteTable's
// editor is per-workspace — a `.sql` file has no connection of its own to run
// against. So the script splits by what is actually possible:
//
//   - a SQL workspace is open → a real editor tab, titled after the file. It
//                               can run, so it should.
//   - anything else           → the read-only SqlFileViewer, which needs no
//                               connection (see that file for why it is not an
//                               editor).
//
// "Anything else" is NOT just "nothing open". Redis, DynamoDB, MongoDB,
// Cassandra and Typesense each have their own shell and their own query
// language, and each renders only the tab kinds it knows — a `sql` tab pushed
// into one would appear in the strip with a BLANK PANE behind it, unrunnable
// and unreadable. A SQL script in front of a DynamoDB connection has nothing to
// run against, exactly like having no connection at all, so it gets the same
// read-only view.
//
// An earlier version HELD the script until the user connected. That made a
// double-click do nothing visible and promised something later, which is what
// the viewer replaces.
//
// No-ops in plain-browser dev, like the tray bridge: `invoke` is imported
// statically (as every api.ts does — it only throws when CALLED) and the event
// module dynamically, so a missing backend never throws at import time.

import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import { appErrorMessage } from "../../shared/api/error";
import { useToast } from "../../shared/ui/toastContext";
import { useT } from "../../shared/i18n/useT";
import { engineLabel } from "../../shared/ui/engineMeta";
import { useOpenSqliteFile } from "./connect";
import { useWorkspacesStore } from "./state";
import { workspaceBadge } from "./types";

/** Nudge from Rust meaning "drain the queue". Matches `FILE_OPEN_EVENT`. */
const FILE_OPEN_EVENT = "file-open://pending";

/** One path the OS handed us. Matches the Rust `PendingOpen`. */
interface PendingOpen {
  path: string;
  kind: "database" | "script";
}

/** Leaf file name, for the tab title and messages. Handles both separators —
 *  the path came from the OS, not from us. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The script currently shown in the read-only viewer, if any. */
export interface ViewedScript {
  name: string;
  sql: string;
  /** The engine of the open workspace when it cannot run SQL, for the viewer's
   *  explanation; absent when nothing is open at all. The two cases look the
   *  same on screen but have different answers ("connect" vs "connect to
   *  something relational"). */
  engine?: string;
}

/**
 * Open databases and SQL scripts the OS asked ByteTable to open. Mount once, at
 * the app root.
 *
 * Returns the script to show read-only (null when there is none) rather than
 * rendering it, so the modal lives in the component tree at the app root where
 * it can mount over the connect screen.
 */
export function useOsFileOpen(): { viewed: ViewedScript | null; dismiss: () => void } {
  const openSqliteFile = useOpenSqliteFile();
  const openSqlTabWith = useWorkspacesStore((state) => state.openSqlTabWith);
  const toast = useToast();
  const t = useT();

  const [viewed, setViewed] = useState<ViewedScript | null>(null);
  /** Guards the viewer against being replaced mid-read by a second script in
   *  the same batch — the first one stays up until dismissed. */
  const viewerBusy = useRef(false);

  /** Read one script and either open it as an editor tab (a SQL workspace is
   *  open, so it can run) or show it read-only (nothing can run it here). */
  const openScript = useCallback(
    async (path: string) => {
      let sql: string;
      try {
        sql = await invoke<string>("file_open_read_script", { path });
      } catch (error) {
        toast(
          appErrorMessage(error, t("shell.fileOpen.scriptFailed", { name: baseName(path) })),
          "err",
        );
        return;
      }
      // Read at call time, not from a subscription: the batch is sequential and
      // an earlier database in it may have just opened a workspace.
      const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
      const active = workspaces.find((ws) => ws.id === activeWorkspaceId);
      // `kind === "sql"` is the relational family AND the data-file viewer,
      // whose rows live in a private in-memory SQLite that the SQL tab queries
      // through the ordinary path. Everything else cannot run this.
      if (active?.kind === "sql") {
        openSqlTabWith(sql, null, baseName(path));
        toast(t("shell.fileOpen.scriptOpened", { name: baseName(path) }), "ok");
        return;
      }
      if (viewerBusy.current) return;
      viewerBusy.current = true;
      setViewed({
        name: baseName(path),
        sql,
        engine: active ? engineLabel(workspaceBadge(active)) : undefined,
      });
    },
    [openSqlTabWith, toast, t],
  );

  /**
   * Handle one batch, in order: a multi-file open (selecting a database and its
   * seed script together) should land in the order given, and each open mutates
   * the same workspace store.
   *
   * Order matters for a mixed batch: a database opened first gives the script
   * after it a workspace to land in as a real editor tab, instead of the
   * read-only viewer. The OS order is the user's order, so it is left alone.
   */
  const openAll = useCallback(
    async (items: PendingOpen[]) => {
      for (const item of items) {
        if (item.kind === "database") {
          // Failures are already toasted inside the connect flow.
          const name = await openSqliteFile(item.path);
          if (name) toast(t("shell.fileOpen.opened", { name }), "ok");
          continue;
        }
        await openScript(item.path);
      }
    },
    [openSqliteFile, openScript, toast, t],
  );

  /** Take everything queued and open it. The command empties the queue
   *  atomically, so concurrent drains split the work rather than duplicating
   *  it. */
  const drain = useCallback(async () => {
    try {
      const pending = await invoke<PendingOpen[]>("file_open_take_pending");
      if (pending.length > 0) await openAll(pending);
    } catch {
      /* no Tauri — nothing can have queued a file */
    }
  }, [openAll]);

  useEffect(() => {
    // StrictMode mounts → unmounts → remounts, and `listen` is async: without
    // this flag the first subscription leaks and one double-click opens the
    // file twice. Same guard as the tray bridge.
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      if (!cancelled) await drain();
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen(FILE_OPEN_EVENT, () => {
          void drain();
        });
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
      } catch {
        /* no Tauri — no file-open events to receive */
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [drain]);

  const dismiss = useCallback(() => {
    viewerBusy.current = false;
    setViewed(null);
  }, []);

  return { viewed, dismiss };
}
