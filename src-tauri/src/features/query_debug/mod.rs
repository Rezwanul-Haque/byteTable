//! Query debug slice (M45): step through one SELECT in the order the database
//! runs it, and count the rows alive after each step.
//!
//! A database runs a query as one unit, so there is nothing to pause. The
//! slice cuts the statement at its clause boundaries and runs each prefix as
//! its own read-only SELECT. Every count is measured by running the step,
//! never estimated.
//!
//! Layering (per ARCHITECTURE):
//! - `domain` — finding the clauses and writing the step queries, by slicing
//!   the user's own text with the shared lexer. Pure and unit-tested.
//! - `application` — the plan-only validity check and running one step with
//!   its sample cap, timeout and cancel. Read-only on every connection.
//! - `commands` — Tauri handlers and the per-run cancel tokens.

pub mod application;
pub mod commands;
pub mod domain;
