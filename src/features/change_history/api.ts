// Typed wrappers for the change history (M48) — the `change_history` Rust
// slice. The log lives on this machine only; nothing here sends it anywhere.

import { invoke } from "@tauri-apps/api/core";

import type { CellValue, StatementOutcome } from "../../shared/api/engine";
import type { Settings } from "../settings/api";

export type Source = "grid" | "statement" | "transaction" | "action";
export type Cant = "structure" | "large" | "nokey" | "multitable" | "unsupported";
export type Kind = "insert" | "update" | "delete";
export type RowState = "ok" | "conflict" | "noop" | "done";
export type Why =
  | "tableGone"
  | "alreadyGone"
  | "changedAfterAdded"
  | "keyExistsAgain"
  | "rowGone"
  | "alreadyEarlier"
  | "changedAgain";

/** An entry without its row values — what the list draws. */
export interface Summary {
  id: string;
  at: number;
  source: Source;
  schemaName: string;
  sql: string;
  verb: string;
  rows: number | null;
  cant?: Cant;
  limit?: number;
  tables: string[];
  inserted: number;
  updated: number;
  deleted: number;
  changes: number;
  undone: number;
}

export interface Change {
  schema: string;
  table: string;
  pk: string[];
  key: CellValue[];
  kind: Kind;
  columns: string[];
  before: CellValue[] | null;
  after: CellValue[] | null;
  cols: string[];
}

export interface HistoryLine {
  what: "undo" | "redo";
  at: number;
  rows: number;
  skipped: number;
}

export interface Entry {
  id: string;
  connectionId: string;
  at: number;
  source: Source;
  schemaName: string;
  sql: string;
  verb: string;
  changes: Change[];
  rows: number | null;
  cant?: Cant;
  limit?: number;
  tables: string[];
  sideEffects: boolean;
  undone: number[];
  history: HistoryLine[];
}

export interface Verdict {
  i: number;
  state: RowState;
  why?: Why;
  now?: { col: string; now: CellValue; was: CellValue }[];
}

export interface CheckView {
  redo: boolean;
  verdicts: Verdict[];
  statements: string[];
  sql: string;
}

export interface ApplyOutcome {
  applied: number;
  skipped: number;
  /** A row changed while the user was reviewing: nothing ran. */
  changed: boolean;
}

export interface Totals {
  entries: number;
  connections: number;
  bytes: number;
}

export interface Limits {
  maxRows: number;
  keepDays: number;
  keepEntries: number;
}

export interface Recorded {
  outcomes: StatementOutcome[];
  entries: string[];
}

export const limitsFrom = (s: Settings): Limits => ({
  maxRows: s.undoMaxRows,
  keepDays: s.undoKeepDays,
  keepEntries: s.undoKeepEntries,
});

/** Run statements and record what they change. `grid` = one transaction. */
export function historyRecord(
  handleId: string,
  connectionId: string,
  statements: string[],
  schema: string,
  source: Source,
  limits: Limits,
): Promise<Recorded> {
  return invoke<Recorded>("history_record", {
    handleId,
    connectionId,
    statements,
    schema,
    source,
    limits,
  });
}

/** Truncate a table, recording its rows first. */
export function historyTruncate(
  handleId: string,
  connectionId: string,
  schema: string,
  table: string,
  force: boolean,
  limits: Limits,
): Promise<{ affected: number; entry: string | null }> {
  return invoke("history_truncate", { handleId, connectionId, schema, table, force, limits });
}

export function historyList(
  connectionId: string,
  filter?: { table: string; key?: CellValue[] | null } | null,
): Promise<Summary[]> {
  return invoke<Summary[]>("history_list", {
    connectionId,
    table: filter?.table ?? null,
    key: filter?.key ?? null,
  });
}

export function historyGet(id: string): Promise<Entry | null> {
  return invoke<Entry | null>("history_get", { id });
}

export function historyCheck(handleId: string, id: string): Promise<CheckView> {
  return invoke<CheckView>("history_check", { handleId, id });
}

/** Undo (or redo); refused with `changed` if a row moved since `reviewed`. */
export function historyApply(
  handleId: string,
  id: string,
  reviewed: RowState[],
): Promise<ApplyOutcome> {
  return invoke<ApplyOutcome>("history_apply", { handleId, id, reviewed });
}

export function historyClear(connectionId: string | null): Promise<void> {
  return invoke<void>("history_clear", { connectionId });
}

export function historyPrune(limits: Limits): Promise<void> {
  return invoke<void>("history_prune", { limits });
}

export function historyTotals(): Promise<Totals> {
  return invoke<Totals>("history_totals");
}

export function historySetRecording(connectionId: string, on: boolean): Promise<void> {
  return invoke<void>("history_set_recording", { connectionId, on });
}

export function historyRecording(connectionId: string): Promise<boolean> {
  return invoke<boolean>("history_recording", { connectionId });
}
