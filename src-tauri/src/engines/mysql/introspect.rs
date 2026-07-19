//! MySQL introspection: schemas, tables, columns, indexes, foreign keys,
//! comments and SHOW CREATE TABLE. Mirrors the `ports::sql::meta` contract.

use sqlx::mysql::MySqlPool;
use sqlx::Row;

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::sql::qualified;

/// The MySQL system databases excluded from `list_schemas` and the
/// available-schemas listing (they are server internals, not user data).
pub(super) const SYSTEM_SCHEMAS: [&str; 4] =
    ["mysql", "information_schema", "performance_schema", "sys"];

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// delegates; the SQL lives in the concern module).
pub(super) async fn list_schemas(pool: &MySqlPool) -> Result<Vec<SchemaInfo>, AppError> {
    // User databases only (system DBs excluded), each with a cheap table
    // count from the catalog. `?`-bound exclusion list keeps it parameterized.
    // information_schema string columns are VARBINARY-flavoured in MySQL 8
    // and their labels come back UPPERCASE; CAST(... AS CHAR) makes them
    // decodable as String and the lowercase alias fixes the label.
    let placeholders = vec!["?"; SYSTEM_SCHEMAS.len()].join(", ");
    let listing_sql = format!(
        "SELECT CAST(s.schema_name AS CHAR) AS name, \
            (SELECT count(*) FROM information_schema.tables t \
             WHERE t.table_schema = s.schema_name AND t.table_type = 'BASE TABLE') AS table_count \
         FROM information_schema.schemata s \
         WHERE s.schema_name NOT IN ({placeholders}) \
         ORDER BY s.schema_name"
    );
    let mut query = sqlx::query(&listing_sql);
    for sys in SYSTEM_SCHEMAS {
        query = query.bind(sys);
    }
    let rows = query.fetch_all(pool).await.map_err(map_query_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let name: String = row.get("name");
            let count: i64 = row.try_get("table_count").unwrap_or(0);
            SchemaInfo {
                name,
                table_count: Some(count.max(0) as u64),
            }
        })
        .collect())
}

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// delegates; the SQL lives in the concern module).
pub(super) async fn list_tables(
    pool: &MySqlPool,
    schema: &str,
) -> Result<Vec<TableInfo>, AppError> {
    ensure_schema_exists(pool, schema).await?;
    // Base tables in the database, with the storage engine's row ESTIMATE
    // (table_rows — approximate for InnoDB; module docs).
    let rows = sqlx::query(
        "SELECT CAST(table_name AS CHAR) AS name, table_rows AS est \
         FROM information_schema.tables \
         WHERE table_schema = ? AND table_type = 'BASE TABLE' \
         ORDER BY table_name",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let name: String = row.get("name");
            // table_rows is BIGINT UNSIGNED, decoded as u64; NULL for some
            // engines/views → None.
            let est: Option<u64> = row.try_get("est").unwrap_or(None);
            TableInfo {
                name,
                approx_row_count: est,
            }
        })
        .collect())
}

/// §5 "Schema 'x' does not exist…" unless `schema` is a visible user database.
pub(super) async fn ensure_schema_exists(pool: &MySqlPool, schema: &str) -> Result<(), AppError> {
    let exists: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM information_schema.schemata WHERE schema_name = ?")
            .bind(schema)
            .fetch_optional(pool)
            .await
            .map_err(map_query_error)?;
    if exists.is_some() {
        return Ok(());
    }
    let placeholders = vec!["?"; SYSTEM_SCHEMAS.len()].join(", ");
    let names_sql = format!(
        "SELECT CAST(schema_name AS CHAR) FROM information_schema.schemata \
         WHERE schema_name NOT IN ({placeholders}) ORDER BY schema_name"
    );
    let mut query = sqlx::query_scalar(&names_sql);
    for sys in SYSTEM_SCHEMAS {
        query = query.bind(sys);
    }
    let names: Vec<String> = query.fetch_all(pool).await.unwrap_or_default();
    Err(AppError::Database(format!(
        "Schema '{schema}' does not exist. Available schemas: {}.",
        if names.is_empty() {
            "(none)".to_string()
        } else {
            names.join(", ")
        }
    )))
}

// ---------------------------------------------------------------------------
// table_meta (introspection)
// ---------------------------------------------------------------------------

/// Column-level + structure metadata for one table (module docs for sources).
pub(super) async fn table_meta(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<TableMeta, AppError> {
    ensure_schema_exists(pool, schema).await?;

    // Existence: a base table or view in the database.
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM information_schema.tables \
         WHERE table_schema = ? AND table_name = ? \
           AND table_type IN ('BASE TABLE', 'VIEW')",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(map_query_error)?;
    if exists.is_none() {
        return Err(missing_table_error(pool, schema, table).await);
    }

    let foreign_keys = foreign_keys(pool, schema, table).await?;
    let fk_by_column = fk_by_first_column(&foreign_keys);

    // Columns from information_schema.columns. COLUMN_TYPE is the full type with
    // length/unsigned (e.g. "int unsigned", "tinyint(1)", "varchar(255)"),
    // preferred for display; DATA_TYPE is the base name used for numeric
    // detection. COLUMN_KEY = 'PRI' marks pk columns.
    let col_rows = sqlx::query(
        "SELECT CAST(column_name AS CHAR) AS column_name, \
            CAST(column_type AS CHAR) AS column_type, \
            CAST(data_type AS CHAR) AS data_type, \
            CAST(is_nullable AS CHAR) AS is_nullable, \
            CAST(column_default AS CHAR) AS column_default, \
            CAST(column_key AS CHAR) AS column_key, \
            CAST(column_comment AS CHAR) AS column_comment \
         FROM information_schema.columns \
         WHERE table_schema = ? AND table_name = ? \
         ORDER BY ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    // pk membership comes straight from COLUMN_KEY = 'PRI' per column — no
    // separate key-order query is needed (unlike the Postgres adapter, whose
    // assembled DDL wanted ordered pk columns; here the DDL is verbatim from
    // SHOW CREATE TABLE, and update_cell only needs the pk *set*).
    let mut columns = Vec::with_capacity(col_rows.len());
    for row in &col_rows {
        let name: String = row.get("column_name");
        let column_type: String = row.try_get("column_type").unwrap_or_default();
        let data_type: String = row.try_get("data_type").unwrap_or_default();
        let is_nullable: String = row.get("is_nullable");
        let default_value: Option<String> = row.try_get("column_default").unwrap_or(None);
        let column_key: String = row.try_get("column_key").unwrap_or_default();
        // MySQL COLUMN_COMMENT is NOT NULL and defaults to '' — normalize the
        // empty string to None so the UI shows "no comment".
        let comment: Option<String> = row
            .try_get::<String, _>("column_comment")
            .ok()
            .filter(|s| !s.is_empty());
        columns.push(ColumnInfo {
            fk: fk_by_column.get(&name).cloned(),
            pk: column_key == "PRI",
            name,
            comment,
            // Display the full COLUMN_TYPE; fall back to DATA_TYPE if absent.
            data_type: if column_type.is_empty() {
                data_type
            } else {
                column_type
            },
            nullable: is_nullable.eq_ignore_ascii_case("YES"),
            default_value,
        });
    }

    let indexes = table_indexes(pool, schema, table).await?;
    let referenced_by = inbound_foreign_keys(pool, schema, table).await?;
    let comment = table_comment(pool, schema, table).await?;
    let ddl = show_create_table(pool, schema, table).await?;

    Ok(TableMeta {
        columns,
        comment,
        indexes,
        foreign_keys,
        referenced_by,
        ddl,
    })
}

/// Outbound foreign keys, grouped per constraint with ordered column lists and
/// on_delete/on_update actions from referential_constraints.
pub(super) async fn foreign_keys(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
    // key_column_usage gives the local→referenced column pairs (ordered by
    // ORDINAL_POSITION); referential_constraints gives the ON DELETE/UPDATE
    // rules and the referenced table. Join on constraint_name.
    let rows = sqlx::query(
        "SELECT CAST(k.constraint_name AS CHAR) AS name, CAST(k.column_name AS CHAR) AS col, \
            CAST(k.referenced_table_name AS CHAR) AS ref_table, \
            CAST(k.referenced_column_name AS CHAR) AS ref_col, \
            CAST(rc.delete_rule AS CHAR) AS on_delete, CAST(rc.update_rule AS CHAR) AS on_update \
         FROM information_schema.key_column_usage k \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_schema = k.table_schema \
          AND rc.constraint_name = k.constraint_name \
          AND rc.table_name = k.table_name \
         WHERE k.table_schema = ? AND k.table_name = ? \
           AND k.referenced_table_name IS NOT NULL \
         ORDER BY k.constraint_name, k.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    // Group consecutive rows by constraint name into one ForeignKeyInfo.
    let mut grouped: Vec<ForeignKeyInfo> = Vec::new();
    for row in &rows {
        let name: String = row.get("name");
        let col: String = row.get("col");
        let ref_table: String = row.try_get("ref_table").unwrap_or_default();
        let ref_col: String = row.try_get("ref_col").unwrap_or_default();
        let on_delete: String = row.try_get("on_delete").unwrap_or_default();
        let on_update: String = row.try_get("on_update").unwrap_or_default();
        if let Some(last) = grouped.last_mut() {
            if last.name.as_deref() == Some(name.as_str()) {
                last.columns.push(col);
                last.ref_columns.push(ref_col);
                continue;
            }
        }
        grouped.push(ForeignKeyInfo {
            name: Some(name),
            columns: vec![col],
            ref_table,
            ref_columns: vec![ref_col],
            on_delete: Some(normalize_fk_action(&on_delete)),
            on_update: Some(normalize_fk_action(&on_update)),
        });
    }
    Ok(grouped)
}

/// Normalize a MySQL referential action string to the shared vocabulary.
/// MySQL's `referential_constraints` already reports them as readable text
/// (`NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`, `SET DEFAULT`); uppercase
/// and default empties to `NO ACTION`.
pub(super) fn normalize_fk_action(action: &str) -> String {
    let upper = action.trim().to_ascii_uppercase();
    if upper.is_empty() {
        "NO ACTION".to_string()
    } else {
        upper
    }
}

/// Per-column fk map for `ColumnInfo.fk` (sidebar icon): the first fk a column
/// participates in, target = the parallel referenced column.
pub(super) fn fk_by_first_column(
    foreign_keys: &[ForeignKeyInfo],
) -> std::collections::HashMap<String, FkRef> {
    let mut map = std::collections::HashMap::new();
    for fk in foreign_keys {
        for (i, col) in fk.columns.iter().enumerate() {
            map.entry(col.clone()).or_insert(FkRef {
                table: fk.ref_table.clone(),
                column: fk.ref_columns.get(i).cloned().unwrap_or_default(),
            });
        }
    }
    map
}

/// Indexes on the table (name, member columns in order, unique, primary), from
/// information_schema.statistics grouped by INDEX_NAME (columns ordered by
/// SEQ_IN_INDEX, uniqueness from NON_UNIQUE).
pub(super) async fn table_indexes(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT CAST(index_name AS CHAR) AS name, non_unique AS non_unique, \
            seq_in_index AS seq_in_index, CAST(column_name AS CHAR) AS column_name \
         FROM information_schema.statistics \
         WHERE table_schema = ? AND table_name = ? \
         ORDER BY index_name, seq_in_index",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    let mut grouped: Vec<IndexInfo> = Vec::new();
    for row in &rows {
        let name: String = row.get("name");
        // NON_UNIQUE is 0/1; unique == NON_UNIQUE == 0. MySQL 8 types this
        // catalog column as BIGINT UNSIGNED, so read u64 first, then fall back
        // to narrower signed widths, before defaulting to 1 (treat-as-non-
        // unique) — never silently mark a true unique index wrong.
        let non_unique: u64 = row
            .try_get::<u64, _>("non_unique")
            .or_else(|_| row.try_get::<i64, _>("non_unique").map(|v| v.max(0) as u64))
            .or_else(|_| row.try_get::<i32, _>("non_unique").map(|v| v.max(0) as u64))
            .unwrap_or(1);
        let column_name: Option<String> = row.try_get("column_name").unwrap_or(None);
        let is_primary = name == "PRIMARY";
        if let Some(last) = grouped.last_mut() {
            if last.name == name {
                if let Some(col) = column_name.clone() {
                    last.columns.push(col);
                }
                continue;
            }
        }
        grouped.push(IndexInfo {
            name: name.clone(),
            columns: column_name.into_iter().collect(),
            unique: non_unique == 0,
            // (unique = NON_UNIQUE == 0)
            primary: is_primary,
            origin: if is_primary {
                Some("pk".to_string())
            } else {
                None
            },
        });
    }
    Ok(grouped)
}

/// Inbound foreign keys (§3.6 "referenced by"): constraints in the same schema
/// whose referenced table is this one.
pub(super) async fn inbound_foreign_keys(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Vec<InboundFkInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT CAST(k.table_name AS CHAR) AS child_table, \
            CAST(k.constraint_name AS CHAR) AS name, \
            CAST(k.column_name AS CHAR) AS col, \
            CAST(k.referenced_column_name AS CHAR) AS ref_col, \
            CAST(rc.delete_rule AS CHAR) AS on_delete \
         FROM information_schema.key_column_usage k \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_schema = k.table_schema \
          AND rc.constraint_name = k.constraint_name \
          AND rc.table_name = k.table_name \
         WHERE k.referenced_table_schema = ? AND k.referenced_table_name = ? \
         ORDER BY k.table_name, k.constraint_name, k.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    let mut grouped: Vec<(String, InboundFkInfo)> = Vec::new();
    for row in &rows {
        let child_table: String = row.get("child_table");
        let name: String = row.get("name");
        let col: String = row.get("col");
        let ref_col: String = row.try_get("ref_col").unwrap_or_default();
        let on_delete: String = row.try_get("on_delete").unwrap_or_default();
        if let Some((last_name, last)) = grouped.last_mut() {
            if *last_name == name && last.table == child_table {
                last.columns.push(col);
                last.ref_columns.push(ref_col);
                continue;
            }
        }
        grouped.push((
            name,
            InboundFkInfo {
                table: child_table,
                columns: vec![col],
                ref_columns: vec![ref_col],
                on_delete: Some(normalize_fk_action(&on_delete)),
            },
        ));
    }
    Ok(grouped.into_iter().map(|(_, fk)| fk).collect())
}

/// The table's comment (information_schema.tables.TABLE_COMMENT).
pub(super) async fn table_comment(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Option<String>, AppError> {
    let comment: Option<String> = sqlx::query_scalar(
        "SELECT CAST(table_comment AS CHAR) FROM information_schema.tables \
         WHERE table_schema = ? AND table_name = ?",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(map_query_error)?
    .flatten();
    Ok(comment.filter(|s| !s.is_empty()))
}

/// The exact `CREATE TABLE` via MySQL's `SHOW CREATE TABLE` (module docs:
/// faithful, unlike the Postgres catalog reconstruction). The statement is
/// schema-qualified so it runs against any visible database. Returns the second
/// column of the single result row ("Create Table").
pub(super) async fn show_create_table(
    pool: &MySqlPool,
    schema: &str,
    table: &str,
) -> Result<Option<String>, AppError> {
    let sql = format!("SHOW CREATE TABLE {}", qualified(schema, table));
    let row = sqlx::query(&sql)
        .fetch_optional(pool)
        .await
        .map_err(map_query_error)?;
    // The result has columns ("Table", "Create Table"); read by index 1 since
    // the second column name differs for views ("Create View").
    Ok(row.and_then(|r| r.try_get::<String, _>(1).ok()))
}

/// §5 unknown-table message with the schema's available tables.
pub(super) async fn missing_table_error(pool: &MySqlPool, schema: &str, table: &str) -> AppError {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT CAST(table_name AS CHAR) FROM information_schema.tables \
         WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    AppError::Database(format!(
        "Table '{table}' does not exist. Available tables: {}.",
        if names.is_empty() {
            "(none)".to_string()
        } else {
            names.join(", ")
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_fk_action_uppercases_and_defaults() {
        assert_eq!(normalize_fk_action("cascade"), "CASCADE");
        assert_eq!(normalize_fk_action("SET NULL"), "SET NULL");
        assert_eq!(normalize_fk_action("no action"), "NO ACTION");
        assert_eq!(normalize_fk_action(""), "NO ACTION");
        assert_eq!(normalize_fk_action("RESTRICT"), "RESTRICT");
    }
}
