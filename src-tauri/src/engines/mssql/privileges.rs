//! SQL Server privilege-catalog adapter (M39): `sys.database_principals` +
//! `sys.server_principals` → principals, `sys.*_role_members` → memberships,
//! and `sys.database_permissions` → grants.
//!
//! SQL Server is the engine the shared model had to stretch for, in two ways:
//!
//! 1. **Two principal spaces.** A server *login* authenticates to the instance;
//!    a database *user* is a separate object the login maps into. They have
//!    separate catalogs, separate role memberships, and different permissions.
//!    Both are listed, told apart by
//!    [`PrincipalScope`](crate::shared::privileges::PrincipalScope).
//! 2. **`DENY` is a real state**, not the absence of a grant: it beats every
//!    permission the principal would otherwise inherit through a role. That is
//!    the reason the cell model has four states instead of a boolean. It maps
//!    straight from `sys.database_permissions.state`.
//!
//! Fixed roles (`db_datareader`, `db_owner`, …) are deliberately *not* filtered
//! out: they carry much of the access in a typical database, and hiding them
//! would break the inheritance chains the effective view is built on.
//!
//! Phase 1 is object-level — `minor_id = 0` excludes column-level permissions.

use async_trait::async_trait;

use crate::features::privileges::domain::ops::{self, GrantOp, Scope, MASKED_SECRET};
use crate::shared::engine::{AlterResult, EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::privileges::{
    self, GrantCapabilities, GrantPage, MembershipEdge, Principal, PrincipalKind, PrincipalScope,
    PrivilegeReader, PRIVILEGE_ROW_LIMIT,
};

use super::sql::{qualified, quote_ident};
use super::MssqlEngineConnection;

/// The fixed principal SELECT: database principals, then server principals.
/// Only the first arm's aliases name the result columns, which is what the
/// attribute mapper reads. `##`-prefixed principals are the engine's internal
/// certificate-backed accounts and are never interesting here.
///
/// `IS_ROLEMEMBER` / `IS_SRVROLEMEMBER` return NULL for a principal that cannot
/// be evaluated (a role, a login with no matching user), hence the coalesce —
/// without it a NULL would read as "not a superuser" only by luck.
const PRINCIPALS_SQL: &str = "SELECT \
    p.name, \
    CASE WHEN p.type = 'R' THEN 'role' ELSE 'user' END, \
    'database', \
    CASE WHEN p.type IN ('S', 'U', 'G') THEN 1 ELSE 0 END, \
    CASE WHEN p.name = 'dbo' \
          OR coalesce(IS_ROLEMEMBER('db_owner', p.name), 0) = 1 THEN 1 ELSE 0 END, \
    p.type_desc AS [Type], \
    CONVERT(varchar(16), p.create_date, 120) AS [Created], \
    coalesce(p.default_schema_name, '') AS [Default schema] \
    FROM sys.database_principals p \
    WHERE p.name NOT LIKE '##%' \
    UNION ALL \
    SELECT \
    sp.name, \
    CASE WHEN sp.type = 'R' THEN 'role' ELSE 'login' END, \
    'server', \
    CASE WHEN sp.type IN ('S', 'U', 'G') THEN 1 ELSE 0 END, \
    coalesce(IS_SRVROLEMEMBER('sysadmin', sp.name), 0), \
    sp.type_desc, \
    CONVERT(varchar(16), sp.create_date, 120), \
    '' \
    FROM sys.server_principals sp \
    WHERE sp.name NOT LIKE '##%' \
    ORDER BY 3, 2, 1";

/// Database and server role memberships. SQL Server has no per-membership
/// admin flag, so `admin_option` is always false here.
const MEMBERSHIPS_SQL: &str = "SELECT m.name, r.name, 0 \
    FROM sys.database_role_members drm \
    JOIN sys.database_principals r ON r.principal_id = drm.role_principal_id \
    JOIN sys.database_principals m ON m.principal_id = drm.member_principal_id \
    UNION ALL \
    SELECT m.name, r.name, 0 \
    FROM sys.server_role_members srm \
    JOIN sys.server_principals r ON r.principal_id = srm.role_principal_id \
    JOIN sys.server_principals m ON m.principal_id = srm.member_principal_id";

#[async_trait]
impl PrivilegeReader for MssqlEngineConnection {
    async fn list_principals(&self) -> Result<Vec<Principal>, AppError> {
        let result = self.run_query(PRINCIPALS_SQL, catalog_options()).await?;
        Ok(privileges::map_principal_rows(result))
    }

    async fn list_memberships(&self) -> Result<Vec<MembershipEdge>, AppError> {
        let result = self.run_query(MEMBERSHIPS_SQL, catalog_options()).await?;
        Ok(privileges::map_membership_rows(result))
    }

    async fn list_grants(&self, schema: Option<&str>) -> Result<GrantPage, AppError> {
        let result = self
            .run_query(&grants_sql(schema), catalog_options())
            .await?;
        Ok(privileges::map_grant_rows(result))
    }

    fn grant_capabilities(&self) -> GrantCapabilities {
        // DENY is a first-class state here, DCL is transactional, and revoking
        // a permission that was never granted at that scope is a no-op.
        GrantCapabilities {
            can_deny: true,
            atomic: true,
            can_narrow_wildcard: true,
        }
    }

    async fn current_principal(&self) -> Result<String, AppError> {
        // The DATABASE user, not the server login: grants act on the former.
        let result = self
            .run_query("SELECT USER_NAME()", QueryOptions::default())
            .await?;
        Ok(privileges::first_cell(&result))
    }

    async fn apply_grants(&self, ops: &[GrantOp], apply: bool) -> Result<AlterResult, AppError> {
        apply_grants(self, ops, apply).await
    }
}

/// Catalog reads need far more than the 500-row browse default.
fn catalog_options() -> QueryOptions {
    QueryOptions {
        row_limit: PRIVILEGE_ROW_LIMIT,
        schema: None,
    }
}

/// Object (`class = 1`), schema (`class = 3`) and database (`class = 0`)
/// permissions in one listing.
///
/// `state` maps directly onto the four-state cell: `W` is
/// `GRANT_WITH_GRANT_OPTION`, `D` is `DENY`, `G` is a plain grant. `R`
/// (revoked) is excluded — a revoke is the *absence* of a permission and has no
/// row in the matrix, unlike a deny.
fn grants_sql(schema: Option<&str>) -> String {
    let scope = schema_predicate(schema);
    format!(
        "SELECT \
         g.name, \
         coalesce(s.name, ''), \
         coalesce(o.name, ''), \
         RTRIM(dp.permission_name), \
         CASE dp.state WHEN 'W' THEN 'grantable' WHEN 'D' THEN 'denied' ELSE 'granted' END \
         FROM sys.database_permissions dp \
         JOIN sys.database_principals g ON g.principal_id = dp.grantee_principal_id \
         LEFT JOIN sys.objects o ON dp.class = 1 AND o.object_id = dp.major_id \
         LEFT JOIN sys.schemas s ON (dp.class = 1 AND s.schema_id = o.schema_id) \
                                 OR (dp.class = 3 AND s.schema_id = dp.major_id) \
         WHERE dp.state IN ('G', 'W', 'D') AND dp.minor_id = 0 AND {scope}"
    )
}

/// Restrict to one schema while keeping database-wide permissions, which apply
/// inside the selected schema as well.
fn schema_predicate(schema: Option<&str>) -> String {
    match schema {
        Some(name) => format!("(s.name = {} OR dp.class = 0)", literal(name)),
        None => "1 = 1".to_string(),
    }
}

/// A single-quoted SQL Server string literal with embedded quotes doubled.
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_three_permission_states_including_deny() {
        let sql = grants_sql(None);
        assert!(sql.contains("WHEN 'W' THEN 'grantable'"));
        assert!(sql.contains("WHEN 'D' THEN 'denied'"));
        // A revoke is an absent permission, not a cell.
        assert!(sql.contains("dp.state IN ('G', 'W', 'D')"));
    }

    #[test]
    fn keeps_database_wide_permissions_when_scoped_to_a_schema() {
        let sql = grants_sql(Some("dbo"));
        assert!(sql.contains("(s.name = 'dbo' OR dp.class = 0)"));
    }

    #[test]
    fn lists_both_principal_spaces() {
        assert!(PRINCIPALS_SQL.contains("FROM sys.database_principals p"));
        assert!(PRINCIPALS_SQL.contains("FROM sys.server_principals sp"));
        assert!(PRINCIPALS_SQL.contains("'server'"));
        assert!(PRINCIPALS_SQL.contains("'login'"));
    }

    #[test]
    fn keeps_fixed_roles_so_inheritance_chains_stay_intact() {
        // Filtering `is_fixed_role = 1` would hide db_datareader and break the
        // effective view for most real databases.
        assert!(!PRINCIPALS_SQL.contains("is_fixed_role"));
    }

    #[test]
    fn excludes_column_level_permissions_in_phase_one() {
        assert!(grants_sql(None).contains("dp.minor_id = 0"));
    }

    #[test]
    fn escapes_a_quote_in_the_schema_name() {
        assert!(grants_sql(Some("o'brien")).contains("s.name = 'o''brien'"));
    }
}

// ---------------------------------------------------------------------------
// Phase 2 — statement generation + transactional apply
// ---------------------------------------------------------------------------

/// The securable a scope names. SQL Server addresses these by class prefix:
/// `OBJECT::`, `SCHEMA::`, or — at database level — no `ON` clause at all.
enum Securable {
    /// `ON OBJECT::[s].[t]` / `ON SCHEMA::[s]`
    On(String),
    /// Database-level permission: `GRANT CREATE TABLE TO [g]`, no `ON`.
    Database,
}

fn securable(scope: &Scope) -> Securable {
    match (&scope.schema, &scope.object) {
        (Some(schema), Some(object)) => {
            Securable::On(format!("OBJECT::{}", qualified(schema, object)))
        }
        (Some(schema), None) => Securable::On(format!("SCHEMA::{}", quote_ident(schema))),
        _ => Securable::Database,
    }
}

/// `GRANT x ON OBJECT::[s].[t] TO [g]` or `GRANT x TO [g]`.
fn permission_statement(
    verb: &str,
    privilege: &str,
    scope: &Scope,
    preposition: &str,
    grantee: &str,
    suffix: &str,
) -> String {
    match securable(scope) {
        Securable::On(target) => format!(
            "{verb} {privilege} ON {target} {preposition} {}{suffix}",
            quote_ident(grantee)
        ),
        Securable::Database => format!(
            "{verb} {privilege} {preposition} {}{suffix}",
            quote_ident(grantee)
        ),
    }
}

/// The SQL one staged op implies.
///
/// SQL Server's three states are three different verbs, and they do not undo
/// each other symmetrically: `REVOKE` clears either a `GRANT` or a `DENY`,
/// while `GRANT` over an existing `DENY` does **not** clear it. The editor's
/// transitions rely on that, so a cell going `denied → granted` must stage a
/// `Revoke` before the `Grant`.
fn op_statement(op: &GrantOp, reveal: bool) -> Result<String, AppError> {
    Ok(match op {
        GrantOp::Grant {
            grantee,
            privilege,
            scope,
            grantable,
        } => permission_statement(
            "GRANT",
            privilege,
            scope,
            "TO",
            grantee,
            if *grantable { " WITH GRANT OPTION" } else { "" },
        ),
        GrantOp::Revoke {
            grantee,
            privilege,
            scope,
        } => permission_statement("REVOKE", privilege, scope, "FROM", grantee, ""),
        GrantOp::Deny {
            grantee,
            privilege,
            scope,
        } => permission_statement("DENY", privilege, scope, "TO", grantee, ""),
        // CASCADE is required: SQL Server refuses to revoke a grant option
        // without it, since anything the grantee passed on must go too.
        GrantOp::RevokeGrantOption {
            grantee,
            privilege,
            scope,
        } => {
            let ident = quote_ident(grantee);
            match securable(scope) {
                Securable::On(target) => {
                    format!("REVOKE GRANT OPTION FOR {privilege} ON {target} FROM {ident} CASCADE")
                }
                Securable::Database => {
                    format!("REVOKE GRANT OPTION FOR {privilege} FROM {ident} CASCADE")
                }
            }
        }
        GrantOp::AddMember { member, role } => format!(
            "ALTER ROLE {} ADD MEMBER {}",
            quote_ident(role),
            quote_ident(member)
        ),
        GrantOp::DropMember { member, role } => format!(
            "ALTER ROLE {} DROP MEMBER {}",
            quote_ident(role),
            quote_ident(member)
        ),
        // SQL Server is the one engine where "create a user" is ambiguous: a
        // server LOGIN authenticates to the instance, a database USER is a
        // separate object, and `scope` says which is meant.
        GrantOp::CreatePrincipal {
            name,
            principal_kind,
            scope,
            password,
        } => {
            let ident = quote_ident(name);
            if *principal_kind == PrincipalKind::Role {
                format!("CREATE ROLE {ident}")
            } else if *scope == PrincipalScope::Server {
                match password {
                    Some(secret) => format!(
                        "CREATE LOGIN {ident} WITH PASSWORD = {}",
                        secret_literal(secret, reveal)
                    ),
                    None => {
                        return Err(AppError::Invalid(
                            "A SQL Server login needs a password.".into(),
                        ))
                    }
                }
            } else {
                match password {
                    // A contained-database user. On a non-contained database
                    // SQL Server rejects this and wants FOR LOGIN instead —
                    // its own error says so clearly, so it is not pre-empted
                    // here.
                    Some(secret) => format!(
                        "CREATE USER {ident} WITH PASSWORD = {}",
                        secret_literal(secret, reveal)
                    ),
                    None => format!("CREATE USER {ident} WITHOUT LOGIN"),
                }
            }
        }
        GrantOp::DropPrincipal {
            name,
            principal_kind,
            scope,
        } => {
            let what = if *principal_kind == PrincipalKind::Role {
                "ROLE"
            } else if *scope == PrincipalScope::Server {
                "LOGIN"
            } else {
                "USER"
            };
            format!("DROP {what} {}", quote_ident(name))
        }
    })
}

/// A password literal — the real one only when `reveal`, which is true solely
/// for the statement that is executed. See [`MASKED_SECRET`].
fn secret_literal(secret: &str, reveal: bool) -> String {
    format!(
        "'{}'",
        (if reveal { secret } else { MASKED_SECRET }).replace('\'', "''")
    )
}

/// Preview or apply a batch. SQL Server's DCL is transactional, so apply keeps
/// the M8 all-or-nothing contract.
pub(super) async fn apply_grants(
    conn: &MssqlEngineConnection,
    ops: &[GrantOp],
    apply: bool,
) -> Result<AlterResult, AppError> {
    ops::validate_ops(ops)?;
    // Two renderings: `statements` is what the caller SEES (passwords masked)
    // and is the only one that ever leaves this function; `executed` is what
    // runs and is dropped on the way out.
    let statements = ops
        .iter()
        .map(|op| op_statement(op, false))
        .collect::<Result<Vec<_>, AppError>>()?;

    if !apply {
        return Ok(AlterResult {
            statements,
            applied: false,
        });
    }

    let executed = ops
        .iter()
        .map(|op| op_statement(op, true))
        .collect::<Result<Vec<_>, AppError>>()?;

    let mut guard = conn.client.lock().await;
    super::exec_batch(&mut guard, "BEGIN TRANSACTION").await?;
    for statement in &executed {
        if let Err(err) = super::exec_batch(&mut guard, statement.clone()).await {
            let _ = super::exec_batch(&mut guard, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION").await;
            return Err(err);
        }
    }
    super::exec_batch(&mut guard, "COMMIT TRANSACTION").await?;

    Ok(AlterResult {
        statements,
        applied: true,
    })
}

#[cfg(test)]
mod write_tests {
    use super::*;

    fn scope(schema: Option<&str>, object: Option<&str>) -> Scope {
        Scope {
            schema: schema.map(Into::into),
            object: object.map(Into::into),
        }
    }

    fn op(verb: &str, scope: Scope) -> GrantOp {
        match verb {
            "grant" => GrantOp::Grant {
                grantee: "app".into(),
                privilege: "SELECT".into(),
                scope,
                grantable: false,
            },
            "deny" => GrantOp::Deny {
                grantee: "app".into(),
                privilege: "SELECT".into(),
                scope,
            },
            _ => GrantOp::Revoke {
                grantee: "app".into(),
                privilege: "SELECT".into(),
                scope,
            },
        }
    }

    #[test]
    fn addresses_an_object_by_class_prefix() {
        assert_eq!(
            op_statement(&op("grant", scope(Some("dbo"), Some("orders"))), false).unwrap(),
            "GRANT SELECT ON OBJECT::[dbo].[orders] TO [app]"
        );
    }

    #[test]
    fn addresses_a_schema_by_class_prefix() {
        assert_eq!(
            op_statement(&op("grant", scope(Some("dbo"), None)), false).unwrap(),
            "GRANT SELECT ON OBJECT::[dbo].[orders] TO [app]"
                .replace("ON OBJECT::[dbo].[orders]", "ON SCHEMA::[dbo]")
        );
    }

    #[test]
    fn a_database_level_permission_has_no_on_clause() {
        assert_eq!(
            op_statement(&op("grant", scope(None, None)), false).unwrap(),
            "GRANT SELECT TO [app]"
        );
    }

    #[test]
    fn the_three_states_are_three_verbs() {
        let s = scope(Some("dbo"), Some("orders"));
        assert!(op_statement(&op("grant", s.clone()), false)
            .unwrap()
            .starts_with("GRANT "));
        assert!(op_statement(&op("deny", s.clone()), false)
            .unwrap()
            .starts_with("DENY "));
        let revoke = op_statement(&op("revoke", s), false).unwrap();
        assert!(revoke.starts_with("REVOKE "));
        // REVOKE takes FROM; GRANT and DENY take TO.
        assert!(revoke.contains(" FROM [app]"));
    }

    #[test]
    fn role_membership_uses_alter_role() {
        let add = GrantOp::AddMember {
            member: "app".into(),
            role: "writer".into(),
        };
        assert_eq!(
            op_statement(&add, false).unwrap(),
            "ALTER ROLE [writer] ADD MEMBER [app]"
        );
        let drop = GrantOp::DropMember {
            member: "app".into(),
            role: "writer".into(),
        };
        assert_eq!(
            op_statement(&drop, false).unwrap(),
            "ALTER ROLE [writer] DROP MEMBER [app]"
        );
    }

    #[test]
    fn a_bracket_in_a_name_cannot_break_out() {
        let op = GrantOp::AddMember {
            member: "ev]il".into(),
            role: "writer".into(),
        };
        assert!(op_statement(&op, false).unwrap().contains("[ev]]il]"));
    }
    #[test]
    fn a_password_is_masked_in_the_statement_that_is_shown() {
        let op = GrantOp::CreatePrincipal {
            name: "app".into(),
            principal_kind: PrincipalKind::User,
            scope: crate::shared::privileges::PrincipalScope::Database,
            password: Some("hunter2".into()),
        };
        let shown = op_statement(&op, false).unwrap();
        assert!(
            !shown.contains("hunter2"),
            "the real password leaked: {shown}"
        );
        assert!(shown.contains(MASKED_SECRET), "no mask in {shown}");

        // …and the executed form carries the real one.
        let executed = op_statement(&op, true).unwrap();
        assert!(executed.contains("hunter2"));
    }

    #[test]
    fn a_role_is_created_without_a_password_clause() {
        let op = GrantOp::CreatePrincipal {
            name: "writer".into(),
            principal_kind: PrincipalKind::Role,
            scope: crate::shared::privileges::PrincipalScope::Database,
            password: None,
        };
        let sql = op_statement(&op, false).unwrap();
        assert!(sql.to_uppercase().contains("ROLE"), "got {sql}");
        assert!(!sql.to_uppercase().contains("PASSWORD"));
        assert!(!sql.to_uppercase().contains("IDENTIFIED"));
    }
    #[test]
    fn drops_the_grant_option_with_the_cascade_sql_server_requires() {
        let op = GrantOp::RevokeGrantOption {
            grantee: "app".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("dbo"), Some("orders")),
        };
        assert_eq!(
            op_statement(&op, false).unwrap(),
            "REVOKE GRANT OPTION FOR SELECT ON OBJECT::[dbo].[orders] FROM [app] CASCADE"
        );
    }
}
