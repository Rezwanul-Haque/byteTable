//! Structure-editor slice (M8, DESIGN_SPEC §3.6). Owns the staged-ALTER
//! pipeline: a batch of [`domain::AlterOp`]s the renderer accumulates from
//! inline edits, previewed (`alter_preview` → the "Review SQL" statements) and
//! applied (`alter_apply` → executed transactionally).
//!
//! Layering (per ARCHITECTURE): the slice owns its `domain` (the `AlterOp`
//! model). DDL *generation* and *execution* are engine-specific and live in
//! `crate::engines::*` behind the `EngineConnection::alter_table` port — the
//! slice never writes SQL. The application layer consumes the connections
//! feature's `ConnectionManager` (the same cross-feature composition as
//! introspection/browse); commands read `ConnectionsState`.
//!
//! Preview is PURE: it asks the adapter for the statement strings with
//! `apply == false`, which must not mutate the database. Apply executes with
//! `apply == true`, rolling back fully on any error.

pub mod application;
pub mod commands;
pub mod domain;
