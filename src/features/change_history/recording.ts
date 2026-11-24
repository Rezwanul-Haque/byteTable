// Whether a write should be recorded, and the "View in history" button that
// follows one (M48 F4).

import { t } from "../../shared/i18n";
import type { ToastAction } from "../../shared/ui/toastContext";
import { useSettingsStore } from "../settings/state";
import { useWorkspacesStore } from "../workspaces/state";
import { isDataFileWorkspace, type Workspace } from "../workspaces/types";
import {
  historyRecord,
  historyTruncate,
  limitsFrom,
  type Limits,
  type Recorded,
  type Source,
} from "./api";
import { useHistoryStore } from "./state";

/**
 * Record writes on this workspace? Only SQL workspaces (a CSV file's scratch
 * database is not one), and only when both switches are on: Settings →
 * Change history, and the connection's own "Record on this connection".
 */
export async function recordingOn(ws: Workspace): Promise<boolean> {
  if (ws.kind !== "sql" || isDataFileWorkspace(ws)) return false;
  if (!useSettingsStore.getState().settings.undoRecord) return false;
  return useHistoryStore.getState().loadRecording(ws.saved.id);
}

/** The same test by saved connection id — for callers without a workspace. */
export async function recordingFor(connectionId: string | null): Promise<boolean> {
  if (!connectionId || !useSettingsStore.getState().settings.undoRecord) return false;
  return useHistoryStore.getState().loadRecording(connectionId);
}

export const currentLimits = (): Limits => limitsFrom(useSettingsStore.getState().settings);

/** The open workspace behind a backend handle (grid code knows only that). */
export function workspaceForHandle(handleId: string): Workspace | null {
  return useWorkspacesStore.getState().workspaces.find((w) => w.handleId === handleId) ?? null;
}

/**
 * Run `statements` through the recorder when this handle's workspace records,
 * refreshing every history view after. Resolves to null when it does not
 * record — the caller then runs them its usual way.
 */
export async function recordIfOn(
  handleId: string,
  schema: string,
  statements: string[],
  source: Source,
): Promise<Recorded | null> {
  const ws = workspaceForHandle(handleId);
  if (!ws || !(await recordingOn(ws))) return null;
  const rec = await historyRecord(
    handleId,
    ws.saved.id,
    statements,
    schema,
    source,
    currentLimits(),
  );
  if (rec.entries.length) useHistoryStore.getState().bump();
  return rec;
}

/**
 * Truncate through the recorder when recording (its rows are read first and
 * listed as a table action); null when not recording.
 */
export async function truncateIfOn(
  handleId: string,
  schema: string,
  table: string,
  force: boolean,
): Promise<{ affected: number; recorded: boolean } | null> {
  const ws = workspaceForHandle(handleId);
  if (!ws || !(await recordingOn(ws))) return null;
  const out = await historyTruncate(handleId, ws.saved.id, schema, table, force, currentLimits());
  if (out.entry) useHistoryStore.getState().bump();
  return { affected: out.affected, recorded: !!out.entry };
}

/** Open the workspace's Change history on its newest entry. */
export function openLatest(): void {
  useWorkspacesStore.getState().openHistoryTab({ focus: "latest" });
}

/** The toast button after a recorded write. */
export const viewInHistory = (): ToastAction => ({
  label: t("history.viewInHistory"),
  onClick: openLatest,
});
