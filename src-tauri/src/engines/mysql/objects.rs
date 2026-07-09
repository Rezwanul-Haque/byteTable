//! MySQL schema-object introspection + DDL builders (views, functions,
//! procedures, triggers — MySQL has no materialized views). Listing uses
//! `information_schema` (schema bound as a parameter); definitions use
//! `SHOW CREATE …` (the object identifier is interpolated, quoted — `SHOW`
//! takes no bind params). `drop_sql` is pure (unit-tested).

use sqlx::{MySqlPool, Row};

use crate::shared::engine::{DbObjectDefinition, DbObjectInfo, DbObjectKind, RoutineArg};
use crate::shared::error::AppError;

use super::map_query_error;
use super::sql::quote_ident;

/// Kinds MySQL exposes (no materialized views).
pub(super) const KINDS: &[DbObjectKind] = &[
    DbObjectKind::View,
    DbObjectKind::Function,
    DbObjectKind::Procedure,
    DbObjectKind::Trigger,
];

fn unsupported() -> AppError {
    AppError::Unsupported("MySQL does not support that object kind.".into())
}

pub(super) async fn list(
    pool: &MySqlPool,
    schema: &str,
    kind: DbObjectKind,
) -> Result<Vec<DbObjectInfo>, AppError> {
    // Read by INDEX with non-panicking `try_get` (a `get` panics on a decode
    // miss → whole call errors → empty section). CAST name columns to CHAR:
    // information_schema text columns can come back as bytes, which a direct
    // String decode rejects (the same bug that blanked routine arg types).
    match kind {
        DbObjectKind::View => {
            let rows = sqlx::query(
                "SELECT CAST(table_name AS CHAR) AS name, CAST(definer AS CHAR) AS owner \
                 FROM information_schema.views WHERE table_schema = ? ORDER BY 1",
            )
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(map_query_error)?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let mut info = DbObjectInfo::bare(
                        r.try_get::<String, _>("name").unwrap_or_default(),
                        kind,
                        None,
                    );
                    info.owner = r
                        .try_get::<Option<String>, _>("owner")
                        .ok()
                        .flatten()
                        .filter(|s| !s.is_empty());
                    info
                })
                .collect())
        }
        DbObjectKind::Function | DbObjectKind::Procedure => {
            let routine_type = if matches!(kind, DbObjectKind::Function) {
                "FUNCTION"
            } else {
                "PROCEDURE"
            };
            let rows = sqlx::query(
                "SELECT CAST(r.routine_name AS CHAR) AS name, \
                        CAST(r.dtd_identifier AS CHAR) AS ret, \
                        CAST(r.definer AS CHAR) AS owner, \
                        CAST(r.last_altered AS CHAR) AS modified, \
                        (SELECT COUNT(*) FROM information_schema.parameters pa \
                          WHERE pa.specific_schema = r.routine_schema \
                            AND pa.specific_name = r.specific_name \
                            AND pa.ordinal_position > 0) AS nargs \
                 FROM information_schema.routines r \
                 WHERE r.routine_schema = ? AND r.routine_type = ? ORDER BY 1",
            )
            .bind(schema)
            .bind(routine_type)
            .fetch_all(pool)
            .await
            .map_err(map_query_error)?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let mut info = DbObjectInfo::bare(
                        r.try_get::<String, _>("name").unwrap_or_default(),
                        kind,
                        None,
                    );
                    if matches!(kind, DbObjectKind::Function) {
                        info.returns = r
                            .try_get::<Option<String>, _>("ret")
                            .ok()
                            .flatten()
                            .filter(|s| !s.is_empty());
                    }
                    info.language = Some("SQL".to_string());
                    info.owner = r
                        .try_get::<Option<String>, _>("owner")
                        .ok()
                        .flatten()
                        .filter(|s| !s.is_empty());
                    info.modified = r.try_get::<Option<String>, _>("modified").ok().flatten();
                    info.arg_count = r.try_get::<i64, _>("nargs").ok();
                    info
                })
                .collect())
        }
        DbObjectKind::Trigger => {
            let rows = sqlx::query(
                "SELECT CAST(trigger_name AS CHAR) AS name, \
                        CAST(event_object_table AS CHAR) AS tbl, \
                        CAST(action_timing AS CHAR) AS timing, \
                        CAST(event_manipulation AS CHAR) AS event, \
                        CAST(definer AS CHAR) AS owner \
                 FROM information_schema.triggers WHERE trigger_schema = ? ORDER BY 1",
            )
            .bind(schema)
            .fetch_all(pool)
            .await
            .map_err(map_query_error)?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let tbl = r.try_get::<Option<String>, _>("tbl").ok().flatten();
                    let mut info = DbObjectInfo::bare(
                        r.try_get::<String, _>("name").unwrap_or_default(),
                        kind,
                        tbl.clone(),
                    );
                    info.table = tbl;
                    info.timing = r.try_get::<Option<String>, _>("timing").ok().flatten();
                    if let Some(ev) = r.try_get::<Option<String>, _>("event").ok().flatten() {
                        info.events = vec![ev];
                    }
                    // MySQL triggers have no disabled state — always enabled.
                    info.enabled = Some(true);
                    info.owner = r
                        .try_get::<Option<String>, _>("owner")
                        .ok()
                        .flatten()
                        .filter(|s| !s.is_empty());
                    info
                })
                .collect())
        }
        DbObjectKind::MaterializedView => Ok(Vec::new()),
    }
}

pub(super) async fn definition(
    pool: &MySqlPool,
    schema: &str,
    kind: DbObjectKind,
    name: &str,
    detail: Option<&str>,
) -> Result<DbObjectDefinition, AppError> {
    // Views: build a clean `CREATE OR REPLACE VIEW … AS <body>` from
    // information_schema.view_definition (the SELECT), not `SHOW CREATE VIEW`
    // — the latter is one minified line with ALGORITHM/DEFINER/SQL SECURITY
    // cruft. (view_definition is longtext → CAST to CHAR.)
    if matches!(kind, DbObjectKind::View) {
        // Resolve the SAME way `list` does — filter by table_schema only and
        // match the name in Rust. Adding `AND table_name = ?` can come back
        // empty on some MySQL builds (information_schema name-column collation /
        // binding quirk), even though the list clearly has the view.
        let rows = sqlx::query(
            "SELECT CAST(table_name AS CHAR), CAST(view_definition AS CHAR) \
             FROM information_schema.views WHERE table_schema = ?",
        )
        .bind(schema)
        .fetch_all(pool)
        .await
        .map_err(map_query_error)?;
        let body = rows
            .into_iter()
            .find_map(|r| {
                let tname: String = r.try_get(0).ok()?;
                if tname == name {
                    r.try_get::<Option<String>, _>(1).ok().flatten()
                } else {
                    None
                }
            })
            .ok_or_else(|| AppError::NotFound(format!("View '{name}' was not found.")))?;
        let body = body.trim_end().trim_end_matches(';');
        let ddl = format!(
            "CREATE OR REPLACE VIEW {}.{} AS\n{body};",
            quote_ident(schema),
            quote_ident(name)
        );
        return Ok(DbObjectDefinition::ddl_only(name.to_string(), kind, ddl));
    }

    // (keyword for SHOW CREATE, the 0-based column index holding the DDL).
    // Read by INDEX, not name: sqlx does not reliably match `SHOW CREATE`'s
    // display column names (e.g. "Create Function"). Layouts:
    //   FUNCTION  → [Function, sql_mode, Create Function, ...]   → 2
    //   PROCEDURE → [Procedure, sql_mode, Create Procedure, ...] → 2
    //   TRIGGER   → [Trigger, sql_mode, SQL Original Statement,…]→ 2
    let (keyword, ddl_col) = match kind {
        DbObjectKind::Function => ("FUNCTION", 2usize),
        DbObjectKind::Procedure => ("PROCEDURE", 2),
        DbObjectKind::Trigger => ("TRIGGER", 2),
        DbObjectKind::View | DbObjectKind::MaterializedView => return Err(unsupported()),
    };
    let row = sqlx::query(&format!(
        "SHOW CREATE {keyword} {}.{}",
        quote_ident(schema),
        quote_ident(name)
    ))
    .fetch_one(pool)
    .await
    .map_err(map_query_error)?;
    let ddl: String = row.try_get(ddl_col).map_err(map_query_error)?;
    let mut def = DbObjectDefinition::ddl_only(name.to_string(), kind, ddl);
    // Best-effort chip/args metadata.
    match kind {
        DbObjectKind::Function | DbObjectKind::Procedure => {
            enrich_routine(pool, &mut def, schema, name).await;
        }
        DbObjectKind::Trigger => {
            def.table = detail.map(str::to_string);
            enrich_trigger(pool, &mut def, schema, name).await;
        }
        _ => {}
    }
    Ok(def)
}

/// Routine metadata (information_schema.routines + .parameters).
async fn enrich_routine(pool: &MySqlPool, def: &mut DbObjectDefinition, schema: &str, name: &str) {
    let routine_type = if matches!(def.kind, DbObjectKind::Function) {
        "FUNCTION"
    } else {
        "PROCEDURE"
    };
    // CAST text columns to CHAR: information_schema stores them as longtext,
    // which sqlx returns as bytes (fails a direct String decode → empty type).
    if let Ok(row) = sqlx::query(
        "SELECT CAST(dtd_identifier AS CHAR), CAST(routine_comment AS CHAR) \
         FROM information_schema.routines \
         WHERE routine_schema = ? AND routine_name = ? AND routine_type = ?",
    )
    .bind(schema)
    .bind(name)
    .bind(routine_type)
    .fetch_one(pool)
    .await
    {
        if matches!(def.kind, DbObjectKind::Function) {
            def.returns = row.try_get::<Option<String>, _>(0).ok().flatten();
        }
        let c = row.try_get::<Option<String>, _>(1).ok().flatten();
        def.comment = c.filter(|s| !s.is_empty());
        def.language = Some("SQL".to_string());
    }
    if let Ok(rows) = sqlx::query(
        "SELECT CAST(parameter_mode AS CHAR), CAST(parameter_name AS CHAR), \
                CAST(dtd_identifier AS CHAR) \
         FROM information_schema.parameters \
         WHERE specific_schema = ? AND specific_name = ? AND ordinal_position > 0 \
         ORDER BY ordinal_position",
    )
    .bind(schema)
    .bind(name)
    .fetch_all(pool)
    .await
    {
        def.args = rows
            .into_iter()
            .map(|r| RoutineArg {
                mode: r
                    .try_get::<Option<String>, _>(0)
                    .ok()
                    .flatten()
                    .or_else(|| Some("IN".into())),
                name: r
                    .try_get::<Option<String>, _>(1)
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
                data_type: r
                    .try_get::<Option<String>, _>(2)
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
            })
            .collect();
    }
}

/// Trigger metadata (information_schema.triggers).
async fn enrich_trigger(pool: &MySqlPool, def: &mut DbObjectDefinition, schema: &str, name: &str) {
    if let Ok(row) = sqlx::query(
        "SELECT action_timing, event_manipulation, action_orientation \
         FROM information_schema.triggers \
         WHERE trigger_schema = ? AND trigger_name = ?",
    )
    .bind(schema)
    .bind(name)
    .fetch_one(pool)
    .await
    {
        def.timing = row.try_get::<Option<String>, _>(0).ok().flatten();
        if let Some(ev) = row.try_get::<Option<String>, _>(1).ok().flatten() {
            def.events = vec![ev];
        }
        def.level = row.try_get::<Option<String>, _>(2).ok().flatten();
    }
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
        DbObjectKind::Function => format!("DROP FUNCTION IF EXISTS {}.{};", q(schema), q(name)),
        DbObjectKind::Procedure => format!("DROP PROCEDURE IF EXISTS {}.{};", q(schema), q(name)),
        // MySQL triggers are schema-scoped — no `ON <table>`.
        DbObjectKind::Trigger => format!("DROP TRIGGER IF EXISTS {}.{};", q(schema), q(name)),
        DbObjectKind::MaterializedView => return Err(unsupported()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_drop_sql_uses_backticks_and_no_on_table() {
        assert_eq!(
            drop_sql("shop", DbObjectKind::View, "v", None).unwrap(),
            "DROP VIEW IF EXISTS `shop`.`v`;"
        );
        assert_eq!(
            drop_sql("shop", DbObjectKind::Procedure, "p", None).unwrap(),
            "DROP PROCEDURE IF EXISTS `shop`.`p`;"
        );
        assert_eq!(
            drop_sql("shop", DbObjectKind::Trigger, "trg", Some("orders")).unwrap(),
            "DROP TRIGGER IF EXISTS `shop`.`trg`;"
        );
        assert!(drop_sql("shop", DbObjectKind::MaterializedView, "mv", None).is_err());
    }
}
