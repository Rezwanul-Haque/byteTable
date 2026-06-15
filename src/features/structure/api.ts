// Structure-editor API surface (M8, DESIGN_SPEC §3.6 — staged ALTER pipeline).
//
// The wire types and `invoke` wrappers live next to the other engine types in
// `shared/api/engine.ts` (they are engine-shared, like `tableMeta` /
// `rowsFetch`). This module re-exports them under the structure feature so the
// Task 2 structure view imports from its own slice. Keep this thin — add
// structure-specific UI helpers here if/when they are needed, not wire glue.

export {
  alterApply,
  alterPreview,
  type AlterOp,
  type AlterResult,
  type ColumnInfo,
} from "../../shared/api/engine";
