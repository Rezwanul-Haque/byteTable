// Typed invoke() wrappers for the schedules slice's Tauri commands (M41), plus
// the TS mirrors of the Rust wire types. Field names are camelCase per the
// serde attributes on the Rust side — keep in sync with
// `src-tauri/src/features/schedules/domain/mod.rs`.
//
// ARCHITECTURE pattern: this module (with state.ts) is the slice's public
// contract — cross-feature consumption of another feature's `api.ts` /
// `state.ts` is sanctioned; reaching into a feature's internals (components,
// hooks) is not.

import { invoke } from "@tauri-apps/api/core";

/** When a schedule runs. Mirrors Rust's tagged `Recurrence` enum. */
export type Recurrence =
  | { kind: "every"; minutes: number }
  | { kind: "daily"; hour: number; minute: number }
  /** `weekday` is 0 = Sunday, matching `Date.getDay()`. */
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  /** A `day` past the end of a short month clamps to its last day. */
  | { kind: "monthly"; day: number; hour: number; minute: number };

/** Every recurrence's discriminator, in the order the editor offers them. */
export type RecurrenceKind = Recurrence["kind"];

/** What a scheduled run writes. No SQL dump — a query result has no DDL. */
export type OutputFormat = "csv" | "json";

/** Why a run happened. */
export type RunTrigger = "scheduled" | "manual";

/** Floor for an `every` recurrence, enforced in the Rust use-case too. */
export const MIN_EVERY_MINUTES = 5;

/** Defaults the editor starts a new schedule from, mirroring the Rust consts. */
export const DEFAULT_KEEP = 30;
export const DEFAULT_ROW_LIMIT = 100_000;

/**
 * One scheduled report.
 *
 * `sql` is a RESOLVED SNAPSHOT, not a pointer into the saved query: query
 * parameters are substituted here in the renderer (`workspaces/sqlParams.ts`)
 * before the schedule is saved, because that is where the lexer deciding what
 * is and is not a placeholder lives. `savedQueryId` is provenance only.
 *
 * What stays dynamic is `{{today}}`-style date tokens inside the snapshot,
 * which the backend expands per run.
 */
export interface Schedule {
  /** Assigned on first save — send "" for a new entry. */
  id: string;
  name: string;
  enabled: boolean;
  /** The persisted `SavedConnection.id` this runs against. */
  connectionId: string;
  /** Schema context for unqualified names. */
  schema?: string | null;
  /** The saved query this snapshot came from, if any. */
  savedQueryId?: string | null;
  sql: string;
  recurrence: Recurrence;
  format: OutputFormat;
  /** Absolute path of the output folder. */
  directory: string;
  /** Filename stem pattern, tokens included, WITHOUT an extension. */
  filename: string;
  /** Output files to keep before the oldest are pruned. */
  keep: number;
  rowLimit: number;
  /** Epoch milliseconds, assigned by the backend on first save. */
  createdAt: number;
  /**
   * Epoch milliseconds of the next due run. Scheduler bookkeeping: the backend
   * ALWAYS recomputes it on save, so whatever is sent here is ignored.
   */
  nextRunAt: number;
}

/** One entry in a schedule's history. `path` on success, `error` on failure. */
export interface RunRecord {
  scheduleId: string;
  startedAt: number;
  durationMs: number;
  trigger: RunTrigger;
  path?: string | null;
  rowCount: number;
  /** The row limit cut the result short. */
  truncated: boolean;
  error?: string | null;
}

/** Run history keyed by schedule id, newest LAST within each list. */
export type RunHistory = Record<string, RunRecord[]>;

/**
 * The event the backend emits when any run finishes, scheduled or manual, so
 * an open manager updates without polling. Payload: the {@link RunRecord}.
 */
export const RUN_FINISHED_EVENT = "schedules://run-finished";

/**
 * Emitted when a run STARTS, so the manager can show the row working.
 *
 * Both ways a run begins need this, but only one of them could do without it:
 * a manual run is an awaited command, a scheduled one happens in a background
 * loop with no renderer in the call chain. Without the event a 3am run — or a
 * long one started from another window — is invisible until it ends.
 */
export const RUN_STARTED_EVENT = "schedules://run-started";

/** {@link RUN_STARTED_EVENT}'s payload. */
export interface RunStarted {
  scheduleId: string;
  trigger: RunTrigger;
}

export function scheduleList(): Promise<Schedule[]> {
  return invoke<Schedule[]>("schedule_list");
}

/** Insert or update; returns the stored value with its assigned id/nextRunAt. */
export function scheduleSave(schedule: Schedule): Promise<Schedule> {
  return invoke<Schedule>("schedule_save", { schedule });
}

/** Remove a schedule and its run history. */
export function scheduleDelete(id: string): Promise<void> {
  return invoke("schedule_delete", { id });
}

/** Pause or resume; returns the stored value with its recomputed nextRunAt. */
export function scheduleSetEnabled(id: string, enabled: boolean): Promise<Schedule> {
  return invoke<Schedule>("schedule_set_enabled", { id, enabled });
}

export function scheduleRuns(): Promise<RunHistory> {
  return invoke<RunHistory>("schedule_runs");
}

/**
 * Run a schedule immediately (the manager's ▶ button). Resolves with the run
 * record even when the run FAILED — a failed run is a successful command with
 * a recorded failure, and the manager renders it either way. It does not move
 * `nextRunAt`: "run now" means "also run now", not "restart the clock".
 */
export function scheduleRunNow(id: string): Promise<RunRecord> {
  return invoke<RunRecord>("schedule_run_now", { id });
}

/**
 * Show a schedule's output in the OS file manager — the folder itself, or one
 * of its files with the file selected.
 *
 * A backend command rather than the opener plugin's `openPath`, because the
 * backend scopes it: it refuses any path no schedule owns, so this does not
 * require granting the renderer the ability to open arbitrary paths. Rejects
 * with a §5 error when the folder does not exist yet (nothing has run).
 */
export function scheduleReveal(path: string): Promise<void> {
  return invoke("schedule_reveal", { path });
}
