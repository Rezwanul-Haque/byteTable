//! Schedules slice (M41, `MILESTONE_41_SCHEDULED_QUERIES.md`): run a saved
//! report on a recurrence and drop the result into a folder as CSV or JSON,
//! with nobody at the keyboard.
//!
//! Layering (dependencies point left): domain ← application ←
//! (infrastructure | commands | scheduler).
//!
//! Two stores back it, both small local JSON files like the saved-queries
//! registry, so the persistence ports are *sync*. They differ in their
//! corrupt-file policy on purpose — see `infrastructure`.
//!
//! # The three things worth knowing before changing this slice
//!
//! **The scheduler is in-process.** A tokio task ticking every 30 seconds
//! (`scheduler`), not launchd / Task Scheduler / systemd. Close-to-tray keeps
//! the app alive after the window closes and the single-instance guard
//! guarantees exactly one of these loops, so an in-process scheduler inherits
//! the whole lifecycle for free. The cost is real and acknowledged: a schedule
//! does not fire while the app is fully quit. The mitigation is a BOUNDED
//! catch-up — one run per missed schedule, never one per missed interval.
//!
//! **The SQL is a resolved snapshot.** Query parameters are substituted by the
//! renderer when the schedule is saved, because the lexer that decides what is
//! and is not a placeholder lives there (`features/workspaces/sqlParams.ts`)
//! and a second implementation of it in Rust is the one thing in this feature
//! that must never disagree with the first. What stays dynamic is
//! `{{today}}`-style date tokens, which the domain expands per run.
//!
//! **Every run is read-only.** See `application::run_schedule`.

pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod ports;
pub mod scheduler;
