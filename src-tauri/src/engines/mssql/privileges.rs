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

use crate::shared::engine::{EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::privileges::{
    self, GrantPage, MembershipEdge, Principal, PrivilegeReader, PRIVILEGE_ROW_LIMIT,
};

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
