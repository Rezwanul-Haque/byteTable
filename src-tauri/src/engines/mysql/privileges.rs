//! MySQL privilege-catalog adapter (M39): `mysql.user` → principals,
//! `mysql.role_edges` → memberships, and the `information_schema`
//! `*_PRIVILEGES` views → grants.
//!
//! Principals are named `user@host` (unquoted), because MySQL's account
//! identity is the pair, not the username — `app@10.0.0.%` and `app@localhost`
//! are different accounts with different grants. The `GRANTEE` column reports
//! the same pair as `'user'@'host'`, so stripping its quotes makes the two
//! sides join without further parsing.
//!
//! **Roles are not flagged in the catalog.** MySQL 8 implements a role as an
//! ordinary account, and there is no `is_role` column (MariaDB has one; MySQL
//! does not). The best available signal is appearing in `mysql.role_edges`, so
//! that is what this uses. MySQL 5.7 has no roles at all and no `role_edges`
//! table — the role-aware queries fail there, so both fall back rather than
//! turning a supported version into an error.
//!
//! Phase 1 is object-level: `information_schema.COLUMN_PRIVILEGES` is not read.

use async_trait::async_trait;

use crate::features::privileges::domain::ops::{self, GrantOp, Scope, MASKED_SECRET};
use crate::shared::engine::{AlterResult, EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::privileges::{
    self, GrantCapabilities, GrantPage, MembershipEdge, Principal, PrincipalKind, PrivilegeReader,
    PRIVILEGE_ROW_LIMIT,
};

use super::sql::{qualified, quote_ident};
use super::MysqlEngineConnection;

/// The fixed principal SELECT for MySQL 8, where `mysql.role_edges` exists and
/// tells accounts and roles apart. `Super_priv` is the superuser signal and is
/// present in both 5.7 and 8.0.
const PRINCIPALS_SQL: &str = "SELECT \
    CONCAT(u.User, '@', u.Host), \
    CASE WHEN e.FROM_USER IS NOT NULL THEN 'role' ELSE 'user' END, \
    'database', \
    (u.account_locked = 'N'), \
    (u.Super_priv = 'Y'), \
    u.account_locked AS `Locked`, \
    u.password_expired AS `Password expired`, \
    u.plugin AS `Auth plugin` \
    FROM mysql.user u \
    LEFT JOIN (SELECT DISTINCT FROM_USER, FROM_HOST FROM mysql.role_edges) e \
      ON e.FROM_USER = u.User AND e.FROM_HOST = u.Host \
    ORDER BY 2, 1";

/// The same SELECT for MySQL 5.7, which has no roles: every account is a user.
const PRINCIPALS_SQL_NO_ROLES: &str = "SELECT \
    CONCAT(u.User, '@', u.Host), \
    'user', \
    'database', \
    (u.account_locked = 'N'), \
    (u.Super_priv = 'Y'), \
    u.account_locked AS `Locked`, \
    u.password_expired AS `Password expired`, \
    u.plugin AS `Auth plugin` \
    FROM mysql.user u \
    ORDER BY 1";

/// `FROM_*` is the role being granted, `TO_*` the account receiving it — so the
/// member is the `TO` side. Getting this backwards would invert every
/// inheritance chain.
const MEMBERSHIPS_SQL: &str = "SELECT \
    CONCAT(e.TO_USER, '@', e.TO_HOST), \
    CONCAT(e.FROM_USER, '@', e.FROM_HOST), \
    (e.WITH_ADMIN_OPTION = 'Y') \
    FROM mysql.role_edges e";

#[async_trait]
impl PrivilegeReader for MysqlEngineConnection {
    async fn list_principals(&self) -> Result<Vec<Principal>, AppError> {
        // 5.7 has no `mysql.role_edges`; fall back rather than fail. Any error
        // from the role-aware form retries the plain one, and only that second
        // failure surfaces — a genuine permission problem still reports.
        let result = match self.run_query(PRINCIPALS_SQL, catalog_options()).await {
            Ok(result) => result,
            Err(_) => {
                self.run_query(PRINCIPALS_SQL_NO_ROLES, catalog_options())
                    .await?
            }
        };
        Ok(privileges::map_principal_rows(result))
    }

    async fn list_memberships(&self) -> Result<Vec<MembershipEdge>, AppError> {
        // No roles on this server is an empty list, not an error.
        match self.run_query(MEMBERSHIPS_SQL, catalog_options()).await {
            Ok(result) => Ok(privileges::map_membership_rows(result)),
            Err(_) => Ok(Vec::new()),
        }
    }

    async fn list_grants(&self, schema: Option<&str>) -> Result<GrantPage, AppError> {
        let result = self
            .run_query(&grants_sql(schema), catalog_options())
            .await?;
        Ok(privileges::map_grant_rows(result))
    }

    fn grant_capabilities(&self) -> GrantCapabilities {
        // No DENY; GRANT/REVOKE force an implicit commit so a batch can never
        // be rolled back; and a narrower REVOKE is error 1147, not a no-op.
        GrantCapabilities {
            can_deny: false,
            atomic: false,
            can_narrow_wildcard: false,
        }
    }

    async fn current_principal(&self) -> Result<String, AppError> {
        // CURRENT_USER() already returns `user@host` — the same spelling
        // Principal::name uses, so no normalising needed.
        let result = self
            .run_query("SELECT CURRENT_USER()", QueryOptions::default())
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

/// Table, schema and global grants in one listing. The global arm is never
/// scoped — a global `GRANT … ON *.*` applies to the selected schema too, and
/// dropping it would understate access.
fn grants_sql(schema: Option<&str>) -> String {
    let scope = schema_predicate(schema);
    // `GRANTEE` is `'user'@'host'`; the principal queries build `user@host`.
    let grantee = "REPLACE(GRANTEE, '''', '')";
    let state = "CASE WHEN IS_GRANTABLE = 'YES' THEN 'grantable' ELSE 'granted' END";

    format!(
        "SELECT {grantee}, TABLE_SCHEMA, TABLE_NAME, PRIVILEGE_TYPE, {state} \
         FROM information_schema.TABLE_PRIVILEGES WHERE {scope} \
         UNION ALL \
         SELECT {grantee}, TABLE_SCHEMA, '', PRIVILEGE_TYPE, {state} \
         FROM information_schema.SCHEMA_PRIVILEGES WHERE {scope} \
         UNION ALL \
         SELECT {grantee}, '', '', PRIVILEGE_TYPE, {state} \
         FROM information_schema.USER_PRIVILEGES"
    )
}

/// Restrict to one schema, or — with none selected — hide the server's own
/// databases so the listing is the user's data, not MySQL's internals.
fn schema_predicate(schema: Option<&str>) -> String {
    match schema {
        Some(name) => format!("TABLE_SCHEMA = {}", literal(name)),
        None => "TABLE_SCHEMA NOT IN \
                 ('mysql', 'information_schema', 'performance_schema', 'sys')"
            .to_string(),
    }
}

/// A single-quoted MySQL string literal. Backslashes are escaped as well as
/// quotes: unlike Postgres, MySQL honours C-style backslash escapes by default,
/// so doubling quotes alone would not be enough.
fn literal(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('\'', "''");
    format!("'{escaped}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_table_and_schema_grants_but_never_global_ones() {
        let sql = grants_sql(Some("shop"));
        assert_eq!(sql.matches("TABLE_SCHEMA = 'shop'").count(), 2);
        // A global grant applies to the selected schema too.
        assert!(sql.contains("FROM information_schema.USER_PRIVILEGES"));
        assert!(!sql.contains("USER_PRIVILEGES WHERE"));
    }

    #[test]
    fn hides_server_internal_databases_when_nothing_is_selected() {
        assert!(grants_sql(None).contains("'mysql', 'information_schema'"));
    }

    #[test]
    fn strips_the_quotes_mysql_wraps_around_a_grantee() {
        // GRANTEE is `'app'@'%'`; principals are `app@%`. They must match.
        assert!(grants_sql(None).contains("REPLACE(GRANTEE, '''', '')"));
        assert!(PRINCIPALS_SQL.contains("CONCAT(u.User, '@', u.Host)"));
    }

    #[test]
    fn membership_edges_read_from_the_to_side_as_the_member() {
        let member_first = MEMBERSHIPS_SQL.find("TO_USER").expect("member column");
        let role_second = MEMBERSHIPS_SQL.find("FROM_USER, '@'").expect("role column");
        assert!(member_first < role_second);
    }

    #[test]
    fn escapes_backslashes_as_well_as_quotes() {
        assert_eq!(literal("o'brien"), "'o''brien'");
        assert_eq!(literal("back\\slash"), "'back\\\\slash'");
    }
}

// ---------------------------------------------------------------------------
// Phase 2 — statement generation + sequential apply
// ---------------------------------------------------------------------------

/// Render a grantee as MySQL's account syntax: **two string literals**, not an
/// identifier.
///
/// This is the trap. `quote_ident` would produce `` `app@%` `` — a single
/// backtick-quoted name containing an `@`, which is a different (nonexistent)
/// account. MySQL wants `'app'@'%'`, so the `user@host` name Phase 1 normalises
/// has to be split at the LAST `@` (a username may legally contain one) and
/// each half quoted as a literal. A name with no `@` gets the `%` wildcard host,
/// matching how MySQL itself expands a bare `CREATE USER foo`.
fn grantee_sql(name: &str) -> String {
    let (user, host) = match name.rsplit_once('@') {
        Some((user, host)) => (user, host),
        None => (name, "%"),
    };
    format!("{}@{}", literal(user), literal(host))
}

/// The `ON …` target for a scope. MySQL has all three levels natively.
fn target_sql(scope: &Scope) -> String {
    match (&scope.schema, &scope.object) {
        (Some(schema), Some(object)) => qualified(schema, object),
        (Some(schema), None) => format!("{}.*", quote_ident(schema)),
        _ => "*.*".to_string(),
    }
}

/// The SQL one staged op implies.
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
            grantee_sql(grantee),
            if *grantable { " WITH GRANT OPTION" } else { "" }
        ),
        GrantOp::Revoke {
            grantee,
            privilege,
            scope,
        } => format!(
            "REVOKE {privilege} ON {} FROM {}",
            target_sql(scope),
            grantee_sql(grantee)
        ),
        GrantOp::Deny { .. } => {
            return Err(AppError::Invalid(
                "MySQL has no DENY — a privilege is either granted or it is not. \
                 Revoke it instead."
                    .into(),
            ))
        }
        // MySQL's form names no privilege: `GRANT OPTION` is a single bit per
        // scope, so this drops it for EVERY privilege on that table/database,
        // not just `privilege`. Verified on mysql:8 — `REVOKE SELECT` followed
        // by `GRANT SELECT` leaves IS_GRANTABLE='YES', and only this statement
        // clears it.
        GrantOp::RevokeGrantOption { grantee, scope, .. } => format!(
            "REVOKE GRANT OPTION ON {} FROM {}",
            target_sql(scope),
            grantee_sql(grantee)
        ),
        GrantOp::AddMember { member, role } => {
            format!("GRANT {} TO {}", grantee_sql(role), grantee_sql(member))
        }
        GrantOp::DropMember { member, role } => {
            format!("REVOKE {} FROM {}", grantee_sql(role), grantee_sql(member))
        }
        // MySQL 8 roles are accounts, so both are CREATE/DROP on an account —
        // but the ROLE forms exist and read better in the preview.
        GrantOp::CreatePrincipal {
            name,
            principal_kind,
            password,
            ..
        } => {
            if *principal_kind == PrincipalKind::Role {
                format!("CREATE ROLE {}", grantee_sql(name))
            } else {
                let mut sql = format!("CREATE USER {}", grantee_sql(name));
                if let Some(secret) = password {
                    sql.push_str(&format!(
                        " IDENTIFIED BY {}",
                        secret_literal(secret, reveal)
                    ));
                }
                sql
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
            grantee_sql(name)
        ),
    })
}

/// A password literal — the real one only when `reveal`, which is true solely
/// for the statement that is executed. See [`MASKED_SECRET`].
fn secret_literal(secret: &str, reveal: bool) -> String {
    literal(if reveal { secret } else { MASKED_SECRET })
}

/// Preview or apply a batch.
///
/// **Not atomic, and it cannot be made so.** MySQL's `GRANT`/`REVOKE` force an
/// implicit commit, so wrapping the batch in a transaction would be theatre: a
/// failure halfway leaves the earlier statements applied. The batch therefore
/// runs in order and stops at the first failure, and
/// [`GrantCapabilities::atomic`] reports `false` so the renderer can say so
/// before the user commits to it.
pub(super) async fn apply_grants(
    conn: &MysqlEngineConnection,
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
            // Say how far it got — with no rollback available, "it failed" on
            // its own would leave the user guessing what is now true.
            let mut message = format!(
                "{err} MySQL applies each GRANT/REVOKE immediately, so the {i} \
                 statement(s) before this one are already in effect."
            );
            // Error 1147. The renderer blocks this edit up front via
            // `can_narrow_wildcard`, so reaching here means something else
            // narrowed the grant underneath us — explain rather than leave the
            // raw message, which does not hint at why the revoke was refused.
            if err.to_string().to_lowercase().contains("no such grant") {
                message.push_str(
                    " MySQL can only revoke a privilege at the exact scope it \
                     was granted: this account holds it through a broader grant \
                     (a whole database, or *.*), which has to be narrowed there \
                     instead.",
                );
            }
            return Err(AppError::Database(message));
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
    fn a_grantee_is_two_literals_not_an_identifier() {
        // The trap: `app@%` must become 'app'@'%', never `app@%`.
        assert_eq!(grantee_sql("app@%"), "'app'@'%'");
        assert_eq!(grantee_sql("app@localhost"), "'app'@'localhost'");
    }

    #[test]
    fn a_bare_name_gets_the_wildcard_host() {
        assert_eq!(grantee_sql("app"), "'app'@'%'");
    }

    #[test]
    fn splits_at_the_last_at_sign() {
        // A username may legally contain '@'; the host is what follows the last.
        assert_eq!(grantee_sql("a@b@localhost"), "'a@b'@'localhost'");
    }

    #[test]
    fn a_quote_in_an_account_name_cannot_break_out() {
        assert_eq!(grantee_sql("o'brien@%"), "'o''brien'@'%'");
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
    fn grants_and_revokes_read_as_mysql_expects() {
        let grant = GrantOp::Grant {
            grantee: "app@%".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("shop"), None),
            grantable: true,
        };
        assert_eq!(
            op_statement(&grant, false).unwrap(),
            "GRANT SELECT ON `shop`.* TO 'app'@'%' WITH GRANT OPTION"
        );
        let revoke = GrantOp::Revoke {
            grantee: "app@%".into(),
            privilege: "INSERT".into(),
            scope: scope(Some("shop"), Some("orders")),
        };
        assert_eq!(
            op_statement(&revoke, false).unwrap(),
            "REVOKE INSERT ON `shop`.`orders` FROM 'app'@'%'"
        );
    }

    #[test]
    fn role_membership_uses_account_syntax_on_both_sides() {
        let op = GrantOp::AddMember {
            member: "app@%".into(),
            role: "writer@%".into(),
        };
        assert_eq!(
            op_statement(&op, false).unwrap(),
            "GRANT 'writer'@'%' TO 'app'@'%'"
        );
    }

    #[test]
    fn deny_is_refused_with_an_explanation() {
        let op = GrantOp::Deny {
            grantee: "app@%".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("shop"), None),
        };
        assert!(op_statement(&op, false)
            .unwrap_err()
            .to_string()
            .contains("no DENY"));
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
    fn drops_the_grant_option_with_mysqls_privilege_less_form() {
        // Verified on mysql:8: REVOKE SELECT + GRANT SELECT leaves
        // IS_GRANTABLE='YES'; only this statement clears the bit. It names no
        // privilege because MySQL stores one GRANT OPTION bit per scope.
        let op = GrantOp::RevokeGrantOption {
            grantee: "app@%".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("shop"), Some("orders")),
        };
        let sql = op_statement(&op, false).unwrap();
        assert_eq!(sql, "REVOKE GRANT OPTION ON `shop`.`orders` FROM 'app'@'%'");
        assert!(!sql.contains("SELECT"), "MySQL names no privilege here");
    }
}
