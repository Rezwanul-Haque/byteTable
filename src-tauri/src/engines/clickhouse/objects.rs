//! ClickHouse schema objects: views, materialized views, and SQL UDF functions.
//! ClickHouse has **no procedures and no triggers**, so those kinds are absent
//! (mirroring the prototype's `ENGINE_OBJECTS.clickhouse = ['table','view',
//! 'matview','function']`). Views/matviews come from `system.tables`
//! (`engine = 'View'` / `'MaterializedView'`); SQL UDFs from `system.functions`
//! (`origin = 'SQLUserDefined'`). Definitions use `SHOW CREATE TABLE` / the
//! function's `create_query`.

use crate::shared::engine::{DbObjectDefinition, DbObjectInfo, DbObjectKind};
use crate::shared::error::AppError;

use super::http::ClickHouseHttp;
use super::sql::{ch_string_literal, qualified, quote_ident};
use super::value::as_string;

/// The object kinds ClickHouse exposes — no procedures, no triggers.
pub const KINDS: &[DbObjectKind] = &[
    DbObjectKind::View,
    DbObjectKind::MaterializedView,
    DbObjectKind::Function,
];

/// List objects of `kind` in `schema`. Functions are server-global (not
/// database-scoped), so they list regardless of `schema`.
pub async fn list(
    http: &ClickHouseHttp,
    schema: &str,
    kind: DbObjectKind,
) -> Result<Vec<DbObjectInfo>, AppError> {
    let sql = match kind {
        DbObjectKind::View => format!(
            "SELECT name FROM system.tables WHERE database = {} AND engine = 'View' ORDER BY name",
            ch_string_literal(schema)
        ),
        DbObjectKind::MaterializedView => format!(
            "SELECT name FROM system.tables WHERE database = {} AND engine = 'MaterializedView' \
             AND name NOT LIKE '.inner%' ORDER BY name",
            ch_string_literal(schema)
        ),
        DbObjectKind::Function => {
            "SELECT name FROM system.functions WHERE origin = 'SQLUserDefined' ORDER BY name"
                .to_string()
        }
        // ClickHouse has neither procedures nor triggers.
        DbObjectKind::Procedure | DbObjectKind::Trigger => return Ok(Vec::new()),
    };
    let result = http.query(&sql, &[]).await?;
    Ok(result
        .data
        .into_iter()
        .filter_map(|row| row.first().map(as_string))
        .map(|name| DbObjectInfo::bare(name, kind, None))
        .collect())
}

/// The `CREATE …` DDL for one object.
pub async fn definition(
    http: &ClickHouseHttp,
    schema: &str,
    kind: DbObjectKind,
    name: &str,
    _detail: Option<&str>,
) -> Result<DbObjectDefinition, AppError> {
    let ddl = match kind {
        DbObjectKind::View | DbObjectKind::MaterializedView => http
            .scalar(&format!("SHOW CREATE TABLE {}", qualified(schema, name)))
            .await?
            .map(|v| as_string(&v)),
        DbObjectKind::Function => http
            .scalar(&format!(
                "SELECT create_query FROM system.functions WHERE name = {}",
                ch_string_literal(name)
            ))
            .await?
            .map(|v| as_string(&v)),
        DbObjectKind::Procedure | DbObjectKind::Trigger => {
            return Err(AppError::Unsupported(
                "ClickHouse has no procedures or triggers.".into(),
            ))
        }
    };
    let ddl = ddl.filter(|d| !d.is_empty()).ok_or_else(|| {
        AppError::Database(format!("Could not read the definition for '{name}'."))
    })?;
    Ok(DbObjectDefinition::ddl_only(name.to_string(), kind, ddl))
}

/// A precise `DROP …` statement for one object.
pub fn drop_sql(
    schema: &str,
    kind: DbObjectKind,
    name: &str,
    _detail: Option<&str>,
) -> Result<String, AppError> {
    match kind {
        // A materialized view is dropped with DROP VIEW too.
        DbObjectKind::View | DbObjectKind::MaterializedView => {
            Ok(format!("DROP VIEW {}", qualified(schema, name)))
        }
        DbObjectKind::Function => Ok(format!("DROP FUNCTION {}", quote_ident(name))),
        DbObjectKind::Procedure | DbObjectKind::Trigger => Err(AppError::Unsupported(
            "ClickHouse has no procedures or triggers.".into(),
        )),
    }
}
