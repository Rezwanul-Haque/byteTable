//! Export slice (M15, DESIGN_SPEC §3.5/§3.6): generate CSV / SQL text for a
//! table or a whole schema, and write it to a user-chosen path. Ports the
//! formatting semantics of the export prototype
//! (`ByteTable_latest/bytetable/export.jsx`: `csvVal` / `sqlVal`, the CSV
//! header+rows shape, and the DDL+INSERT dump) — but where the prototype
//! downloaded via a browser Blob, ByteTable produces the text in the Rust
//! backend and saves through the native file dialog.
//!
//! Layering: `domain` (pure value formatters + the `ExportFormat` enum) ←
//! `application` (paging generation over the engine port + the file write) ←
//! `commands`. The slice owns no infrastructure: generation uses the EXISTING
//! `EngineConnection::fetch_rows` / `table_meta` / `list_tables` (paged in the
//! application layer), and the one engine-specific need — identifier quoting —
//! is the `EngineConnection::quote_identifier` hook. See `application` for the
//! "why application-layer paging, not a new per-engine method" rationale.
//!
//! Cross-feature note: open connection handles are owned by the connections
//! feature's `ConnectionManager`; this slice consumes it at the application
//! layer (and its commands read `ConnectionsState`) — the same composition
//! pattern browse / insights / mutate use.

pub mod application;
pub mod commands;
pub mod domain;
