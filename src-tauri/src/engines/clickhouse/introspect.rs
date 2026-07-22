//! ClickHouse introspection: databases (`system.databases`), tables + row counts
//! (`system.tables`), columns (`system.columns`), data-skipping/secondary indexes
//! (`system.data_skipping_indices`), and the `CREATE TABLE` DDL via
//! `SHOW CREATE TABLE`. Views/matviews/functions are handled in [`super::objects`].
//!
//! Base-table filter: views/materialized views (`engine IN ('View',
//! 'MaterializedView')`), a materialized view's hidden `.inner…` storage table,
//! and temporary tables are excluded from the table list — they are objects or
//! internal, not user tables.

use crate::shared::engine::{ColumnInfo, IndexInfo, SchemaInfo, TableInfo, TableMeta};
use crate::shared::error::AppError;

use super::http::ClickHouseHttp;
use super::sql::{ch_string_literal, qualified};
use super::value::{as_string, as_u64};

/// The `system.tables` predicate that keeps only real user tables.
const BASE_TABLE_FILTER: &str =
    "engine NOT IN ('View', 'MaterializedView') AND name NOT LIKE '.inner%' \
     AND name NOT LIKE '.inner_id%' AND NOT is_temporary";

/// List databases (ClickHouse "schemas") with a cheap user-table count.
pub async fn list_schemas(http: &ClickHouseHttp) -> Result<Vec<SchemaInfo>, AppError> {
    // Per-database user-table counts (databases with zero tables are absent here
    // and default to 0 below).
    let counts = http
        .query(
            &format!(
                "SELECT database, count() FROM system.tables WHERE {BASE_TABLE_FILTER} \
                 GROUP BY database"
            ),
            &[],
        )
        .await?;
    let mut count_by_db = std::collections::HashMap::new();
    for row in counts.data {
        if row.len() >= 2 {
            count_by_db.insert(as_string(&row[0]), as_u64(&row[1]).unwrap_or(0));
        }
    }

    // ClickHouse ships TWO information-schema databases — `INFORMATION_SCHEMA`
    // and its lowercase alias `information_schema` (SQL-standard compatibility
    // duplicates, both empty). Hide both from the switcher; keep `system`.
    let dbs = http
        .query(
            "SELECT name FROM system.databases \
             WHERE name NOT IN ('INFORMATION_SCHEMA', 'information_schema') ORDER BY name",
            &[],
        )
        .await?;
    Ok(dbs
        .data
        .into_iter()
        .filter_map(|row| row.first().map(as_string))
        .map(|name| {
            let table_count = count_by_db.get(&name).copied();
            SchemaInfo { name, table_count }
        })
        .collect())
}

/// List user tables in `schema` with an approximate row count.
pub async fn list_tables(http: &ClickHouseHttp, schema: &str) -> Result<Vec<TableInfo>, AppError> {
    let result = http
        .query(
            &format!(
                "SELECT name, total_rows FROM system.tables \
                 WHERE database = {} AND {BASE_TABLE_FILTER} ORDER BY name",
                ch_string_literal(schema)
            ),
            &[],
        )
        .await?;
    Ok(result
        .data
        .into_iter()
        .filter_map(|row| {
            let name = row.first().map(as_string)?;
            let approx_row_count = row.get(1).and_then(as_u64);
            Some(TableInfo {
                name,
                approx_row_count,
            })
        })
        .collect())
}

/// Column-level metadata + indexes + `SHOW CREATE TABLE` DDL for one table.
pub async fn table_meta(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
) -> Result<TableMeta, AppError> {
    let columns = read_columns(http, schema, table).await?;
    if columns.is_empty() {
        // Unknown table → §5 human error listing what IS there.
        let available = list_tables(http, schema)
            .await
            .map(|ts| {
                ts.into_iter()
                    .map(|t| t.name)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        return Err(AppError::Database(format!(
            "Table '{table}' does not exist in '{schema}' (tables: {available})."
        )));
    }

    let indexes = read_indexes(http, schema, table, &columns).await?;
    let comment = read_table_comment(http, schema, table).await?;
    let ddl = show_create_table(http, schema, table).await.ok();

    Ok(TableMeta {
        columns,
        comment,
        indexes,
        foreign_keys: Vec::new(), // ClickHouse has no foreign keys.
        referenced_by: Vec::new(),
        ddl,
    })
}

/// Read columns from `system.columns`. `pk` marks the primary-key (== sorting
/// key) members; `nullable` is derived from a `Nullable(…)` wrapper.
async fn read_columns(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, AppError> {
    let result = http
        .query(
            &format!(
                "SELECT name, type, default_kind, default_expression, comment, is_in_primary_key \
                 FROM system.columns WHERE database = {} AND table = {} ORDER BY position",
                ch_string_literal(schema),
                ch_string_literal(table)
            ),
            &[],
        )
        .await?;
    Ok(result
        .data
        .into_iter()
        .filter_map(|row| {
            let name = row.first().map(as_string)?;
            let data_type = row.get(1).map(as_string).unwrap_or_default();
            let default_kind = row.get(2).map(as_string).unwrap_or_default();
            let default_expr = row.get(3).map(as_string).unwrap_or_default();
            let comment = row.get(4).map(as_string).unwrap_or_default();
            let pk = row.get(5).and_then(as_u64).unwrap_or(0) == 1;
            Some(ColumnInfo {
                nullable: data_type.starts_with("Nullable("),
                pk,
                default_value: (!default_kind.is_empty() && !default_expr.is_empty())
                    .then_some(default_expr),
                fk: None,
                comment: (!comment.is_empty()).then_some(comment),
                name,
                data_type,
            })
        })
        .collect())
}

/// Read data-skipping (secondary) indexes, plus a synthetic primary-key index
/// representing the ORDER BY sort key (so the Structure rail shows it).
async fn read_indexes(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
    columns: &[ColumnInfo],
) -> Result<Vec<IndexInfo>, AppError> {
    let mut indexes = Vec::new();

    // The sort key (primary index) — the pk columns, in order.
    let pk_cols: Vec<String> = columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.clone())
        .collect();
    if !pk_cols.is_empty() {
        indexes.push(IndexInfo {
            name: "PRIMARY KEY".to_string(),
            columns: pk_cols,
            unique: false,
            primary: true,
            origin: Some("sort_key".to_string()),
        });
    }

    let result = http
        .query(
            &format!(
                "SELECT name, expr, type FROM system.data_skipping_indices \
                 WHERE database = {} AND table = {}",
                ch_string_literal(schema),
                ch_string_literal(table)
            ),
            &[],
        )
        .await?;
    for row in result.data {
        let Some(name) = row.first().map(as_string) else {
            continue;
        };
        let expr = row.get(1).map(as_string).unwrap_or_default();
        let ty = row.get(2).map(as_string).unwrap_or_default();
        let cols = expr
            .split(',')
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .collect::<Vec<_>>();
        indexes.push(IndexInfo {
            name,
            columns: cols,
            unique: false,
            primary: false,
            origin: (!ty.is_empty()).then_some(ty),
        });
    }
    Ok(indexes)
}

/// The table comment from `system.tables`, when non-empty.
async fn read_table_comment(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
) -> Result<Option<String>, AppError> {
    let value = http
        .scalar(&format!(
            "SELECT comment FROM system.tables WHERE database = {} AND name = {}",
            ch_string_literal(schema),
            ch_string_literal(table)
        ))
        .await?;
    Ok(value.map(|v| as_string(&v)).filter(|c| !c.is_empty()))
}

/// `SHOW CREATE TABLE db.table` — the real, server-rendered DDL.
pub async fn show_create_table(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
) -> Result<String, AppError> {
    let value = http
        .scalar(&format!("SHOW CREATE TABLE {}", qualified(schema, table)))
        .await?;
    value
        .map(|v| as_string(&v))
        .ok_or_else(|| AppError::Database(format!("Could not read the DDL for '{table}'.")))
}
