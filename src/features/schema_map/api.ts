// Typed invoke() wrappers for the schema-map slice's Tauri commands, plus the
// TS mirror of the Rust wire types. Field names are camelCase per the serde
// attributes on the Rust side — keep in sync with
// `src-tauri/src/features/schema_map/domain/mod.rs`.
//
// Two capabilities live here:
//   1. Layout persistence — `mapLayoutGet` / `mapLayoutSave`, keyed by
//      (connectionId, schema). `connectionId` is the persisted
//      `SavedConnection.id` (i.e. `workspace.saved.id`), the same durable
//      identity saved_queries uses; layouts survive restarts and follow the
//      connection, not the ephemeral workspace.
//   2. Export-write — `diagramExport`, which writes a rasterized/serialized
//      diagram to a user-chosen path. The renderer (Task 3) picks the path via
//      the native save dialog, then calls this to write the bytes.
//
// ARCHITECTURE pattern: this module (with state.ts) is the slice's public
// contract — cross-feature consumption of another feature's api.ts / state.ts
// is sanctioned; reaching into a feature's internals is not.

import { invoke } from "@tauri-apps/api/core";

/** Position of one table card in the diagram's coordinate space. */
export interface NodePosition {
  table: string;
  x: number;
  y: number;
}

/**
 * A user-dragged offset for one FK edge's midpoint waypoint. `id` opaquely
 * identifies the edge (the renderer owns the scheme, e.g.
 * `"childTable.col->refTable"`); `dx`/`dy` are a relative offset applied to the
 * computed midpoint, so the edge keeps its bend when the connected cards move.
 */
export interface EdgeWaypoint {
  id: string;
  dx: number;
  dy: number;
}

/**
 * The full saved layout for one (connectionId, schema). Mirrors Rust's
 * `MapLayout`: `positions` / `edges` are always present (possibly empty);
 * `zoom` is omitted from the wire when never set, so it arrives `undefined` —
 * typed `?: number | null` to tolerate both absent and explicit null.
 */
export interface MapLayout {
  positions: NodePosition[];
  edges: EdgeWaypoint[];
  zoom?: number | null;
}

/** Export format the renderer chose. Mirrors Rust's lowercase `ExportFormat`. */
export type ExportFormat = "png" | "svg";

/**
 * The saved layout for one (connectionId, schema), or `null` when none was ever
 * saved (the diagram then lays out from scratch).
 */
export function mapLayoutGet(connectionId: string, schema: string): Promise<MapLayout | null> {
  return invoke<MapLayout | null>("map_layout_get", { connectionId, schema });
}

/** Persist (overwrite) the layout for one (connectionId, schema). */
export function mapLayoutSave(
  connectionId: string,
  schema: string,
  layout: MapLayout,
): Promise<void> {
  return invoke("map_layout_save", { connectionId, schema, layout });
}

/**
 * Write an exported diagram to a user-chosen `path`.
 *
 * `data` is the SVG document text for `format: "svg"`, or **base64-encoded**
 * PNG bytes for `format: "png"` (base64 keeps large images cheap over IPC; the
 * backend decodes before writing). The `path` must come from the native save
 * dialog — that explicit user action is the only consent the write needs.
 */
export function diagramExport(path: string, format: ExportFormat, data: string): Promise<void> {
  return invoke("diagram_export", { payload: { path, format, data } });
}
