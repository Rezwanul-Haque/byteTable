//! Explain slice (M33): ask a SQL engine for its own execution plan and return
//! it in one shape the renderer can draw, whichever engine produced it.
//!
//! This exists because the plan the panel used to draw was *inferred from the
//! statement text*. That can name the clauses but not the access paths: it
//! always read as a sequential scan and never named an index, so it disagreed
//! with what the same query showed in a terminal. The plan now comes from the
//! optimizer.
//!
//! **Plans only — nothing is executed.** `EXPLAIN` without `ANALYZE` asks the
//! planner what it *would* do, which is why the panel can show a real plan on a
//! production connection without running the query. The `ANALYZE` form, which
//! does execute, is reachable only through [`commands::explain_raw`] and only
//! when the renderer asks for it explicitly.
//!
//! Layering (per ARCHITECTURE):
//! - `domain` — the plan value objects, the per-engine statement builder, and
//!   the three parsers. Entirely pure and unit-tested against output captured
//!   from real servers; no IO, no Tauri.
//! - `application` — use-cases; consumes the connections feature's
//!   `ConnectionManager` to resolve handles, as insights and schema_diff do.
//! - `commands` — Tauri handlers.
//!
//! Why the dialect lives in this slice's domain rather than in the
//! `crate::engines::*` adapters: an EXPLAIN is a plain statement over the
//! existing `run_query` surface, so no adapter needs new driver code, and the
//! parsing is presentation-shaped rather than connection-shaped. This is the
//! same call schema_diff makes for its per-engine DDL.
//!
//! Engine scope: Postgres, MySQL and SQLite. SQL Server's showplan needs a
//! session-wide `SET` applied to a following batch and Oracle needs a second
//! query against `DBMS_XPLAN`; neither survives one pooled statement, so both
//! report no support and the renderer keeps its modelled tree.

pub mod application;
pub mod commands;
pub mod domain;
