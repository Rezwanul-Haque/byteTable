//! Oracle schema objects: views, materialized views, functions, procedures, and
//! triggers, from the `ALL_*` catalog + `DBMS_METADATA.GET_DDL`. Mirrors the
//! object-browser side of the `EngineConnection` contract. Blocking; `super`
//! (`mod.rs`) hops these onto the blocking pool. Gated behind `engine-oracle`.

use oracle::Connection;

use crate::shared::engine::{DbObjectDefinition, DbObjectInfo, DbObjectKind};
use crate::shared::error::AppError;

use super::error::map_ora_query_err;
use super::sql::qualified;

/// Object kinds Oracle exposes (drives sidebar gating) — the full relational set,
/// with real materialized views.
pub(super) const KINDS: &[DbObjectKind] = &[
    DbObjectKind::View,
    DbObjectKind::MaterializedView,
    DbObjectKind::Function,
    DbObjectKind::Procedure,
    DbObjectKind::Trigger,
];

/// Objects of `kind` owned by `owner`. Triggers carry the owning table as
/// `detail`; the other kinds carry none.
pub(super) fn list(
    c: &Connection,
    owner: &str,
    kind: DbObjectKind,
) -> Result<Vec<DbObjectInfo>, AppError> {
    let (sql, is_trigger) = match kind {
        DbObjectKind::View => (
            "SELECT view_name AS name, NULL AS detail FROM all_views \
             WHERE owner = :1 ORDER BY view_name",
            false,
        ),
        DbObjectKind::MaterializedView => (
            "SELECT mview_name AS name, NULL AS detail FROM all_mviews \
             WHERE owner = :1 ORDER BY mview_name",
            false,
        ),
        DbObjectKind::Function => (
            "SELECT object_name AS name, NULL AS detail FROM all_objects \
             WHERE owner = :1 AND object_type = 'FUNCTION' ORDER BY object_name",
            false,
        ),
        DbObjectKind::Procedure => (
            "SELECT object_name AS name, NULL AS detail FROM all_objects \
             WHERE owner = :1 AND object_type = 'PROCEDURE' ORDER BY object_name",
            false,
        ),
        DbObjectKind::Trigger => (
            "SELECT trigger_name AS name, table_name AS detail FROM all_triggers \
             WHERE owner = :1 ORDER BY trigger_name",
            true,
        ),
    };
    let mut out = Vec::new();
    for row in c.query(sql, &[&owner]).map_err(map_ora_query_err)? {
        let row = row.map_err(map_ora_query_err)?;
        let name: String = row.get(0).map_err(map_ora_query_err)?;
        let detail: Option<String> = if is_trigger {
            row.get(1).map_err(map_ora_query_err)?
        } else {
            None
        };
        out.push(DbObjectInfo {
            name,
            kind,
            detail,
            owner: Some(owner.to_string()),
            modified: None,
            returns: None,
            language: None,
            volatility: None,
            arg_count: None,
            table: None,
            timing: None,
            events: Vec::new(),
            enabled: None,
            approx_rows: None,
            size: None,
            depends_on: Vec::new(),
        });
    }
    Ok(out)
}

/// The full `CREATE …` DDL for one object via `DBMS_METADATA.GET_DDL`.
pub(super) fn definition(
    c: &Connection,
    owner: &str,
    kind: DbObjectKind,
    name: &str,
) -> Result<DbObjectDefinition, AppError> {
    // The DBMS_METADATA object-type keyword differs per kind.
    let object_type = match kind {
        DbObjectKind::View => "VIEW",
        DbObjectKind::MaterializedView => "MATERIALIZED_VIEW",
        DbObjectKind::Function => "FUNCTION",
        DbObjectKind::Procedure => "PROCEDURE",
        DbObjectKind::Trigger => "TRIGGER",
    };
    let ddl: String = c
        .query_row_as::<Option<String>>(
            "SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM dual",
            &[&object_type, &name, &owner],
        )
        .map_err(map_ora_query_err)?
        .unwrap_or_default()
        .trim()
        .to_string();

    Ok(DbObjectDefinition {
        name: name.to_string(),
        kind,
        ddl,
        comment: None,
        returns: None,
        language: None,
        volatility: None,
        args: Vec::new(),
        table: None,
        timing: None,
        events: Vec::new(),
        level: None,
        enabled: None,
        populated: None,
        approx_rows: None,
        size: None,
        depends_on: Vec::new(),
    })
}

/// A precise `DROP …` statement for one object (schema-qualified). Pure — no I/O;
/// the command layer runs the returned SQL.
pub(super) fn drop_sql(schema: &str, kind: DbObjectKind, name: &str) -> String {
    let object = qualified(schema, name);
    match kind {
        DbObjectKind::View => format!("DROP VIEW {object}"),
        DbObjectKind::MaterializedView => format!("DROP MATERIALIZED VIEW {object}"),
        DbObjectKind::Function => format!("DROP FUNCTION {object}"),
        DbObjectKind::Procedure => format!("DROP PROCEDURE {object}"),
        DbObjectKind::Trigger => format!("DROP TRIGGER {object}"),
    }
}
