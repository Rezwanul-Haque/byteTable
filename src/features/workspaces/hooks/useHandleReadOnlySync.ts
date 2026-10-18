// Keeps the backend handle's read-only mode pointed at the ACTIVE workspace.
//
// # Why this exists
//
// Read-only is a property of a *workspace*: a schema sub-workspace inherits the
// flag from its parent when it is created, then goes its own way — locking a
// schema you only browse must not lock the parent you work in, and unlocking it
// must not unlock the parent either.
//
// The backend guard, though, is keyed by connection handle, and a parent and
// its sub-workspaces deliberately share one handle (they are one connection; a
// sub-workspace opens no second socket). So the handle cannot carry every
// workspace's mode at once.
//
// It does not have to. Only one workspace is on screen at a time — `App` mounts
// the active shell and unmounts the others — so every command the renderer
// issues comes from the active workspace. The handle therefore carries the
// ACTIVE workspace's mode, re-pushed whenever the active workspace, its flag,
// or its handle changes. This hook is the single writer of that mode; nothing
// else calls `connectionSetReadOnly`.
//
// The push is one IPC round trip behind the UI, which already hides its
// mutation affordances the moment the flag flips. That ordering only ever fails
// safe in the direction that matters: switching INTO a read-only workspace
// renders it locked before anything in it is clickable.

import { useEffect, useRef } from "react";

import { appErrorMessage, isAppErrorPayload } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import { useToast } from "../../../shared/ui/toastContext";
import { connectionSetReadOnly } from "../../connections/api";
import { useWorkspacesStore } from "../state";

export function useHandleReadOnlySync(): void {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspacesStore((state) => state.activeWorkspaceId);
  const active = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? null;
  const toast = useToast();
  const t = useT();

  const handleId = active?.handleId ?? null;
  const readOnly = active?.readOnly ?? false;

  // What the backend was last told, per handle. Skipping a no-op push keeps
  // workspace switching free of IPC when two workspaces agree — which is the
  // common case, since siblings usually share their parent's mode.
  const pushed = useRef(new Map<string, boolean>());

  useEffect(() => {
    if (handleId === null) return;
    if (pushed.current.get(handleId) === readOnly) return;
    let live = true;
    void connectionSetReadOnly(handleId, readOnly).then(
      () => {
        if (live) pushed.current.set(handleId, readOnly);
      },
      (error: unknown) => {
        // A closed handle is the benign race — the workspace was closed while
        // this was in flight — and plain-browser dev has no backend at all.
        // Anything else is worth saying out loud: the workspace would be
        // showing a lock the database is not enforcing.
        if (!live) return;
        if (!isAppErrorPayload(error) || error.kind === "notFound") return;
        toast(appErrorMessage(error, t("ws.rail.ro.fail")), "err");
      },
    );
    return () => {
      live = false;
    };
  }, [handleId, readOnly, toast, t]);
}
