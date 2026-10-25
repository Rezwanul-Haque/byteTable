//! ClickHouse privilege-catalog adapter (M39): `system.users` +
//! `system.roles` → principals, `system.role_grants` → memberships, and
//! `system.grants` → grants.
//!
//! ClickHouse's access catalog is the cleanest of the four, with one wrinkle
//! that matters: **`is_partial_revoke`**. ClickHouse lets a `REVOKE` be layered
//! on top of a wildcard grant (`GRANT SELECT ON *.* … REVOKE SELECT ON
//! secret.*`), and the revoked row stays in `system.grants` with that flag set.
//! It is a deny, not an absence, so it maps to
//! [`PrivilegeState::Denied`](crate::shared::privileges::PrivilegeState::Denied)
//! — the same cell state SQL Server's `DENY` uses, and the second reason the
//! model is four-state.
//!
//! NULL `database` / `table` mean *all*, and are passed through as the wildcard
//! encoding on [`GrantEntry`](crate::shared::privileges::GrantEntry) rather
//! than expanded here. Materializing a `GRANT … ON *.*` across every object
//! would turn one row into thousands.
//!
//! Correlated subqueries are not supported by ClickHouse, so the superuser flag
//! is an uncorrelated `IN (…)` against the globally access-managing grantees
//! rather than a per-row lookup.
//!
//! Phase 1 is object-level: rows with a non-NULL `column` are skipped.

use async_trait::async_trait;

use crate::features::privileges::domain::ops::{self, GrantOp, Scope, MASKED_SECRET};
use crate::shared::engine::{AlterResult, EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::privileges::{
    self, GrantCapabilities, GrantPage, MembershipEdge, Principal, PrincipalKind, PrivilegeReader,
    PRIVILEGE_ROW_LIMIT,
};

use super::sql::{qualified, quote_ident};
use super::ClickhouseEngineConnection;

/// The fixed principal SELECT: users, then roles.
///
/// The superuser signal is a global **`ACCESS MANAGEMENT`** grant, not `ALL`.
/// ClickHouse expands `GRANT ALL ON *.*` into one `system.grants` row per
/// individual access type, so no row ever reads `ALL` and checking for one
/// would be dead code that silently reports every account as unprivileged.
/// `ACCESS MANAGEMENT` — the right to administer users and grants — is the
/// privilege that actually survives in the catalog and is the closest analogue
/// to a superuser here.
const PRINCIPALS_SQL: &str = "SELECT \
    u.name, \
    'user', \
    'database', \
    1, \
    u.name IN ( \
        SELECT user_name FROM system.grants \
        WHERE toString(access_type) = 'ACCESS MANAGEMENT' \
          AND database IS NULL AND user_name IS NOT NULL \
    ), \
    toString(u.storage) AS `Storage` \
    FROM system.users u \
    UNION ALL \
    SELECT r.name, 'role', 'database', 0, 0, toString(r.storage) \
    FROM system.roles r \
    ORDER BY 2, 1";

/// `user_name` and `role_name` are mutually exclusive — a row is a grant to one
/// or the other — so coalescing them yields the member.
const MEMBERSHIPS_SQL: &str = "SELECT \
    coalesce(user_name, role_name, ''), \
    granted_role_name, \
    with_admin_option \
    FROM system.role_grants";

#[async_trait]
impl PrivilegeReader for ClickhouseEngineConnection {
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
        // A partial revoke IS a deny here, so the state is writable; access
        // control has no transaction; and a narrower revoke is exactly how a
        // partial revoke is created.
        GrantCapabilities {
            can_deny: true,
            atomic: false,
            can_narrow_wildcard: true,
        }
    }

    async fn current_principal(&self) -> Result<String, AppError> {
        let result = self
            .run_query("SELECT currentUser()", QueryOptions::default())
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

/// Grants, with `is_partial_revoke` taking precedence over `grant_option` —
/// a revoked wildcard row is a deny regardless of how it was originally
/// granted.
fn grants_sql(schema: Option<&str>) -> String {
    let scope = schema_predicate(schema);
    format!(
        "SELECT \
         coalesce(user_name, role_name, ''), \
         coalesce(`database`, ''), \
         coalesce(`table`, ''), \
         toString(access_type), \
         multiIf(is_partial_revoke != 0, 'denied', grant_option != 0, 'grantable', 'granted') \
         FROM system.grants \
         WHERE `column` IS NULL AND {scope}"
    )
}

/// Restrict to one database while keeping wildcard grants, whose NULL
/// `database` means they apply to the selected one too.
fn schema_predicate(schema: Option<&str>) -> String {
    match schema {
        Some(name) => format!(
            "(`database` IS NULL OR `database` = {})",
            super::sql::ch_string_literal(name)
        ),
        None => "1".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_revoke_outranks_the_grant_option_flag() {
        let sql = grants_sql(None);
        let revoke = sql.find("is_partial_revoke").expect("deny arm");
        let grantable = sql.find("grant_option != 0").expect("grantable arm");
        assert!(revoke < grantable, "multiIf must test the deny first");
        assert!(sql.contains("'denied'"));
    }

    #[test]
    fn keeps_wildcard_grants_when_scoped_to_a_database() {
        let sql = grants_sql(Some("shop"));
        assert!(sql.contains("`database` IS NULL OR `database` = 'shop'"));
    }

    #[test]
    fn excludes_column_level_grants_in_phase_one() {
        assert!(grants_sql(None).contains("`column` IS NULL"));
    }

    #[test]
    fn uses_access_management_not_all_as_the_superuser_signal() {
        // ClickHouse expands `GRANT ALL ON *.*` into one row per access type,
        // so `access_type = 'ALL'` never matches anything. Verified against
        // clickhouse-server 24.10: the `default` superuser has 22 global rows
        // and `ACCESS MANAGEMENT` is the only administrative one among them.
        assert!(PRINCIPALS_SQL.contains("'ACCESS MANAGEMENT'"));
        assert!(!PRINCIPALS_SQL.contains("access_type) = 'ALL'"));
    }

    #[test]
    fn detects_a_superuser_without_a_correlated_subquery() {
        // ClickHouse rejects correlated subqueries, so this must be a plain
        // `IN (SELECT …)` with no reference to the outer row.
        assert!(PRINCIPALS_SQL.contains("u.name IN ("));
        let inner_start = PRINCIPALS_SQL
            .find("SELECT user_name FROM system.grants")
            .unwrap();
        let inner = &PRINCIPALS_SQL[inner_start..];
        let inner_end = inner.find(')').unwrap();
        assert!(!inner[..inner_end].contains("u."));
    }

    #[test]
    fn escapes_a_quote_in_the_database_name() {
        assert!(grants_sql(Some("o'brien")).contains("`database` = 'o\\'brien'"));
    }
}

// ---------------------------------------------------------------------------
// Phase 2 — statement generation + sequential apply
// ---------------------------------------------------------------------------

/// The `ON …` target for a scope. ClickHouse has all three levels natively.
fn target_sql(scope: &Scope) -> String {
    match (&scope.schema, &scope.object) {
        (Some(schema), Some(object)) => qualified(schema, object),
        (Some(schema), None) => format!("{}.*", quote_ident(schema)),
        _ => "*.*".to_string(),
    }
}

/// The SQL one staged op implies.
///
/// **`Deny` and `Revoke` generate the same statement**, and that is correct
/// rather than a shortcut. ClickHouse has no `DENY`; its deny-equivalent is a
/// `REVOKE` on a scope narrower than an existing wildcard grant, which the
/// server records as a `is_partial_revoke` row — exactly the state Phase 1
/// reads back as [`PrivilegeState::Denied`]. So "deny SELECT on shop" and
/// "revoke SELECT on shop" are one operation whose *meaning* depends on
/// whether a broader grant exists, not two different statements.
fn op_statement(op: &GrantOp, reveal: bool) -> Result<String, AppError> {
    Ok(match op {
        GrantOp::Grant {
            grantee,
            privilege,
            scope,
            grantable,
        } => format!(
            "GRANT {privilege} ON {} TO {}{}",
            target_sql(scope),
            quote_ident(grantee),
            if *grantable { " WITH GRANT OPTION" } else { "" }
        ),
        GrantOp::Revoke {
            grantee,
            privilege,
            scope,
        }
        | GrantOp::Deny {
            grantee,
            privilege,
            scope,
        } => format!(
            "REVOKE {privilege} ON {} FROM {}",
            target_sql(scope),
            quote_ident(grantee)
        ),
        GrantOp::RevokeGrantOption {
            grantee,
            privilege,
            scope,
        } => format!(
            "REVOKE GRANT OPTION FOR {privilege} ON {} FROM {}",
            target_sql(scope),
            quote_ident(grantee)
        ),
        GrantOp::AddMember { member, role } => {
            format!("GRANT {} TO {}", quote_ident(role), quote_ident(member))
        }
        GrantOp::DropMember { member, role } => {
            format!("REVOKE {} FROM {}", quote_ident(role), quote_ident(member))
        }
        GrantOp::CreatePrincipal {
            name,
            principal_kind,
            password,
            ..
        } => {
            let ident = quote_ident(name);
            if *principal_kind == PrincipalKind::Role {
                format!("CREATE ROLE {ident}")
            } else {
                match password {
                    // `sha256_password`, not `plaintext_password`: ClickHouse
                    // hashes the value on receipt, so what lands in
                    // `system.users` is a digest rather than the password
                    // itself. The `BY` operand is still the plaintext in
                    // transit — masked in the shown statement either way.
                    Some(secret) => format!(
                        "CREATE USER {ident} IDENTIFIED WITH sha256_password BY {}",
                        secret_literal(secret, reveal)
                    ),
                    None => format!("CREATE USER {ident} NOT IDENTIFIED"),
                }
            }
        }
        GrantOp::DropPrincipal {
            name,
            principal_kind,
            ..
        } => format!(
            "DROP {} {}",
            if *principal_kind == PrincipalKind::Role {
                "ROLE"
            } else {
                "USER"
            },
            quote_ident(name)
        ),
    })
}

/// A password literal — the real one only when `reveal`, which is true solely
/// for the statement that is executed. See [`MASKED_SECRET`].
fn secret_literal(secret: &str, reveal: bool) -> String {
    super::sql::ch_string_literal(if reveal { secret } else { MASKED_SECRET })
}

/// Preview or apply a batch.
///
/// **Not atomic**: ClickHouse has no transactions for access-control
/// statements, so the batch runs in order and stops at the first failure, with
/// [`GrantCapabilities::atomic`] reporting `false`.
pub(super) async fn apply_grants(
    conn: &ClickhouseEngineConnection,
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

    for (i, statement) in executed.iter().enumerate() {
        if let Err(err) = conn.run_query(statement, QueryOptions::default()).await {
            return Err(AppError::Database(format!(
                "{err} ClickHouse has no transaction for access control, so the \
                 {i} statement(s) before this one are already in effect."
            )));
        }
    }

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

    #[test]
    fn renders_the_three_scope_levels() {
        assert_eq!(
            target_sql(&scope(Some("shop"), Some("orders"))),
            "`shop`.`orders`"
        );
        assert_eq!(target_sql(&scope(Some("shop"), None)), "`shop`.*");
        assert_eq!(target_sql(&scope(None, None)), "*.*");
    }

    #[test]
    fn a_deny_is_a_revoke_on_the_narrower_scope() {
        // ClickHouse's deny IS a partial revoke — same statement, and the
        // server records it as is_partial_revoke, which Phase 1 reads as denied.
        let deny = GrantOp::Deny {
            grantee: "app".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("system"), None),
        };
        let revoke = GrantOp::Revoke {
            grantee: "app".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("system"), None),
        };
        assert_eq!(
            op_statement(&deny, false).unwrap(),
            op_statement(&revoke, false).unwrap()
        );
        assert_eq!(
            op_statement(&deny, false).unwrap(),
            "REVOKE SELECT ON `system`.* FROM `app`"
        );
    }

    #[test]
    fn grants_with_and_without_the_grant_option() {
        let plain = GrantOp::Grant {
            grantee: "app".into(),
            privilege: "SELECT".into(),
            scope: scope(None, None),
            grantable: false,
        };
        assert_eq!(
            op_statement(&plain, false).unwrap(),
            "GRANT SELECT ON *.* TO `app`"
        );
        let grantable = GrantOp::Grant {
            grantee: "app".into(),
            privilege: "SELECT".into(),
            scope: scope(None, None),
            grantable: true,
        };
        assert!(op_statement(&grantable, false)
            .unwrap()
            .ends_with(" WITH GRANT OPTION"));
    }

    #[test]
    fn role_membership_uses_grant_role_to_member() {
        let op = GrantOp::AddMember {
            member: "app".into(),
            role: "writer".into(),
        };
        assert_eq!(op_statement(&op, false).unwrap(), "GRANT `writer` TO `app`");
    }

    #[test]
    fn a_backtick_in_a_name_cannot_break_out() {
        let op = GrantOp::AddMember {
            member: "ev`il".into(),
            role: "writer".into(),
        };
        assert!(op_statement(&op, false).unwrap().contains("`ev\\`il`"));
    }
    #[test]
    fn a_user_is_created_with_a_hashed_password_not_a_plaintext_one() {
        let op = GrantOp::CreatePrincipal {
            name: "app".into(),
            principal_kind: PrincipalKind::User,
            scope: crate::shared::privileges::PrincipalScope::Database,
            password: Some("hunter2".into()),
        };
        let sql = op_statement(&op, true).unwrap();
        assert!(
            sql.contains("IDENTIFIED WITH sha256_password BY"),
            "got {sql}"
        );
        assert!(!sql.contains("plaintext_password"));
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
    fn drops_the_grant_option_without_touching_the_privilege() {
        let op = GrantOp::RevokeGrantOption {
            grantee: "app".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("shop"), None),
        };
        assert_eq!(
            op_statement(&op, false).unwrap(),
            "REVOKE GRANT OPTION FOR SELECT ON `shop`.* FROM `app`"
        );
    }
}
