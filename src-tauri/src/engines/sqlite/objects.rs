//! SQLite schema-object introspection + DDL builders. SQLite has only views
//! and triggers (no materialized views, functions, or procedures). The object
//! catalog is `<schema>.sqlite_schema`, whose `sql` column already holds the
//! verbatim `CREATE …` DDL — so the definition is read directly, no builtin
//! needed. `drop_sql` is pure (unit-tested). Blocking (rusqlite is sync).

use rusqlite::Connection;

use crate::shared::engine::{DbObjectDefinition, DbObjectInfo, DbObjectKind};
use crate::shared::error::AppError;

use super::{map_query_error, quote_ident};

/// Kinds SQLite exposes.
pub(super) const KINDS: &[DbObjectKind] = &[DbObjectKind::View, DbObjectKind::Trigger];

fn unsupported() -> AppError {
    AppError::Unsupported("SQLite does not support that object kind.".into())
}

/// The `sqlite_schema.type` string for a supported kind.
fn type_str(kind: DbObjectKind) -> Result<&'static str, AppError> {
    match kind {
        DbObjectKind::View => Ok("view"),
        DbObjectKind::Trigger => Ok("trigger"),
        _ => Err(unsupported()),
    }
}

pub(super) fn list_blocking(
    conn: &Connection,
    schema: &str,
    kind: DbObjectKind,
) -> Result<Vec<DbObjectInfo>, AppError> {
    let ty = type_str(kind)?;
    // Triggers carry their owning table (tbl_name); views do not.
    let sql = format!(
        "SELECT name, tbl_name FROM {}.sqlite_schema WHERE type = ?1 ORDER BY name",
        quote_ident(schema)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| map_query_error(conn, e))?;
    let rows = stmt
        .query_map([ty], |row| {
            let name: String = row.get(0)?;
            let tbl: String = row.get(1)?;
            Ok((name, tbl))
        })
        .map_err(|e| map_query_error(conn, e))?;
    let mut out = Vec::new();
    for r in rows {
        let (name, tbl) = r.map_err(|e| map_query_error(conn, e))?;
        out.push(DbObjectInfo {
            name,
            kind,
            detail: if matches!(kind, DbObjectKind::Trigger) {
                Some(tbl)
            } else {
                None
            },
        });
    }
    Ok(out)
}

pub(super) fn definition_blocking(
    conn: &Connection,
    schema: &str,
    kind: DbObjectKind,
    name: &str,
) -> Result<DbObjectDefinition, AppError> {
    let ty = type_str(kind)?;
    let sql = format!(
        "SELECT sql, tbl_name FROM {}.sqlite_schema WHERE type = ?1 AND name = ?2",
        quote_ident(schema)
    );
    let (ddl, tbl): (Option<String>, String) = conn
        .query_row(&sql, rusqlite::params![ty, name], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|e| map_query_error(conn, e))?;
    let ddl = ddl
        .ok_or_else(|| AppError::NotFound(format!("{ty} \"{name}\" has no stored definition.")))?;
    // sqlite_schema stores the CREATE without a trailing `;` — normalise.
    let ddl = {
        let t = ddl.trim_end();
        if t.ends_with(';') {
            t.to_string()
        } else {
            format!("{t};")
        }
    };
    let mut def = DbObjectDefinition::ddl_only(name.to_string(), kind, ddl);
    if matches!(kind, DbObjectKind::Trigger) {
        def.table = Some(tbl);
    }
    Ok(def)
}

pub(super) fn drop_sql(
    schema: &str,
    kind: DbObjectKind,
    name: &str,
    _detail: Option<&str>,
) -> Result<String, AppError> {
    let q = quote_ident;
    Ok(match kind {
        DbObjectKind::View => format!("DROP VIEW IF EXISTS {}.{};", q(schema), q(name)),
        // SQLite triggers are schema-scoped — no `ON <table>`.
        DbObjectKind::Trigger => format!("DROP TRIGGER IF EXISTS {}.{};", q(schema), q(name)),
        _ => return Err(unsupported()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_drop_sql_quotes_and_rejects_unsupported() {
        assert_eq!(
            drop_sql("main", DbObjectKind::View, "v", None).unwrap(),
            "DROP VIEW IF EXISTS \"main\".\"v\";"
        );
        assert_eq!(
            drop_sql("main", DbObjectKind::Trigger, "trg", Some("t")).unwrap(),
            "DROP TRIGGER IF EXISTS \"main\".\"trg\";"
        );
        assert!(drop_sql("main", DbObjectKind::Function, "f", None).is_err());
        assert!(drop_sql("main", DbObjectKind::MaterializedView, "mv", None).is_err());
    }
}
