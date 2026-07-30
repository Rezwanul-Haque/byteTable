//! Schema Diff & Sync slice (M28): compare the **structure** of two SQL
//! schemas, expose the DDL for the differences, and — in sync mode — apply a
//! checkbox-selected migration that makes the target match the source.
//!
//! **Structure only. Row data is never read, copied, or moved.** The read side
//! can only return columns and indexes (the [`ports::SchemaReader`] boundary),
//! and the write side can only run planner-produced DDL.
//!
//! Layering (per ARCHITECTURE):
//! - `domain` — snapshot / diff / statement value objects plus the pure differ
//!   and planner. The whole comparison lives here and is unit-tested.
//! - `ports` — the read boundary (`SchemaReader`).
//! - `infrastructure` — the adapter over an open [`crate::shared::engine::EngineConnection`],
//!   built from `list_tables` + `table_meta` (no new driver code).
//! - `application` — use-cases; consumes the connections feature's
//!   `ConnectionManager` to resolve handles, as introspection/structure do.
//! - `commands` — Tauri handlers.
//!
//! Engine scope: the relational engines. Mongo / Redis / DynamoDB / Cassandra
//! have no structural snapshot to diff and no entry point in the UI.

pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod ports;
