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
  /** User-resized card width (read-mode resizable cards). Omitted when the card
   *  is at its default width, so pre-resize layouts have no `w`. Mirrors Rust's
   *  optional `w`. */
  w?: number;
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

/** A relationship's cardinality (crow's-foot). `1:1` / `1:N` / `M:N`. */
export type CardinalityKind = "1:1" | "1:N" | "M:N";

/**
 * A manual cardinality override for one edge. `id` matches the renderer's edge
 * id (same scheme as {@link EdgeWaypoint.id}); its presence overrides the
 * schema-derived cardinality. Mirrors Rust's `EdgeCardinality`.
 */
export interface EdgeCardinality {
  id: string;
  kind: CardinalityKind;
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
  /** Manual cardinality overrides, keyed by edge id. Omitted/empty = all auto. */
  cardinalities?: EdgeCardinality[];
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
 * `data` is always the diagram's SVG document text. For `format: "svg"` it is
 * written verbatim; for `format: "png"` the backend rasterizes it with resvg at
 * `scale`× (default 2 for crisp HiDPI). Rasterizing in Rust — not the webview
 * canvas — is what makes PNG export work on Linux, where WebKitGTK cannot draw
 * an SVG to a canvas. The `path` must come from the native save dialog — that
 * explicit user action is the only consent the write needs.
 */
export function diagramExport(
  path: string,
  format: ExportFormat,
  data: string,
  scale = 2,
): Promise<void> {
  const payload = format === "png" ? { path, format, data, scale } : { path, format, data };
  return invoke("diagram_export", { payload });
}
