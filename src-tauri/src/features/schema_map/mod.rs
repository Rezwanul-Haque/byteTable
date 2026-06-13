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
//! 2. **Export-write.** The renderer rasterizes/serializes the diagram and the
//!    user picks a destination via the native save dialog (Task 3); the
//!    `diagram_export` command writes the bytes to that user-chosen path. PNG
//!    bytes travel over IPC as base64 (far cheaper than a JSON number array for
//!    a large image) and are decoded here; SVG travels as plain text.
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
