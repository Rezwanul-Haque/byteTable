//! M16 "Generate data" — fill a whole schema with realistic, relationship-
//! correct fake data at a chosen size. Plan (pure) then run (writes via the
//! engine `bulk_insert`/`fetch_pk_pool`). Append-only, engine-aware
//! (SQLite/MySQL/Postgres); Redis is unsupported.
pub mod application;
pub mod commands;
pub mod domain;
pub mod generators;
pub mod planner;
