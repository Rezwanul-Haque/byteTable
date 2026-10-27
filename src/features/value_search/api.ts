// Typed invoke() wrappers for the value-search slice's Tauri commands, plus
// the TS mirror of the Rust wire types. Field names are camelCase per the serde
// attributes on the Rust side — keep in sync with
// `src-tauri/src/features/value_search/{domain.rs,application.rs}`.
//
// Two capabilities:
//   1. `valueSearchRun` — sweep every table in scope for a value, streaming
//      each hit over a Channel as it lands; honors cancel via `runId`.
//   2. `valueSearchCancel` — flip the cancel flag for an in-flight sweep.
//
// Read-only: the sweep only ever issues SELECTs, so it works the same in a
// read-only workspace. It is also a FULL TABLE SCAN per table — the UI says so
// before the user starts one.

import { Channel, invoke } from "@tauri-apps/api/core";

import type { ColumnMeta, CellValue } from "../../shared/api/engine";

/** How the needle is compared against a column. */
export type MatchMode = "contains" | "exact";

/** What the renderer asks for beyond the needle itself. */
export interface ValueSearchOptions {
  mode?: MatchMode;
  /** Schemas to sweep; omit or leave empty for every user schema. */
  schemas?: string[];
  /** Matching rows kept per table (backend default: 20). */
  perTableLimit?: number;
  /** Stop once this many tables have matched (backend default: 100). */
  maxHitTables?: number;
  /** Sweep the engine's own catalog too (off by default). */
  includeSystemSchemas?: boolean;
}

/** One table that holds the needle. */
export interface TableHit {
  schema: string;
  table: string;
  columns: ColumnMeta[];
  /** The first page of matching rows, capped at `perTableLimit`. */
  rows: CellValue[][];
  /** Columns the needle was actually found in, across the returned page. */
  matchedColumns: string[];
  /** Exact count of matching rows in the whole table. */
  totalMatches: number | null;
  /** More matches exist than `rows` holds. */
  truncated: boolean;
  elapsedMs: number;
}

/** A table the sweep could not read. Never aborts the run. */
export interface TableError {
  schema: string;
  table: string;
  message: string;
}

/** The outcome of a whole sweep. Repeats every hit already streamed. */
export interface ValueSearchSummary {
  needle: string;
  hits: TableHit[];
  tablesScanned: number;
  /** Skipped because no column could hold the needle. */
  tablesSkipped: number;
  tablesTotal: number;
  errors: TableError[];
  cancelled: boolean;
  /** Stopped itself at `maxHitTables`. */
  stoppedEarly: boolean;
  elapsedMs: number;
}

/**
 * A progress tick, one per table. Carries the table's hit when it had one, so
 * results fill live instead of appearing all at once at the end.
 */
export interface SearchProgress {
  schema: string;
  table: string;
  /** Tables finished, including this one. */
  done: number;
  total: number;
  /** Tables with a hit so far. */
  hitTables: number;
  hit: TableHit | null;
}

/** Progress callback for {@link valueSearchRun}. */
export type SearchProgressFn = (p: SearchProgress) => void;

/**
 * Sweep every table in scope for `needle` (`value_search_run` command).
 *
 * **Full table scan per table** — no index can answer "this value in any
 * column". Tables are visited smallest-first so the cheap answers arrive
 * early; pass a unique `runId` so {@link valueSearchCancel} can stop it
 * between tables. Reads only.
 */
export function valueSearchRun(
  handleId: string,
  needle: string,
  runId: string,
  options?: ValueSearchOptions,
  onProgress?: SearchProgressFn,
): Promise<ValueSearchSummary> {
  const channel = new Channel<SearchProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<ValueSearchSummary>("value_search_run", {
    handleId,
    needle,
    runId,
    options: options ?? null,
    onProgress: channel,
  });
}

/** Signal an in-flight sweep to stop (`value_search_cancel` command). */
export function valueSearchCancel(runId: string): Promise<void> {
  return invoke<void>("value_search_cancel", { runId });
}
