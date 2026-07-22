//! Schema-map slice: persistence for the M9 ER diagram's per-(connection,
//! schema) layout, plus an export-write command (ARCHITECTURE — "schema_map:
//! layout persistence for the ER diagram", commands `map_layout_get/save`).
//!
//! Two responsibilities live here:
//!
//! 1. **Layout persistence.** For each (connectionId, schema) the user can drag
//!    table cards and FK edges around; we remember those positions, the
//!    user-dragged edge waypoint offsets, and the zoom level so the diagram
//!    reopens exactly as the user left it. Keyed by `connectionId \0 schema`
//!    where `connectionId` is the *persisted* `SavedConnection` id (the same
//!    durable identity saved_queries uses for its `connectionId` attachment),
//!    so layouts survive restarts and follow the connection, not the ephemeral
//!    `ws-<uuid>` workspace.
//!
//! 2. **Export.** The renderer builds the diagram's SVG and the user picks a
//!    destination via the native save dialog (Task 3); the `diagram_export`
//!    command writes to that user-chosen path. The SVG text travels over IPC for
//!    both formats: an `svg` export is written verbatim, a `png` export is
//!    rasterized in Rust (`render::svg_to_png`, resvg). Rasterizing here rather
//!    than in the webview canvas is what makes PNG export work on Linux —
//!    WebKitGTK cannot draw an SVG to a canvas / read it back as PNG.
//!
//! Layering (dependencies point left): domain ← application ← (infrastructure | commands).
//!
//! Like saved_queries / connections / preferences, the backing store is a small
//! local JSON file, so the persistence port is *sync*; the Tauri commands are
//! `async fn` for consistency with the rest of the command surface.
//!
//! Map layouts are USER DATA, so this slice follows the connections /
//! saved_queries "corrupt file = error, not silent reset" stance rather than
//! the preferences slice's "corrupt = default".

pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod ports;
pub mod render;
