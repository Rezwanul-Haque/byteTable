//! SQLite schema-object introspection + DDL builders. SQLite has only views
//! and triggers (no materialized views, functions, or procedures). The object
//! catalog is `<schema>.sqlite_schema`, whose `sql` column already holds the
//! verbatim `CREATE …` DDL — so the definition is read directly, no builtin
//! needed. `drop_sql` is pure (unit-tested). Blocking (rusqlite is sync).

use rusqlite::Connection;

use crate::shared::engine::{DbObjectDefinition, DbObjectInfo, DbObjectKind};
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::sql::quote_ident;

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

/// Best-effort parse of a stored `CREATE TRIGGER …` statement into
/// (timing, events). SQLite has no trigger catalog columns, so we scan the DDL
/// header (up to the ` ON ` that introduces the table) to avoid matching
/// keywords in the trigger body.
fn parse_trigger_sql(sql: &str) -> (Option<String>, Vec<String>) {
    let up = sql.to_uppercase();
    let header = up.split(" ON ").next().unwrap_or(&up);
    let timing = if header.contains("INSTEAD OF") {
        Some("INSTEAD OF".to_string())
    } else if header.contains("BEFORE") {
        Some("BEFORE".to_string())
    } else if header.contains("AFTER") {
        Some("AFTER".to_string())
    } else {
        None
    };
    let mut events = Vec::new();
    if header.contains("INSERT") {
        events.push("INSERT".to_string());
    }
    if header.contains("UPDATE") {
        events.push("UPDATE".to_string());
    }
    if header.contains("DELETE") {
        events.push("DELETE".to_string());
    }
    (timing, events)
}

pub(super) fn list_blocking(
    conn: &Connection,
    schema: &str,
    kind: DbObjectKind,
) -> Result<Vec<DbObjectInfo>, AppError> {
    let ty = type_str(kind)?;
    // Triggers carry their owning table (tbl_name); views do not.
    let sql = format!(
        "SELECT name, tbl_name, sql FROM {}.sqlite_schema WHERE type = ?1 ORDER BY name",
        quote_ident(schema)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| map_query_error(conn, e))?;
    let rows = stmt
        .query_map([ty], |row| {
            let name: String = row.get(0)?;
            let tbl: String = row.get(1)?;
            let ddl: Option<String> = row.get(2)?;
            Ok((name, tbl, ddl))
        })
        .map_err(|e| map_query_error(conn, e))?;
    let mut out = Vec::new();
    for r in rows {
        let (name, tbl, ddl) = r.map_err(|e| map_query_error(conn, e))?;
        if matches!(kind, DbObjectKind::Trigger) {
            let mut info = DbObjectInfo::bare(name, kind, Some(tbl.clone()));
            info.table = Some(tbl);
            let (timing, events) = parse_trigger_sql(ddl.as_deref().unwrap_or(""));
            info.timing = timing;
            info.events = events;
            out.push(info);
        } else {
            out.push(DbObjectInfo::bare(name, kind, None));
        }
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
    fn sqlite_parses_trigger_timing_and_events() {
        let (timing, events) =
            parse_trigger_sql("CREATE TRIGGER trg_x AFTER UPDATE OF a, b ON t BEGIN SELECT 1; END");
        assert_eq!(timing, Some("AFTER".to_string()));
        assert_eq!(events, vec!["UPDATE".to_string()]);

        let (timing, events) = parse_trigger_sql(
            "CREATE TRIGGER v_ins INSTEAD OF INSERT ON my_view BEGIN INSERT INTO t VALUES (1); END",
        );
        assert_eq!(timing, Some("INSTEAD OF".to_string()));
        assert_eq!(events, vec!["INSERT".to_string()]);
    }

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
