//! Value search — paste a value, find every table and column that holds it.
//!
//! The debugging tool for an unfamiliar schema: given an email, an id or any
//! fragment, sweep every table in scope and report where it appears. Read-only
//! from end to end, so there is no `ensure_writable` gate anywhere in the
//! slice.
//!
//! **This is a full table scan.** No index can serve "this value, somewhere, in
//! any column", so every table in scope is read front to back — twice, in fact,
//! because the engine adapters pair each filtered page with an exact filtered
//! `COUNT(*)` (the per-table match count is worth the second pass: "1,284
//! matches in `events.payload`" is the answer, not a detail). The renderer says
//! so plainly before the user starts one, and the sweep is cancellable between
//! tables.
//!
//! # Why there is almost no SQL here
//!
//! The work that looks like it belongs in this slice — per-engine `LIKE`
//! syntax, wildcard escaping, casting a non-text column so it can be compared
//! with text — is already done by the adapters behind
//! [`EngineConnection::fetch_rows`](crate::shared::engine::EngineConnection::fetch_rows).
//! A search of one table is a [`FilterSpec::Conditions`] of one `Contains` per
//! column, OR'd together; every adapter compiles that to **bound-parameter**
//! SQL, escapes `%`/`_`, and casts the column (`::text`, `CAST(… AS
//! NVARCHAR(MAX))`, `toString(…)`, or lax affinity) so the comparison works on
//! numbers, uuids and json alike. So this slice builds no SQL at all: it
//! decides *which columns are worth asking about* ([`domain`]) and *drives the
//! sweep* ([`application`]).
//!
//! # Engine scope
//!
//! SQL engines only — the five that implement `EngineConnection` (SQLite,
//! MySQL, Postgres, SQL Server, ClickHouse). The document / key-value / search
//! / wide-column families sit behind their own port traits with no
//! `fetch_rows`, so a handle of any other kind is refused by `get_sql` with the
//! usual §5 error rather than silently returning nothing.
//!
//! Cross-feature note: open handles are owned by the connections feature's
//! `ConnectionManager`; this slice consumes its `get_sql` accessor at the
//! application layer and its commands read `ConnectionsState` — the same
//! application-level composition the introspection and browse slices use.

pub mod application;
pub mod commands;
pub mod domain;
