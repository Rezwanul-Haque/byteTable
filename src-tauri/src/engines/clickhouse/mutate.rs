//! ClickHouse row mutations. ClickHouse has no OLTP `UPDATE`/`DELETE`; instead an
//! inline cell edit becomes an `ALTER TABLE … UPDATE` mutation and a row delete
//! an `ALTER TABLE … DELETE` mutation (run with `mutations_sync=1` so the call
//! blocks until the mutation completes). Truncate is `TRUNCATE TABLE`; a "schema"
//! is a database, so drop/create-schema map to `DROP DATABASE`/`CREATE DATABASE`.
//!
//! Safety: ClickHouse does NOT enforce sort-key uniqueness, so a "primary key"
//! can match more than one row. Like the other adapters, update/delete require
//! the FULL primary key and we COUNT the matched rows first — 0 → "no row
//! matched" (§5, nothing mutated); >1 → a §5 error that refuses to mass-mutate.

use crate::shared::engine::{
    split_statements, DeleteRowsRequest, DeleteRowsResult, ImportResult, PkPredicate,
    ProgressCallback, UpdateCellRequest, UpdateResult,
};
use crate::shared::error::AppError;

use super::http::ClickHouseHttp;
use super::sql::{ch_literal, ch_string_literal, qualified, quote_ident, validate_column};
use super::value::{as_string, as_u64};

/// Update one cell → `ALTER TABLE … UPDATE col = v WHERE <full pk>` (mutation).
pub async fn update_cell(
    http: &ClickHouseHttp,
    req: &UpdateCellRequest,
) -> Result<UpdateResult, AppError> {
    let (valid, pk_cols) = columns_and_pk(http, &req.schema, &req.table).await?;
    validate_column(&valid, &req.table, &req.column)?;
    validate_full_pk(&req.pk, &pk_cols, &req.table)?;

    let target = qualified(&req.schema, &req.table);
    let where_sql = pk_where(&req.pk)?;
    let set_literal = cell_literal(&req.value, req.binary)?;
    let set_col = quote_ident(&req.column);

    // Guard against a multi-match "pk" (ClickHouse enforces no uniqueness).
    let matched = count(http, &target, &where_sql).await?;
    if matched == 0 {
        return Err(AppError::Database(
            "No row matched — it may have already changed. Nothing was updated.".into(),
        ));
    }
    if matched > 1 {
        return Err(AppError::Database(format!(
            "The key matches {matched} rows; refusing to update more than one row."
        )));
    }

    let stmt = format!("ALTER TABLE {target} UPDATE {set_col} = {set_literal} WHERE {where_sql}");
    http.execute(&stmt, &[("mutations_sync", "1".to_string())])
        .await?;

    Ok(UpdateResult {
        affected: 1,
        statement: stmt,
    })
}

/// Delete rows → one `ALTER TABLE … DELETE WHERE (pk1) OR (pk2) …` mutation.
pub async fn delete_rows(
    http: &ClickHouseHttp,
    req: &DeleteRowsRequest,
) -> Result<DeleteRowsResult, AppError> {
    if req.rows.is_empty() {
        return Ok(DeleteRowsResult { deleted: 0 });
    }
    let (_, pk_cols) = columns_and_pk(http, &req.schema, &req.table).await?;
    let target = qualified(&req.schema, &req.table);

    let mut predicates = Vec::with_capacity(req.rows.len());
    for row in &req.rows {
        validate_full_pk(row, &pk_cols, &req.table)?;
        predicates.push(format!("({})", pk_where(row)?));
    }
    let where_sql = predicates.join(" OR ");

    // Count what will actually be removed (rows already gone count as 0).
    let deleted = count(http, &target, &where_sql).await?;
    if deleted == 0 {
        return Ok(DeleteRowsResult { deleted: 0 });
    }

    let stmt = format!("ALTER TABLE {target} DELETE WHERE {where_sql}");
    http.execute(&stmt, &[("mutations_sync", "1".to_string())])
        .await?;
    Ok(DeleteRowsResult { deleted })
}

/// Empty a table → `TRUNCATE TABLE`, returning the prior row count.
pub async fn truncate_table(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
) -> Result<u64, AppError> {
    let target = qualified(schema, table);
    let prior = count(http, &target, "1").await?;
    http.execute(&format!("TRUNCATE TABLE {target}"), &[])
        .await?;
    Ok(prior)
}

/// Drop + recreate a database (ClickHouse "schema"), leaving it empty.
pub async fn drop_schema(http: &ClickHouseHttp, schema: &str) -> Result<(), AppError> {
    let db = quote_ident(schema);
    http.execute(&format!("DROP DATABASE IF EXISTS {db}"), &[])
        .await?;
    http.execute(&format!("CREATE DATABASE {db}"), &[]).await?;
    Ok(())
}

/// Create a new empty database.
pub async fn create_schema(http: &ClickHouseHttp, schema: &str) -> Result<(), AppError> {
    http.execute(&format!("CREATE DATABASE {}", quote_ident(schema)), &[])
        .await
}

/// Run a multi-statement SQL script into `schema`. The ClickHouse HTTP interface
/// runs one statement per request, so the script is split (quote/comment-aware)
/// and each statement executed in order; a mid-script failure leaves the earlier
/// statements applied (ClickHouse has no DDL transaction).
pub async fn execute_script(
    http: &ClickHouseHttp,
    _schema: &str,
    sql: &str,
    on_progress: ProgressCallback<'_>,
) -> Result<ImportResult, AppError> {
    let statements = split_statements(sql);
    let total = statements.len() as u64;
    for (i, stmt) in statements.iter().enumerate() {
        http.execute(stmt, &[]).await?;
        on_progress(i as u64 + 1, total);
    }
    Ok(ImportResult { statements: total })
}

/// `SELECT count() FROM target WHERE <where_sql>` (pass `"1"` for all rows).
async fn count(http: &ClickHouseHttp, target: &str, where_sql: &str) -> Result<u64, AppError> {
    let value = http
        .scalar(&format!("SELECT count() FROM {target} WHERE {where_sql}"))
        .await?;
    Ok(value.and_then(|v| as_u64(&v)).unwrap_or(0))
}

/// Build a `col = literal AND …` predicate from a row's full primary key.
fn pk_where(pk: &[PkPredicate]) -> Result<String, AppError> {
    let mut fragments = Vec::with_capacity(pk.len());
    for pred in pk {
        let literal = cell_literal(&pred.value, pred.binary)?;
        // A null pk value matches nothing (`= NULL` is never true).
        if pred.value.is_null() {
            return Ok("0".to_string());
        }
        fragments.push(format!("{} = {literal}", quote_ident(&pred.column)));
    }
    Ok(fragments.join(" AND "))
}

/// Render a SET/predicate value as a ClickHouse literal (binary → `unhex('…')`).
fn cell_literal(value: &serde_json::Value, binary: bool) -> Result<String, AppError> {
    if binary {
        return Ok(match crate::shared::engine::parse_binary_value(value)? {
            Some(bytes) => {
                let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
                format!("unhex('{hex}')")
            }
            None => "NULL".to_string(),
        });
    }
    Ok(ch_literal(value))
}

/// The table's column names + its primary-key (sort-key) column set.
async fn columns_and_pk(
    http: &ClickHouseHttp,
    schema: &str,
    table: &str,
) -> Result<(Vec<String>, Vec<String>), AppError> {
    let result = http
        .query(
            &format!(
                "SELECT name, is_in_primary_key FROM system.columns \
                 WHERE database = {} AND table = {} ORDER BY position",
                ch_string_literal(schema),
                ch_string_literal(table)
            ),
            &[],
        )
        .await?;
    let mut valid = Vec::new();
    let mut pk = Vec::new();
    for row in result.data {
        if let Some(name) = row.first().map(as_string) {
            if row.get(1).and_then(as_u64).unwrap_or(0) == 1 {
                pk.push(name.clone());
            }
            valid.push(name);
        }
    }
    Ok((valid, pk))
}

/// Ensure `pk` covers EXACTLY the table's primary-key columns (mass-mutation
/// prevention). A table with no sort key, a partial key, or a predicate naming a
/// non-key column is a §5 error.
fn validate_full_pk(pk: &[PkPredicate], pk_cols: &[String], table: &str) -> Result<(), AppError> {
    if pk_cols.is_empty() {
        return Err(AppError::Database(format!(
            "'{table}' has no sort key, so a single row cannot be identified for editing."
        )));
    }
    let given: std::collections::HashSet<&str> = pk.iter().map(|p| p.column.as_str()).collect();
    let expected: std::collections::HashSet<&str> = pk_cols.iter().map(String::as_str).collect();
    if given != expected {
        return Err(AppError::Database(format!(
            "Editing '{table}' requires exactly its sort-key columns ({}).",
            pk_cols.join(", ")
        )));
    }
    Ok(())
}
