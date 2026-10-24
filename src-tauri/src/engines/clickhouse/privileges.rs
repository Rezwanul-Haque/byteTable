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

use crate::shared::engine::{EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::privileges::{
    self, GrantPage, MembershipEdge, Principal, PrivilegeReader, PRIVILEGE_ROW_LIMIT,
};

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
