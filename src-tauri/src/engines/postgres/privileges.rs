//! Postgres privilege-catalog adapter (M39): `pg_roles` → principals,
//! `pg_auth_members` → memberships, and `aclexplode()` over `pg_class` /
//! `pg_namespace` → grants.
//!
//! Two traps this adapter exists to avoid:
//!
//! 1. **A NULL `relacl` is not an empty ACL.** It means *default* privileges,
//!    i.e. the owner holds everything and nobody else holds anything. Reading
//!    only `aclexplode(relacl)` would report that a freshly created table has
//!    no grants at all, which is exactly backwards for its owner. The second
//!    arm of the UNION synthesizes the owner's rows.
//! 2. **`grantee = 0` is `PUBLIC`**, the implicit everyone-role, and a grant to
//!    it is the usual answer to "why can every account read this?". It is named
//!    here and also listed as a synthetic principal so it is visible in its own
//!    right; `features::privileges::domain` spreads its grants to everyone.
//!
//! `information_schema.role_table_grants` would be a shorter query and is the
//! obvious choice, but it is filtered to the *current* role's enabled roles and
//! silently under-reports grants held by other accounts — unusable for an
//! audit view. `aclexplode` over the catalog sees everything the connection is
//! allowed to see.
//!
//! Phase 1 is object-level: column grants (`pg_attribute.attacl`), sequences,
//! functions and default ACLs (`pg_default_acl`) are not read.

use async_trait::async_trait;

use crate::shared::engine::{EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::privileges::{
    self, GrantPage, MembershipEdge, Principal, PrivilegeReader, PRIVILEGE_ROW_LIMIT,
};

use super::PostgresEngineConnection;

/// The fixed principal SELECT (see [`privileges::map_principal_rows`]): five
/// contract columns, then one aliased column per Attributes-pane row. Each flag
/// renders as `yes` or the empty string, because the mapper drops empty
/// attributes — so the pane lists what a role *can* do rather than a wall of
/// `false`.
///
/// `PUBLIC` is unioned in as a synthetic principal: it holds grants but has no
/// `pg_roles` row of its own.
const PRINCIPALS_SQL: &str = "SELECT \
    r.rolname, \
    CASE WHEN r.rolcanlogin THEN 'user' ELSE 'role' END, \
    'database', \
    r.rolcanlogin, \
    r.rolsuper, \
    CASE WHEN r.rolcreatedb THEN 'yes' ELSE '' END AS \"Create DB\", \
    CASE WHEN r.rolcreaterole THEN 'yes' ELSE '' END AS \"Create role\", \
    CASE WHEN r.rolreplication THEN 'yes' ELSE '' END AS \"Replication\", \
    CASE WHEN r.rolbypassrls THEN 'yes' ELSE '' END AS \"Bypass RLS\", \
    CASE WHEN r.rolinherit THEN 'yes' ELSE '' END AS \"Inherits\", \
    CASE WHEN r.rolconnlimit < 0 THEN '' ELSE r.rolconnlimit::text END AS \"Connection limit\", \
    coalesce(to_char(r.rolvaliduntil, 'YYYY-MM-DD HH24:MI'), '') AS \"Valid until\" \
    FROM pg_catalog.pg_roles r \
    UNION ALL \
    SELECT 'PUBLIC', 'role', 'database', false, false, '', '', '', '', '', '', '' \
    ORDER BY 4 DESC, 1";

/// The fixed membership SELECT: `member` belongs to `role`.
const MEMBERSHIPS_SQL: &str = "SELECT \
    m.rolname, \
    r.rolname, \
    a.admin_option \
    FROM pg_catalog.pg_auth_members a \
    JOIN pg_catalog.pg_roles m ON m.oid = a.member \
    JOIN pg_catalog.pg_roles r ON r.oid = a.roleid";

/// The privileges a table owner implicitly holds when `relacl IS NULL`.
const OWNER_PRIVILEGES: &str =
    "('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')";

/// Relation kinds the matrix covers: ordinary, view, materialized view,
/// partitioned and foreign tables.
const RELKINDS: &str = "'r','v','m','p','f'";

#[async_trait]
impl PrivilegeReader for PostgresEngineConnection {
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

/// Catalog reads need far more than the 500-row browse default — a real grant
/// list runs to thousands of rows and a silent cut would understate access.
fn catalog_options() -> QueryOptions {
    QueryOptions {
        row_limit: PRIVILEGE_ROW_LIMIT,
        schema: None,
    }
}

/// The three-arm grant SELECT: explicit relation ACLs, synthesized owner rows
/// for relations whose ACL is still NULL, and schema-level ACLs (which carry
/// `USAGE` / `CREATE`, so they never collide with table privileges in the
/// matrix).
fn grants_sql(schema: Option<&str>) -> String {
    let scope = schema_predicate(schema);
    let grantee = "CASE WHEN a.grantee = 0 THEN 'PUBLIC' \
                   ELSE pg_catalog.pg_get_userbyid(a.grantee) END";
    let state = "CASE WHEN a.is_grantable THEN 'grantable' ELSE 'granted' END";

    format!(
        "SELECT {grantee}, n.nspname, c.relname, a.privilege_type, {state} \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a \
         WHERE c.relkind IN ({RELKINDS}) AND {scope} \
         UNION ALL \
         SELECT pg_catalog.pg_get_userbyid(c.relowner), n.nspname, c.relname, p.priv, 'grantable' \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         CROSS JOIN (VALUES {OWNER_PRIVILEGES}) AS p(priv) \
         WHERE c.relkind IN ({RELKINDS}) AND c.relacl IS NULL AND {scope} \
         UNION ALL \
         SELECT {grantee}, n.nspname, '', a.privilege_type, {state} \
         FROM pg_catalog.pg_namespace n \
         CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a \
         WHERE {scope}"
    )
}

/// Restrict to one schema, or — with no schema selected — to the user-visible
/// ones, so the listing never fills up with `pg_catalog` internals.
fn schema_predicate(schema: Option<&str>) -> String {
    match schema {
        Some(name) => format!("n.nspname = {}", literal(name)),
        None => "n.nspname NOT IN ('pg_catalog', 'information_schema') \
                 AND n.nspname NOT LIKE 'pg\\_toast%' \
                 AND n.nspname NOT LIKE 'pg\\_temp%'"
            .to_string(),
    }
}

/// A single-quoted Postgres string literal with embedded quotes doubled. The
/// schema name comes from the schema switcher (a name the catalog gave us), but
/// it still becomes SQL text here, so it is escaped like any other operand.
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_the_grant_query_to_one_schema() {
        let sql = grants_sql(Some("shop"));
        assert!(sql.contains("n.nspname = 'shop'"));
        assert!(!sql.contains("information_schema"));
    }

    #[test]
    fn hides_system_schemas_when_nothing_is_selected() {
        let sql = grants_sql(None);
        assert!(sql.contains("NOT IN ('pg_catalog', 'information_schema')"));
    }

    #[test]
    fn synthesizes_owner_rows_for_relations_with_a_null_acl() {
        // The trap this adapter exists for: without this arm a freshly created
        // table reports no grants at all, including to its own owner.
        let sql = grants_sql(Some("public"));
        assert!(sql.contains("c.relacl IS NULL"));
        assert!(sql.contains("pg_get_userbyid(c.relowner)"));
    }

    #[test]
    fn names_the_public_pseudo_role_in_both_queries() {
        assert!(grants_sql(None).contains("a.grantee = 0 THEN 'PUBLIC'"));
        assert!(PRINCIPALS_SQL.contains("SELECT 'PUBLIC', 'role'"));
    }

    #[test]
    fn escapes_a_quote_in_the_schema_name() {
        assert_eq!(literal("o'brien"), "'o''brien'");
        assert!(grants_sql(Some("o'brien")).contains("n.nspname = 'o''brien'"));
    }
}
