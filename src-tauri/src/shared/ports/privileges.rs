//! Privilege-catalog port (M39): the principals (users / roles / logins) an
//! engine knows, the role-membership edges between them, and the grants they
//! hold on objects.
//!
//! Like [`crate::shared::process`] this is a narrow **capability** a connection
//! may or may not expose, not one of the engine *families*. The four engines
//! that model privileges as *grantee × privilege × object* implement it
//! (Postgres, MySQL, SQL Server, ClickHouse); everything else keeps the default
//! `None` on [`crate::shared::engine::EngineConnection::as_privilege_reader`] —
//! SQLite has no principals at all, Redis ACL is command-categories plus
//! key-globs, Mongo is role documents over resources, and DynamoDB / Typesense
//! are governed outside the database connection entirely. Forcing those into
//! this shape would be a lossy lie, so they get the §5 `Unsupported` empty
//! state instead.
//!
//! Reads are unconditional; writes go through one `apply_grants(ops, apply)`
//! method reusing the M8 preview/apply pipeline (`AlterResult`) rather than a
//! method per verb. `ensure_writable` at the command layer — not this trait —
//! is what a read-only workspace refuses on.
//!
//! The engines diverge on two things the write path cannot paper over, so
//! [`GrantCapabilities`] reports both rather than letting the UI assume: whether
//! `DENY` is expressible, and whether a batch is atomic.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::engine::{AlterResult, QueryResult};
use crate::shared::error::AppError;

/// What one grantee × privilege × object cell holds.
///
/// Four states, not a boolean, because two engines need more than "granted or
/// not": SQL Server's `DENY` **overrides every inherited grant** (so it cannot
/// be modelled as absence), and ClickHouse's `is_partial_revoke` — a `REVOKE`
/// layered on top of a wildcard grant — means the same thing. Postgres and
/// MySQL never produce [`PrivilegeState::Denied`].
///
/// [`PrivilegeState::None`] is rarely transmitted (a cell with no grant simply
/// has no [`GrantEntry`]), but it exists so the renderer's cell type is total
/// and so the resolver in `features::privileges::domain` has a bottom value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivilegeState {
    /// Not held.
    None,
    /// Held.
    Granted,
    /// Held, and can be passed on: Postgres `WITH GRANT OPTION`, MySQL
    /// `IS_GRANTABLE='YES'`, SQL Server `GRANT_WITH_GRANT_OPTION`, ClickHouse
    /// `grant_option`.
    Grantable,
    /// Explicitly refused, beating any grant inherited through a role: SQL
    /// Server `DENY`, ClickHouse `is_partial_revoke`.
    Denied,
}

impl PrivilegeState {
    /// Precedence when several role paths reach the same cell. `Denied` wins
    /// outright; otherwise more access wins. Used by the effective-grant
    /// resolver — see `features::privileges::domain`.
    pub fn rank(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Granted => 1,
            Self::Grantable => 2,
            Self::Denied => 3,
        }
    }

    /// Parse the lowercase token the adapters emit in the fixed grant SELECT's
    /// state column. Anything unrecognized is treated as a plain grant rather
    /// than silently dropped — under-reporting a privilege is the dangerous
    /// direction for this feature.
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "denied" => Self::Denied,
            "grantable" => Self::Grantable,
            "none" => Self::None,
            _ => Self::Granted,
        }
    }
}

/// Which kind of thing a principal is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrincipalKind {
    /// An account that authenticates (Postgres `rolcanlogin`, a MySQL
    /// `user@host`, a SQL Server database user, a ClickHouse user).
    User,
    /// A grantable group with no login of its own.
    Role,
    /// A SQL Server **server**-level login, which is a different object from
    /// the database user it maps to. No other engine produces this.
    Login,
}

/// Which principal space a principal lives in. Only SQL Server has two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrincipalScope {
    /// Instance-wide (SQL Server `sys.server_principals`).
    Server,
    /// Scoped to the connected database — every engine but SQL Server's
    /// server principals.
    Database,
}

/// One engine-specific extra shown in the principal's Attributes pane. Keyed by
/// the column name the adapter's SELECT used, so adding an attribute is a
/// one-column SQL change with no DTO churn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrincipalAttribute {
    pub key: String,
    pub value: String,
}

/// A user / role / login, normalized across engines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    /// The name grants refer to. MySQL uses `user@host` (unquoted) so it
    /// matches the `GRANTEE` column once its quotes are stripped.
    pub name: String,
    pub kind: PrincipalKind,
    pub scope: PrincipalScope,
    /// Whether the principal can authenticate.
    pub can_login: bool,
    /// Postgres `rolsuper`, MySQL `Super_priv`, SQL Server `sysadmin` /
    /// `db_owner`, ClickHouse a global `ALL` grant.
    ///
    /// The renderer shows a badge and does NOT expand a matrix for these, and
    /// the resolver skips them: a superuser implicitly holds every privilege on
    /// every object, so expanding it would be both enormous and misleading
    /// (the grants are not recorded in the catalog at all).
    pub is_superuser: bool,
    /// Engine-specific extras for the Attributes pane, in SELECT order.
    pub attributes: Vec<PrincipalAttribute>,
}

/// `member` is a member of `role`. The resolver walks these transitively.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipEdge {
    pub member: String,
    pub role: String,
    /// Whether the membership can be passed on (Postgres `admin_option`,
    /// MySQL `WITH_ADMIN_OPTION`, ClickHouse `with_admin_option`).
    pub admin_option: bool,
}

/// One grantee × privilege × object cell.
///
/// `schema` / `object` encode wildcards rather than materializing them, which
/// is what keeps a global grant from expanding into thousands of rows:
///
/// - `schema: Some(s), object: Some(o)` — that one object.
/// - `schema: Some(s), object: None` — every object in `s` (a schema-level
///   grant, or ClickHouse `GRANT … ON db.*`).
/// - `schema: None, object: None` — every object anywhere (a global grant,
///   ClickHouse `ON *.*`, MySQL `information_schema.USER_PRIVILEGES`).
///
/// The renderer expands a wildcard across the rows it is already showing; no
/// layer below it ever needs the full object list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantEntry {
    pub grantee: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
    /// The engine's own privilege token, uppercased (`SELECT`, `INSERT`,
    /// `VIEW DEFINITION`, …). Not normalized across engines — the vocabulary
    /// genuinely differs and inventing a shared one would misreport.
    pub privilege: String,
    pub state: PrivilegeState,
    /// Empty when granted directly to `grantee`. Otherwise the role chain the
    /// grant arrived through, nearest first.
    ///
    /// This is the point of the effective view: a matrix that cannot answer
    /// "where did this come from?" is a worse debugging tool than the direct
    /// list it replaced.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub via: Vec<String>,
}

impl GrantEntry {
    /// How narrowly this entry is scoped: `0` global, `1` a whole schema, `2`
    /// one object.
    ///
    /// **The renderer must break ties with this before
    /// [`PrivilegeState::rank`].** Wildcard and specific entries are different
    /// rows, not competing versions of one row, so the effective resolver
    /// leaves both in place — it cannot expand a wildcard without the object
    /// list, which only the renderer has. Filling a cell therefore means:
    /// take every entry whose scope *covers* the cell, keep the highest
    /// `specificity()`, and only then compare `state.rank()`.
    ///
    /// Getting this backwards inverts real configurations. Verified against
    /// clickhouse-server 24.10: `GRANT SELECT ON *.*` followed by
    /// `REVOKE SELECT ON system.*` yields exactly two rows — a global
    /// `Granted` and a schema-scoped `Denied` — and only specificity-first
    /// ordering reports `system` as denied.
    pub fn specificity(&self) -> u8 {
        match (&self.schema, &self.object) {
            (Some(_), Some(_)) => 2,
            (Some(_), None) => 1,
            _ => 0,
        }
    }
}

/// A grant listing plus whether it hit the row cap. Grants are the only one of
/// the three lists that can realistically overflow, so only this one carries
/// the flag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantPage {
    pub grants: Vec<GrantEntry>,
    pub truncated: bool,
}

/// Everything the Privileges tab needs in one round trip. Fetching the three
/// lists separately would be wasteful — the effective-grant resolver needs all
/// of them at once anyway.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeSnapshot {
    pub principals: Vec<Principal>,
    pub memberships: Vec<MembershipEdge>,
    /// Direct grants, or effective ones with `via` filled, depending on the
    /// `effective` flag the command was called with.
    pub grants: Vec<GrantEntry>,
    /// True when the grant list hit the adapter's row cap — the renderer warns
    /// rather than quietly showing a partial matrix.
    pub truncated: bool,
    /// What this engine's editor may offer (Phase 2). Rides along with the
    /// data so the renderer never has to guess, or ask again.
    pub capabilities: GrantCapabilities,
}

/// What an engine's write path can actually express (M39 Phase 2).
///
/// Both flags exist because the four engines genuinely differ, and hiding that
/// would mean generating SQL an engine rejects or promising a rollback that
/// never happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantCapabilities {
    /// Whether [`GrantOp::Deny`](crate::features::privileges::domain::ops::GrantOp::Deny)
    /// can be written. True for SQL Server (a real `DENY`) and ClickHouse (a
    /// partial revoke, which behaves identically); false for Postgres and
    /// MySQL, which have no such state. The renderer reads this so the deny
    /// state is never offered where it cannot be written.
    pub can_deny: bool,
    /// Whether a multi-statement batch is applied atomically.
    ///
    /// True for Postgres and SQL Server, whose `GRANT`/`REVOKE` are
    /// transactional. **False for MySQL**, where they force an implicit commit
    /// so a half-applied batch cannot be rolled back, and for ClickHouse, which
    /// has no DCL transactions at all. The renderer states this before apply —
    /// quietly dropping M8's rollback guarantee on half the engines would be
    /// the worse failure.
    pub atomic: bool,
    /// Whether `REVOKE` works on a scope **narrower** than the grant that
    /// actually conferred the privilege.
    ///
    /// False for **MySQL**, which rejects `REVOKE SELECT ON db.tbl FROM u`
    /// when `u` only holds `SELECT ON *.*` — error 1147, "There is no such
    /// grant defined for user … on table …". Postgres and SQL Server treat the
    /// same revoke as a harmless no-op, and ClickHouse records it as the
    /// partial revoke Phase 1 reads back as `Denied`.
    ///
    /// The renderer reads this to refuse the edit up front, because the cell a
    /// user is most likely to click first — one filled in by a wildcard grant —
    /// is exactly the one that would fail.
    pub can_narrow_wildcard: bool,
}

/// The privilege-catalog capability: read principals, memberships and grants,
/// and — Phase 2 — preview or apply changes to them.
///
/// Adapters map driver errors to §5 human sentences before they cross here.
#[async_trait]
pub trait PrivilegeReader: Send + Sync {
    /// Every principal the connection can see.
    async fn list_principals(&self) -> Result<Vec<Principal>, AppError>;

    /// The role-membership edges. Empty — not an error — on an engine or
    /// version without roles (MySQL 5.7).
    async fn list_memberships(&self) -> Result<Vec<MembershipEdge>, AppError>;

    /// Direct grants, scoped to `schema` when the engine supports scoping.
    /// Wildcard and database-level grants are returned regardless of `schema`,
    /// encoded per [`GrantEntry`].
    async fn list_grants(&self, schema: Option<&str>) -> Result<GrantPage, AppError>;

    /// What this engine's write path can express. Pure — no round trip.
    fn grant_capabilities(&self) -> GrantCapabilities;

    /// The principal this connection is authenticated as, in the same spelling
    /// [`Principal::name`] uses (MySQL: `user@host`).
    ///
    /// Used only for the self-lockout guard, which is why it is on the port
    /// rather than read from connection params: what the server thinks you are
    /// is what its `REVOKE` will act on, and that is not always what was typed
    /// into the connect dialog.
    async fn current_principal(&self) -> Result<String, AppError>;

    /// Preview or apply a batch of staged changes — the M8 contract, reused.
    ///
    /// `apply == false` returns the statements the batch implies and **must not
    /// touch the database**. `apply == true` executes them, in a transaction on
    /// the engines whose [`GrantCapabilities::atomic`] is true and sequentially
    /// on the rest; either way it stops at the first failure.
    async fn apply_grants(
        &self,
        ops: &[crate::features::privileges::domain::ops::GrantOp],
        apply: bool,
    ) -> Result<AlterResult, AppError>;
}

// ---------------------------------------------------------------------------
// SQL helpers: shared row-mapping for the four relational engines
// ---------------------------------------------------------------------------
//
// Every adapter SELECTs the same leading columns in the same order, so one
// mapper serves all of them (the same trick as `process::map_sql_rows`).
//
//   principals:  0 name  1 kind  2 scope  3 can_login  4 is_superuser  5.. attributes
//   memberships: 0 member  1 role  2 admin_option
//   grants:      0 grantee  1 schema  2 object  3 privilege  4 state
//
// For principals, every column from index 5 on becomes an attribute keyed by
// its own column name — so an adapter adds an attribute by adding one aliased
// column, with no change here.

/// Row cap for the privilege catalogs. Far above
/// [`crate::shared::engine::QueryOptions`]'s 500-row browse default, which
/// would silently truncate a real grant list, but still bounded so a pathological
/// catalog cannot exhaust memory. [`PrivilegeSnapshot::truncated`] reports a hit.
pub const PRIVILEGE_ROW_LIMIT: usize = 50_000;

/// Map a [`QueryResult`] from the fixed principal SELECT.
pub fn map_principal_rows(result: QueryResult) -> Vec<Principal> {
    let attr_names: Vec<String> = result
        .columns
        .iter()
        .skip(5)
        .map(|c| c.name.clone())
        .collect();

    result
        .rows
        .iter()
        .map(|row| Principal {
            name: cell_string(row, 0),
            kind: match cell_string(row, 1).as_str() {
                "role" => PrincipalKind::Role,
                "login" => PrincipalKind::Login,
                _ => PrincipalKind::User,
            },
            scope: match cell_string(row, 2).as_str() {
                "server" => PrincipalScope::Server,
                _ => PrincipalScope::Database,
            },
            can_login: cell_bool(row, 3),
            is_superuser: cell_bool(row, 4),
            attributes: attr_names
                .iter()
                .enumerate()
                .filter_map(|(i, key)| {
                    let value = cell_string(row, i + 5);
                    (!value.is_empty()).then(|| PrincipalAttribute {
                        key: key.clone(),
                        value,
                    })
                })
                .collect(),
        })
        .collect()
}

/// Map a [`QueryResult`] from the fixed membership SELECT.
pub fn map_membership_rows(result: QueryResult) -> Vec<MembershipEdge> {
    result
        .rows
        .iter()
        .map(|row| MembershipEdge {
            member: cell_string(row, 0),
            role: cell_string(row, 1),
            admin_option: cell_bool(row, 2),
        })
        .collect()
}

/// Map a [`QueryResult`] from the fixed grant SELECT. Empty schema/object
/// strings become `None` — the wildcard encoding documented on [`GrantEntry`].
pub fn map_grant_rows(result: QueryResult) -> GrantPage {
    GrantPage {
        truncated: result.truncated,
        grants: result
            .rows
            .iter()
            .map(|row| GrantEntry {
                grantee: cell_string(row, 0),
                schema: cell_opt_string(row, 1),
                object: cell_opt_string(row, 2),
                privilege: cell_string(row, 3).to_uppercase(),
                state: PrivilegeState::parse(&cell_string(row, 4)),
                via: Vec::new(),
            })
            .collect(),
    }
}

/// The first column of the first row, as text — for the single-value probes
/// (`SELECT current_user` and friends) the write path's self-lockout guard
/// needs. Empty when the query returned nothing, which the caller treats as
/// "unknown principal" rather than a match.
pub fn first_cell(result: &QueryResult) -> String {
    result
        .rows
        .first()
        .map(|row| cell_string(row, 0))
        .unwrap_or_default()
}

fn cell_string(row: &[Value], i: usize) -> String {
    match row.get(i) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn cell_opt_string(row: &[Value], i: usize) -> Option<String> {
    match cell_string(row, i) {
        s if s.is_empty() => None,
        s => Some(s),
    }
}

fn cell_bool(row: &[Value], i: usize) -> bool {
    match row.get(i) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().map(|v| v != 0).unwrap_or(false),
        Some(Value::String(s)) => matches!(
            s.trim(),
            "1" | "t" | "true" | "TRUE" | "True" | "Y" | "y" | "YES" | "yes"
        ),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::engine::ColumnMeta;
    use serde_json::json;

    fn result(names: &[&str], rows: Vec<Vec<Value>>) -> QueryResult {
        QueryResult {
            columns: names
                .iter()
                .map(|n| ColumnMeta {
                    name: (*n).into(),
                    type_hint: "t".into(),
                })
                .collect(),
            row_count: rows.len(),
            rows,
            truncated: false,
            elapsed_ms: 0,
        }
    }

    #[test]
    fn maps_principals_and_names_attributes_from_their_columns() {
        let principals = map_principal_rows(result(
            &[
                "name",
                "kind",
                "scope",
                "can_login",
                "is_superuser",
                "Connection limit",
                "Valid until",
            ],
            vec![vec![
                json!("app_rw"),
                json!("user"),
                json!("database"),
                json!(true),
                json!(false),
                json!("-1"),
                json!(""),
            ]],
        ));

        assert_eq!(principals.len(), 1);
        let p = &principals[0];
        assert_eq!(p.name, "app_rw");
        assert_eq!(p.kind, PrincipalKind::User);
        assert_eq!(p.scope, PrincipalScope::Database);
        assert!(p.can_login);
        assert!(!p.is_superuser);
        // The empty "Valid until" is dropped rather than shown as a blank row.
        assert_eq!(p.attributes.len(), 1);
        assert_eq!(p.attributes[0].key, "Connection limit");
        assert_eq!(p.attributes[0].value, "-1");
    }

    #[test]
    fn maps_mysql_style_yes_no_booleans() {
        let principals = map_principal_rows(result(
            &["name", "kind", "scope", "can_login", "is_superuser"],
            vec![vec![
                json!("root@localhost"),
                json!("user"),
                json!("database"),
                json!("Y"),
                json!("Y"),
            ]],
        ));
        assert!(principals[0].can_login);
        assert!(principals[0].is_superuser);
    }

    #[test]
    fn maps_grants_and_encodes_blank_scope_as_wildcard() {
        let grants = map_grant_rows(result(
            &["grantee", "schema", "object", "privilege", "state"],
            vec![
                vec![
                    json!("app_rw"),
                    json!("public"),
                    json!("orders"),
                    json!("select"),
                    json!("granted"),
                ],
                vec![
                    json!("admin"),
                    json!(""),
                    json!(""),
                    json!("ALL"),
                    json!("grantable"),
                ],
                vec![
                    json!("app_ro"),
                    json!("dbo"),
                    json!("secrets"),
                    json!("SELECT"),
                    json!("denied"),
                ],
            ],
        ))
        .grants;

        assert_eq!(grants[0].schema.as_deref(), Some("public"));
        assert_eq!(grants[0].object.as_deref(), Some("orders"));
        // Privilege tokens are uppercased so engines that report lowercase
        // (ClickHouse) key the same matrix cell as those that do not.
        assert_eq!(grants[0].privilege, "SELECT");
        assert_eq!(grants[0].state, PrivilegeState::Granted);

        assert_eq!(grants[1].schema, None);
        assert_eq!(grants[1].object, None);
        assert_eq!(grants[1].state, PrivilegeState::Grantable);

        assert_eq!(grants[2].state, PrivilegeState::Denied);
    }

    fn entry(schema: Option<&str>, object: Option<&str>) -> GrantEntry {
        GrantEntry {
            grantee: "app".into(),
            schema: schema.map(Into::into),
            object: object.map(Into::into),
            privilege: "SELECT".into(),
            state: PrivilegeState::Granted,
            via: Vec::new(),
        }
    }

    #[test]
    fn specificity_orders_object_over_schema_over_global() {
        assert_eq!(entry(Some("s"), Some("t")).specificity(), 2);
        assert_eq!(entry(Some("s"), None).specificity(), 1);
        assert_eq!(entry(None, None).specificity(), 0);
    }

    #[test]
    fn a_schema_scoped_deny_is_more_specific_than_a_global_grant() {
        // The ClickHouse partial-revoke shape: these are two rows, and the
        // narrower one must win regardless of its state.
        let global = entry(None, None);
        let mut scoped = entry(Some("system"), None);
        scoped.state = PrivilegeState::Denied;
        assert!(scoped.specificity() > global.specificity());
    }

    #[test]
    fn denied_outranks_every_other_state() {
        assert!(PrivilegeState::Denied.rank() > PrivilegeState::Grantable.rank());
        assert!(PrivilegeState::Grantable.rank() > PrivilegeState::Granted.rank());
        assert!(PrivilegeState::Granted.rank() > PrivilegeState::None.rank());
    }

    #[test]
    fn unknown_state_tokens_fall_back_to_granted_not_dropped() {
        assert_eq!(PrivilegeState::parse("wat"), PrivilegeState::Granted);
        assert_eq!(PrivilegeState::parse("denied"), PrivilegeState::Denied);
    }

    #[test]
    fn maps_membership_edges() {
        let edges = map_membership_rows(result(
            &["member", "role", "admin_option"],
            vec![vec![json!("app_rw"), json!("writer"), json!(1)]],
        ));
        assert_eq!(edges[0].member, "app_rw");
        assert_eq!(edges[0].role, "writer");
        assert!(edges[0].admin_option);
    }
}
