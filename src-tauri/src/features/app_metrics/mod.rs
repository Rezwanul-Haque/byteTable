//! App-metrics slice (M33): ByteTable's *own* CPU and resident-memory use, for
//! the status-bar readout. Host-level, not engine-level — the sibling
//! `processes` slice reports what the *database server* is doing; this one
//! reports what this app is doing to the user's machine.
//!
//! Layering (per ARCHITECTURE): the slice owns its whole stack. There is no
//! port/adapter split because there is no engine to abstract over — `sysinfo`
//! is the one implementation of "read this process's counters" on every target
//! ByteTable ships to, so the use-case owns the sampler directly.
//!
//! Unlike every other slice, the state here is genuinely stateful *by
//! necessity*: CPU percentage is a delta between two samples, so the sampler
//! must outlive a single command call (see `application::MetricsSampler`).

pub mod application;
pub mod commands;
