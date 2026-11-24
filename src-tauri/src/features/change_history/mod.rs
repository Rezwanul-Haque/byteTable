//! Change history slice (M48): a local log of data changes made through
//! ByteTable, with the rows before and after, so a change can be undone after
//! commit — and redone.
//!
//! - `domain` — the entry model, the diff, the per-row check, the reversing
//!   SQL per engine, and how to capture a statement. Pure and unit-tested.
//! - `store` — the log on disk (SQLite, in the app's data folder; never sent
//!   anywhere).
//! - `application` — recording writes as they run (one pinned session, the
//!   rows read in the write's own transaction), and undo / redo inside one
//!   transaction that re-checks the rows under lock.
//! - `commands` — Tauri handlers.

pub mod application;
pub mod commands;
pub mod domain;
pub mod store;
