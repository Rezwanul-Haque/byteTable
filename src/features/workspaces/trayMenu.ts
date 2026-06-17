// Native tray "Workspaces" submenu bridge. The tray menu is built in Rust and
// can't see the frontend's runtime state, so this hook is the two-way link:
//
//  1. PUSH — whenever the saved-connection list or the set of open workspaces
//     changes, send the list (each item flagged `open`) to the `tray_update`
//     command, which rebuilds the submenu (open ones show a check).
//  2. SELECT — when the user picks a Workspaces item, Rust emits
//     `tray://select-workspace` with the saved-connection id; we focus the
//     matching open workspace, or open one from that connection.
//
// Both halves no-op gracefully in plain-browser dev (no Tauri): the invoke and
// the event import are wrapped so a missing backend never throws.

import { useEffect } from "react";

import { invoke } from "@tauri-apps/api/core";

import { useConnectionsStore } from "../connections/state";
import { useConnectAndOpen } from "./connect";
import { useWorkspacesStore } from "./state";

/** The payload shape `tray_update` expects (matches the Rust `TrayWorkspace`). */
type TrayItem = { id: string; name: string; open: boolean };

/** Saved connections + an `open` flag (a workspace is open for that id). */
function currentItems(): TrayItem[] {
  const { savedConnections } = useConnectionsStore.getState();
  const { workspaces } = useWorkspacesStore.getState();
  const openIds = new Set(workspaces.map((ws) => ws.saved.id));
  return savedConnections.map((c) => ({ id: c.id, name: c.name, open: openIds.has(c.id) }));
}

export function useTrayWorkspaces(): void {
  const connectAndOpen = useConnectAndOpen();

  // PUSH: keep the native submenu in sync with the stores. The workspaces store
  // also changes on every editor keystroke (buffer text lives there), so dedupe
  // on a signature of just the tray-relevant fields to avoid spamming `invoke`.
  useEffect(() => {
    let lastSig = "";
    const push = () => {
      const items = currentItems();
      const sig = JSON.stringify(items);
      if (sig === lastSig) return;
      lastSig = sig;
      void invoke("tray_update", { workspaces: items }).catch(() => {
        /* no Tauri / tray unavailable — nothing to update */
      });
    };
    push();
    const unsubConns = useConnectionsStore.subscribe(push);
    const unsubWs = useWorkspacesStore.subscribe(push);
    return () => {
      unsubConns();
      unsubWs();
    };
  }, []);

  // SELECT: a Workspaces item was clicked. Focus the open workspace for that
  // connection, or open one from the saved connection if none is open yet.
  useEffect(() => {
    // `listen` is async; under StrictMode the effect mounts→unmounts→remounts,
    // and the first cleanup runs before `listen` resolves. Without this flag the
    // first subscription leaks and a tray click fires twice (opening a workspace
    // twice). Tear down whichever subscription resolves after its cleanup ran.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<string>("tray://select-workspace", (event) => {
          const connectionId = event.payload;
          const { workspaces, setActive } = useWorkspacesStore.getState();
          const open = workspaces.find((ws) => ws.saved.id === connectionId);
          if (open) {
            setActive(open.id);
            return;
          }
          const saved = useConnectionsStore
            .getState()
            .savedConnections.find((c) => c.id === connectionId);
          if (saved) void connectAndOpen(saved);
        });
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
      } catch {
        /* no Tauri — no tray events to receive */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [connectAndOpen]);
}
