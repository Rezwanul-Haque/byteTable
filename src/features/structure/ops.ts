// Structure-editor op accumulation + working-column derivation (M8 §3.6 / §4).
//
// EDITING-STATE MODEL
// ===================
// The user's inline edits accumulate as an ordered list of `AlterOp`
// (`pendingOps`, persisted per table tab in the workspace `ui`). The structure
// view never mutates the introspected truth — instead it derives a *working
// column set* on every render by replaying `pendingOps` over the introspected
// `ColumnInfo[]` (`applyOpsToColumns`), exactly mirroring the backend's
// `compute_target_columns` in `src-tauri/.../engines/sqlite/structure.rs`. So:
//
//   - pendingOps[]      → sent to alterPreview / alterApply (the wire batch)
//   - working columns   → UI display = introspected snapshot + ops replayed
//   - snapshot          → the introspected TableMeta in the cache (discard =
//                         clear pendingOps; the snapshot is re-derived for free)
//
// OP ACCUMULATION / DEDUP
// =======================
// Inline edits collapse so the batch stays minimal and each (column, kind) of
// in-place edit appears at most once (last-wins) — matching the prototype's
// intent of one staged change per cell. `stageOp` folds a new op into the list:
//
//   - changeType / setNullable / setDefault: keyed by (kind, ORIGINAL column).
//     A second edit of the same cell replaces the first (last-wins). An edit
//     that returns the cell to its introspected value REMOVES the op (so the
//     pending count and the working set reflect "no net change").
//   - renameColumn: keyed by the ORIGINAL column. Re-renaming the same column
//     replaces the prior rename's `to`; renaming back to the original name
//     removes the op.
//   - addColumn: keyed by the synthetic column name; editing a just-added
//     column's name/type/nullable/default updates the AddColumn op in place
//     (never produces a rename/changeType op for a column that does not yet
//     exist on the server).
//   - dropColumn: keyed by the column name; toggling drop off removes it.
//
// OP ORDERING (verified against Task 1's folding — see structure.rs)
// ==================================================================
// The backend validates EVERY op's target column against the ORIGINAL
// introspected columns (`validate_ops`), then replays ops IN ORDER to build the
// target set (`compute_target_columns`). Two consequences drive our ordering:
//
//   1. Every op (except addColumn, which introduces a new name) must reference
//      an ORIGINAL column name — never a name created mid-batch. We enforce
//      this by keying all in-place edits + renames by the original name, and by
//      forbidding rename/changeType/etc. on a not-yet-applied added column
//      (those edits mutate the AddColumn op instead).
//   2. A changeType/setNullable/setDefault on a column that is ALSO renamed in
//      the batch must run BEFORE the rename (after the rename the running column
//      set holds the new name, so `require_idx(originalName)` would fail). We
//      therefore emit ops in a fixed phase order on serialization:
//        drops → addColumns → in-place edits (type/nullable/default) → renames
//      Renames last guarantees a same-column edit+rename batch applies cleanly,
//      and since in-place edits reference original names they validate too.
//
// This makes the acceptance batch (add a column + rename a column + retype a
// column) a valid wire batch: add → retype → rename, all referencing original
// names, renames last.

import type { AlterOp, ColumnInfo } from "../../shared/api/engine";

/** The list of SQLite types offered in the type-change select (prototype list,
 *  adapted to SQLite-native affinities). The current type is prepended if not
 *  already present so the select always shows the column's real type. */
export const SQLITE_TYPES = [
  "TEXT",
  "INTEGER",
  "REAL",
  "NUMERIC",
  "BLOB",
  "BOOLEAN",
  "DATE",
  "TIMESTAMP",
] as const;

/** A column in the working (post-edit) set the structure view renders. Carries
 *  the original introspected name (`origin`) so edit handlers can key ops by it
 *  even after a rename, plus flags for the new/dropped row styling. */
export interface WorkingColumn {
  /** Current (possibly edited) column name shown in the row. */
  name: string;
  dataType: string;
  nullable: boolean;
  pk: boolean;
  default: string | null;
  fk: ColumnInfo["fk"];
  /** The introspected name this row maps from, or null for a freshly added
   *  column. Edit handlers key ops by this (original) name. */
  origin: string | null;
  /** True for a column added in this batch (accent-tinted row). */
  isNew: boolean;
  /** True for a column marked for drop in this batch (struck-through row). */
  markedForDrop: boolean;
}

/** Replay `ops` over the introspected columns to produce the working set the
 *  view displays. Dropped columns are kept (flagged `markedForDrop`) so the row
 *  shows struck-through rather than vanishing — matching the prototype's
 *  "marked for drop" affordance. Mirrors the backend's `compute_target_columns`
 *  for everything else. */
export function applyOpsToColumns(columns: ColumnInfo[], ops: AlterOp[]): WorkingColumn[] {
  const working: WorkingColumn[] = columns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    pk: c.pk,
    default: c.default ?? null,
    fk: c.fk,
    origin: c.name,
    isNew: false,
    markedForDrop: false,
  }));

  const find = (name: string) => working.find((c) => c.name === name);

  for (const op of ops) {
    switch (op.op) {
      case "addColumn":
        working.push({
          name: op.name,
          dataType: op.dataType,
          nullable: op.nullable,
          pk: false,
          default: op.default,
          fk: null,
          origin: null,
          isNew: true,
          markedForDrop: false,
        });
        break;
      case "renameColumn": {
        const col = find(op.from);
        if (col) col.name = op.to;
        break;
      }
      case "changeType": {
        const col = find(op.column);
        if (col) col.dataType = op.newType;
        break;
      }
      case "setNullable": {
        const col = find(op.column);
        if (col) col.nullable = op.nullable;
        break;
      }
      case "setDefault": {
        const col = find(op.column);
        if (col) col.default = op.default;
        break;
      }
      case "dropColumn": {
        const col = find(op.name);
        if (col) col.markedForDrop = true;
        break;
      }
    }
  }
  return working;
}

/**
 * Serialize the accumulated ops into a wire batch in the backend-safe phase
 * order: drops → addColumns → in-place edits → renames (see the ordering note
 * above). The ops the editor stores are already deduped/keyed; this only
 * reorders. Drops of a just-added column (origin null) are elided — there is
 * nothing on the server to drop.
 */
export function toWireBatch(ops: AlterOp[]): AlterOp[] {
  const drops: AlterOp[] = [];
  const adds: AlterOp[] = [];
  const inPlace: AlterOp[] = [];
  const renames: AlterOp[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "dropColumn":
        drops.push(op);
        break;
      case "addColumn":
        adds.push(op);
        break;
      case "renameColumn":
        renames.push(op);
        break;
      default:
        inPlace.push(op);
    }
  }
  return [...drops, ...adds, ...inPlace, ...renames];
}
