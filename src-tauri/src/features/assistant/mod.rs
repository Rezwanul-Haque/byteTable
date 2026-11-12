//! Assistant slice (M44): an opt-in, bring-your-own-model helper for SQL
//! workspaces — write SQL from plain language, explain a query or a plan,
//! suggest an index, fix a failed statement.
//!
//! Four rules every layer keeps: **off until turned on** (no call of any kind,
//! not even model discovery, unless the user switched it on for that
//! workspace's connection — `aiEnabledFor`; with no workspace open it is
//! always off); **structure, not
//! data** (rows only behind a per-message switch, never on production);
//! **you see what is sent** (the prompt is built once, parked, and those bytes
//! are what is reviewed, sent and logged); **it proposes, you run** (nothing
//! here executes the user's SQL — plans are plan-only EXPLAIN).
//!
//! Layering: domain ← application ← (infrastructure | commands). The gates
//! take the assistant's keys with each call and resolve a handle's environment
//! from the connection registry, so production and rows-on-production are
//! decided by the backend whatever the renderer sends.

pub mod application;
pub mod commands;
pub mod domain;
pub mod engines;
pub mod infrastructure;
pub mod ports;
