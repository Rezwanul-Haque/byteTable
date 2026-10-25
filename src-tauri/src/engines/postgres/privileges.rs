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

use crate::features::privileges::domain::ops::{self, GrantOp, Scope, MASKED_SECRET};
use crate::shared::engine::{AlterResult, EngineConnection, QueryOptions};
use crate::shared::error::AppError;
use crate::shared::privileges::{
    self, GrantCapabilities, GrantPage, MembershipEdge, Principal, PrincipalKind, PrivilegeReader,
    PRIVILEGE_ROW_LIMIT,
};

use super::error::map_query_error;
use super::sql::{qualified, quote_ident};
use super::PostgresEngineConnection;

/// Postgres' implicit everyone-role. A keyword in GRANT syntax, never quoted.
const PUBLIC_ROLE: &str = "PUBLIC";

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

    fn grant_capabilities(&self) -> GrantCapabilities {
        // No DENY in the model at all; DCL is fully transactional, and a
        // revoke on a narrower scope is a harmless no-op.
        GrantCapabilities {
            can_deny: false,
            atomic: true,
            can_narrow_wildcard: true,
        }
    }

    async fn current_principal(&self) -> Result<String, AppError> {
        let result = self
            .run_query("SELECT current_user", QueryOptions::default())
            .await?;
        Ok(privileges::first_cell(&result))
    }

    async fn apply_grants(&self, ops: &[GrantOp], apply: bool) -> Result<AlterResult, AppError> {
        apply_grants(&self.pool, ops, apply).await
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

// ---------------------------------------------------------------------------
// Phase 2 — statement generation + transactional apply
// ---------------------------------------------------------------------------

/// Render a grantee for a Postgres `GRANT`/`REVOKE`.
///
/// `PUBLIC` is a **keyword**, not an identifier: quoting it would name a role
/// literally called `"PUBLIC"`, which is a different (and almost certainly
/// nonexistent) object. Everything else is a quoted identifier.
fn grantee_sql(name: &str) -> String {
    if name.eq_ignore_ascii_case(PUBLIC_ROLE) {
        PUBLIC_ROLE.to_string()
    } else {
        quote_ident(name)
    }
}

/// The `ON …` target for a scope.
///
/// Postgres has no instance-wide table grant, so an empty scope is a §5 error
/// rather than an invented statement — `GRANT … ON ALL TABLES` needs a schema.
fn target_sql(scope: &Scope) -> Result<String, AppError> {
    match (&scope.schema, &scope.object) {
        (Some(schema), Some(object)) => Ok(format!("TABLE {}", qualified(schema, object))),
        (Some(schema), None) => Ok(format!("ALL TABLES IN SCHEMA {}", quote_ident(schema))),
        _ => Err(AppError::Invalid(
            "Postgres has no instance-wide table privilege — choose a schema or \
             a table for this change."
                .into(),
        )),
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
            target_sql(scope)?,
            grantee_sql(grantee),
            if *grantable { " WITH GRANT OPTION" } else { "" }
        ),
        GrantOp::Revoke {
            grantee,
            privilege,
            scope,
        } => format!(
            "REVOKE {privilege} ON {} FROM {}",
            target_sql(scope)?,
            grantee_sql(grantee)
        ),
        GrantOp::Deny { .. } => {
            return Err(AppError::Invalid(
                "Postgres has no DENY — a privilege is either granted or it is \
                 not. Revoke it instead."
                    .into(),
            ))
        }
        GrantOp::RevokeGrantOption {
            grantee,
            privilege,
            scope,
        } => format!(
            "REVOKE GRANT OPTION FOR {privilege} ON {} FROM {}",
            target_sql(scope)?,
            grantee_sql(grantee)
        ),
        GrantOp::AddMember { member, role } => {
            format!("GRANT {} TO {}", quote_ident(role), quote_ident(member))
        }
        GrantOp::DropMember { member, role } => {
            format!("REVOKE {} FROM {}", quote_ident(role), quote_ident(member))
        }
        // Postgres has one principal space: a "user" is a role that may log in.
        GrantOp::CreatePrincipal {
            name,
            principal_kind,
            password,
            ..
        } => {
            let mut sql = format!("CREATE ROLE {}", quote_ident(name));
            if *principal_kind != PrincipalKind::Role {
                sql.push_str(" LOGIN");
            }
            if let Some(secret) = password {
                sql.push_str(&format!(" PASSWORD {}", secret_literal(secret, reveal)));
            }
            sql
        }
        GrantOp::DropPrincipal { name, .. } => format!("DROP ROLE {}", quote_ident(name)),
    })
}

/// A password literal — the real one only when `reveal`, which is true solely
/// for the statement that is executed. See [`MASKED_SECRET`].
fn secret_literal(secret: &str, reveal: bool) -> String {
    if reveal {
        literal(secret)
    } else {
        literal(MASKED_SECRET)
    }
}

/// Preview or apply a batch. Preview is pure; apply runs every statement in one
/// transaction and rolls back on the first failure (Postgres DCL is
/// transactional, so the M8 all-or-nothing contract holds here unchanged).
pub(super) async fn apply_grants(
    pool: &sqlx::postgres::PgPool,
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

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    for statement in &executed {
        if let Err(err) = sqlx::query(statement).execute(&mut *tx).await {
            let _ = tx.rollback().await;
            return Err(map_query_error(err));
        }
    }
    tx.commit().await.map_err(map_query_error)?;

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
    fn grants_on_one_table() {
        let op = GrantOp::Grant {
            grantee: "app_rw".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("shop"), Some("orders")),
            grantable: false,
        };
        assert_eq!(
            op_statement(&op, false).unwrap(),
            "GRANT SELECT ON TABLE \"shop\".\"orders\" TO \"app_rw\""
        );
    }

    #[test]
    fn grantable_adds_the_grant_option() {
        let op = GrantOp::Grant {
            grantee: "app_rw".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("shop"), Some("orders")),
            grantable: true,
        };
        assert!(op_statement(&op, false)
            .unwrap()
            .ends_with(" WITH GRANT OPTION"));
    }

    #[test]
    fn public_is_a_keyword_and_must_not_be_quoted() {
        // Quoting it would target a role literally named "PUBLIC".
        let op = GrantOp::Grant {
            grantee: "PUBLIC".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("shop"), Some("orders")),
            grantable: false,
        };
        assert!(op_statement(&op, false).unwrap().ends_with("TO PUBLIC"));
        assert_eq!(grantee_sql("public"), "PUBLIC");
    }

    #[test]
    fn a_schema_scope_becomes_all_tables_in_schema() {
        let op = GrantOp::Revoke {
            grantee: "app_rw".into(),
            privilege: "INSERT".into(),
            scope: scope(Some("shop"), None),
        };
        assert_eq!(
            op_statement(&op, false).unwrap(),
            "REVOKE INSERT ON ALL TABLES IN SCHEMA \"shop\" FROM \"app_rw\""
        );
    }

    #[test]
    fn an_empty_scope_is_refused_rather_than_invented() {
        let op = GrantOp::Grant {
            grantee: "app_rw".into(),
            privilege: "SELECT".into(),
            scope: scope(None, None),
            grantable: false,
        };
        assert!(op_statement(&op, false).is_err());
    }

    #[test]
    fn deny_is_refused_with_an_explanation() {
        let op = GrantOp::Deny {
            grantee: "app_rw".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("shop"), Some("orders")),
        };
        let err = op_statement(&op, false).unwrap_err().to_string();
        assert!(err.contains("no DENY"), "got {err}");
    }

    #[test]
    fn role_membership_uses_grant_role_to_member() {
        let add = GrantOp::AddMember {
            member: "app_rw".into(),
            role: "writer".into(),
        };
        assert_eq!(
            op_statement(&add, false).unwrap(),
            "GRANT \"writer\" TO \"app_rw\""
        );
        let drop = GrantOp::DropMember {
            member: "app_rw".into(),
            role: "writer".into(),
        };
        assert_eq!(
            op_statement(&drop, false).unwrap(),
            "REVOKE \"writer\" FROM \"app_rw\""
        );
    }

    #[test]
    fn identifiers_with_quotes_cannot_break_out() {
        let op = GrantOp::Grant {
            grantee: "ev\"il".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("s"), Some("t")),
            grantable: false,
        };
        assert!(op_statement(&op, false).unwrap().contains("\"ev\"\"il\""));
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
            grantee: "app_rw".into(),
            privilege: "SELECT".into(),
            scope: scope(Some("shop"), Some("orders")),
        };
        assert_eq!(
            op_statement(&op, false).unwrap(),
            "REVOKE GRANT OPTION FOR SELECT ON TABLE \"shop\".\"orders\" FROM \"app_rw\""
        );
    }
}
