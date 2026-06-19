// Typed invoke() wrappers for the generate slice's Tauri commands (M16), plus
// the TS mirror of the Rust wire types. Field names are camelCase per the serde
// attributes on the Rust side — keep in sync with
// `src-tauri/src/features/generate/{domain.rs,application.rs}`.
//
// Three capabilities:
//   1. `generatePreview` — introspect the schema and return the plan (insertion
//      order, per-table role + row count, per-column generator), no writes.
//   2. `generateRun` — generate and APPEND fake data for the whole schema,
//      streaming progress over a Channel; honors cancel via `runId`.
//   3. `generateCancel` — flip the cancel flag for an in-flight run.

import { Channel, invoke } from "@tauri-apps/api/core";

/** Target size the user picks; the base row count for entity tables. */
export type GenerateSize = "1k" | "10k" | "100k" | "1m";

/** How a table is scaled. */
export type TableRole = "lookup" | "junction" | "entity";

/** The plan for one column (preview display). */
export interface ColumnPlan {
  name: string;
  /** Human label of the chosen generator (e.g. "email", "foreign key"). */
  generator: string;
  /** Left out of the INSERT (auto-increment PK, or nullable-with-default). */
  omit: boolean;
  /** Filled in a second UPDATE pass (self-ref / cycle FK). */
  deferred: boolean;
  /** Per-column preview warning, if any. */
  note: string | null;
}

/** The plan for one table. */
export interface TablePlan {
  table: string;
  role: TableRole;
  rowCount: number;
  columns: ColumnPlan[];
}

/** The full generation plan, in insertion order. */
export interface GeneratePlan {
  schema: string;
  order: TablePlan[];
  warnings: string[];
}

/** Per-table outcome of a run. */
export interface TableResult {
  table: string;
  inserted: number;
  error: string | null;
}

/** The outcome of a whole run. */
export interface GenerateSummary {
  tables: TableResult[];
  totalInserted: number;
  cancelled: boolean;
}

/** A progress tick: `done` of `total` rows for one `table`. */
export interface GenProgress {
  table: string;
  done: number;
  total: number;
}

/** Progress callback for {@link generateRun}. */
export type GenProgressFn = (p: GenProgress) => void;

/**
 * Build the display plan for the preview (`generate_preview` command). No
 * writes. Unknown/unsupported engine surfaces a `{ kind, message }` §5 error.
 */
export function generatePreview(
  handleId: string,
  schema: string,
  size: GenerateSize,
): Promise<GeneratePlan> {
  return invoke<GeneratePlan>("generate_preview", { handleId, schema, size });
}

/**
 * Generate and APPEND fake data for the whole schema (`generate_run` command).
 * **Mutates user data — append only.** Streams progress per chunk; pass a unique
 * `runId` so {@link generateCancel} can stop it. `seed` makes a run reproducible
 * (optional). Returns the per-table summary.
 */
export function generateRun(
  handleId: string,
  schema: string,
  size: GenerateSize,
  runId: string,
  onProgress?: GenProgressFn,
  seed?: number,
): Promise<GenerateSummary> {
  const channel = new Channel<GenProgress>();
  if (onProgress) channel.onmessage = onProgress;
  return invoke<GenerateSummary>("generate_run", {
    handleId,
    schema,
    size,
    runId,
    seed: seed ?? null,
    onProgress: channel,
  });
}

/** Signal a running generation to stop (`generate_cancel` command). */
export function generateCancel(runId: string): Promise<void> {
  return invoke<void>("generate_cancel", { runId });
}
