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
//! **Nothing here mutates.** There is no `ensure_writable` call because no
//! command writes: the port exposes reads only, and the grant/revoke editor is
//! a later milestone that will reuse the M8 preview/apply pipeline rather than
//! widening this slice.

pub mod application;
pub mod commands;
pub mod domain;
