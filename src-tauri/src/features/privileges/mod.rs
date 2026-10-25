//! Privileges slice (M39): the users / roles / logins a connection knows, the
//! role-membership edges between them, and the grants they hold — read-only.
//!
//! Layering (per ARCHITECTURE): the slice owns its [`domain`] (effective-grant
//! resolution, which is pure and engine-neutral), while reading the catalogs is
//! engine-specific and lives in `crate::engines::*` behind the
//! [`crate::shared::privileges::PrivilegeReader`] port — the slice never writes
//! SQL. The application layer consumes the connections feature's
//! `ConnectionManager` (the same cross-feature composition as
//! introspection/structure/processes); commands read `ConnectionsState`.
//!
//! Phase 2 adds the grant/revoke editor on the M8 preview/apply pipeline:
//! `privilege_preview` is pure, `privilege_apply` calls `ensure_writable`
//! first, and both refuse a batch that would strip the connected account's own
//! access (the write-path equivalent of the Processes tab's `is_self` guard).

pub mod application;
pub mod commands;
pub mod domain;
