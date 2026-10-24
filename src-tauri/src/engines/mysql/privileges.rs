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

use crate::shared::engine::{EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::privileges::{
    self, GrantPage, MembershipEdge, Principal, PrivilegeReader, PRIVILEGE_ROW_LIMIT,
};

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
