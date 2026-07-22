//! Engine adapters: the infrastructure implementations of the port traits
//! in `crate::shared::engine` (per ARCHITECTURE.md, "each engine implements
//! them as an infrastructure crate/module").
//!
//! Location note: these live at the crate root (not inside `shared/`) so
//! `shared/` stays a pure, driver-free kernel — the dependency direction is
//! `engines → shared`, never the reverse. Feature slices never import from
//! here; only the composition root (`lib.rs`) does, to register connectors.
//!
//! ALL engine-specific SQL (introspection queries, identifier quoting,
//! error-message vocabularies) lives exclusively in these modules.
//! `engines::postgres` (M12 Task 1) and `engines::mysql` (M12 Task 2) join the
//! original `engines::sqlite`.
//!
//! # Canonical adapter layout
//!
//! A SQL engine adapter is split by responsibility, mirroring the port modules
//! it implements (see `docs/superpowers/specs/2026-07-17-engine-module-layout-design.md`).
//! `engines::sqlite` is the reference:
//!
//! - `mod.rs` — connector, `EngineConnection` dispatch, open/connect only
//! - `introspect` — schemas / tables / columns / indexes / FKs (`ports::sql::meta`)
//! - `query` — run_query / fetch / lookup / column-stats (`ports::sql::query`)
//! - `mutate` — update / delete / truncate / drop / script (`ports::sql::mutate`)
//! - `structure` — `alter_table` preview + apply
//! - `objects` — list / define / drop DB objects
//! - `sql` — engine-private SQL dialect (quoting, WHERE/ORDER, value mapping)
//! - `error` — driver-error → `AppError` mapping and value rendering
//!
//! Tests stay inline (`#[cfg(test)] mod tests`) in each module; shared fixtures
//! live in one `#[cfg(test)] mod test_support` in the engine's `mod.rs`. An
//! engine with a live-server test suite (e.g. `postgres`) keeps those in a
//! dedicated `integration` module file, gated behind its `BYTETABLE_TEST_*_URL`
//! env var. All four relational adapters — `sqlite`, `postgres`, `mysql` and
//! `mssql` — follow this layout.
//!
//! The NoSQL adapters split by their own port family's read/write seam:
//! `mod.rs` (connector, connection, family-connection composition, shared
//! helpers) + `reader.rs` + `writer.rs` + `error.rs` + `value.rs`. `redis`
//! (keyvalue), `dynamo` (document), `mongo` and `cassandra` (widecolumn) all
//! follow this. Their live suites stay in the crate-root `tests/` directory
//! (public-API integration), gated behind `BYTETABLE_TEST_*_URL`.

pub mod cassandra;
pub mod clickhouse;
pub mod dynamo;
pub mod mongo;
pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod sqlite;
pub mod ssh;
