//! Result compare slice (M51): run two versions of a query on one connection
//! and return both results, so the renderer can show the rows that appear in
//! only one of them and the rows whose values changed.
//!
//! Layering (per ARCHITECTURE):
//! - `application` — the read-only and row-cap rules, the snapshot
//!   transaction, and cancel. No Tauri.
//! - `commands` — Tauri handlers and the per-run cancel tokens.
//!
//! The comparison itself lives in the renderer
//! (`src/features/result_compare/compareModel.ts`): the key and order choices
//! change it without running anything again.

pub mod application;
pub mod commands;
