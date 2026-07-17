//! MSSQL write path: cell update, row delete, truncate, drop-schema and
//! script execution. Mirrors the `ports::sql::mutate` contract.

use tiberius::Query;

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::introspect::{ensure_schema_exists, get_str, table_meta};
use super::query::bind_query;
use super::sql::{qualified, quote_ident, BoundValue};
use super::{exec_batch, TdsClient};

// ---------------------------------------------------------------------------
// update_cell / delete_rows (M11) — transactional (SQL Server DDL/DML both are)
// ---------------------------------------------------------------------------

pub(super) async fn update_cell(
    client: &mut TdsClient,
    req: &UpdateCellRequest,
) -> Result<UpdateResult, AppError> {
    let meta = table_meta(client, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    super::sql::validate_column(&column_names, &req.table, &req.column)?;

    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();
    validate_pk_predicates(&pk_columns, &column_names, &req.table, &req.pk)?;

    let q = qualified(&req.schema, &req.table);
    let set_col = quote_ident(&req.column);

    // @P1 = SET value; @P2.. = each pk value in predicate order.
    let mut params: Vec<BoundValue> = Vec::with_capacity(1 + req.pk.len());
    params.push(if req.binary {
        BoundValue::from_binary_set(&req.value)?
    } else {
        BoundValue::from_json_set(&req.value)
    });
    let mut where_fragments: Vec<String> = Vec::with_capacity(req.pk.len());
    for (i, predicate) in req.pk.iter().enumerate() {
        if predicate.value.is_null() {
            return Err(no_row_matched_error());
        }
        params.push(if predicate.binary {
            BoundValue::from_binary_operand(&predicate.value)?
        } else {
            BoundValue::from_json_operand(&predicate.value)?
        });
        // @P1 is the SET value, so pk placeholders start at @P2.
        where_fragments.push(format!("{} = @P{}", quote_ident(&predicate.column), i + 2));
    }
    let where_sql = where_fragments.join(" AND ");
    let update_sql = format!("UPDATE {q} SET {set_col} = @P1 WHERE {where_sql}");

    exec_batch(client, "BEGIN TRANSACTION").await?;

    let mut query = Query::new(&update_sql);
    for b in &params {
        bind_query(&mut query, b);
    }
    let affected = match query.execute(&mut *client).await {
        Ok(res) => res.total(),
        Err(err) => {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(map_query_error(err));
        }
    };

    if affected == 0 {
        let _ = exec_batch(client, "ROLLBACK").await;
        return Err(no_row_matched_error());
    }
    if affected > 1 {
        let _ = exec_batch(client, "ROLLBACK").await;
        return Err(AppError::Database(format!(
            "Update would affect {affected} rows; expected exactly one. No changes were applied."
        )));
    }
    exec_batch(client, "COMMIT").await?;

    Ok(UpdateResult {
        affected,
        statement: display_update_statement(&q, &req.column, &req.value, &req.pk),
    })
}

pub(super) async fn delete_rows(
    client: &mut TdsClient,
    req: &DeleteRowsRequest,
) -> Result<DeleteRowsResult, AppError> {
    if req.rows.is_empty() {
        return Ok(DeleteRowsResult { deleted: 0 });
    }
    let meta = table_meta(client, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();
    let q = qualified(&req.schema, &req.table);

    exec_batch(client, "BEGIN TRANSACTION").await?;

    let mut deleted: u64 = 0;
    for pk in &req.rows {
        if let Err(e) = validate_pk_predicates(&pk_columns, &column_names, &req.table, pk) {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(e);
        }
        let mut params: Vec<BoundValue> = Vec::with_capacity(pk.len());
        let mut where_fragments: Vec<String> = Vec::with_capacity(pk.len());
        for (i, predicate) in pk.iter().enumerate() {
            if predicate.value.is_null() {
                let _ = exec_batch(client, "ROLLBACK").await;
                return Err(no_row_matched_error());
            }
            params.push(if predicate.binary {
                BoundValue::from_binary_operand(&predicate.value)?
            } else {
                BoundValue::from_json_operand(&predicate.value)?
            });
            where_fragments.push(format!("{} = @P{}", quote_ident(&predicate.column), i + 1));
        }
        let where_sql = where_fragments.join(" AND ");
        let delete_sql = format!("DELETE FROM {q} WHERE {where_sql}");
        let mut query = Query::new(&delete_sql);
        for b in &params {
            bind_query(&mut query, b);
        }
        match query.execute(&mut *client).await {
            Ok(res) => {
                let affected = res.total();
                if affected > 1 {
                    let _ = exec_batch(client, "ROLLBACK").await;
                    return Err(AppError::Database(format!(
                        "A delete would affect {affected} rows; expected at most one. \
                         No rows were deleted."
                    )));
                }
                deleted += affected;
            }
            Err(err) => {
                let _ = exec_batch(client, "ROLLBACK").await;
                return Err(map_query_error(err));
            }
        }
    }
    exec_batch(client, "COMMIT").await?;
    Ok(DeleteRowsResult { deleted })
}

pub(super) fn no_row_matched_error() -> AppError {
    AppError::Database(
        "No row matched (it may have been deleted or changed since you loaded it).".to_string(),
    )
}

/// Enforce the full-primary-key policy (mass-update prevention). Identical
/// semantics to the other adapters' `validate_pk_predicates`.
pub(super) fn validate_pk_predicates(
    pk_columns: &[&str],
    all_columns: &[String],
    table: &str,
    predicates: &[PkPredicate],
) -> Result<(), AppError> {
    if pk_columns.is_empty() {
        return Err(AppError::Database(format!(
            "Cannot update '{table}': it has no primary key, so a single row cannot be safely targeted."
        )));
    }
    if predicates.is_empty() {
        return Err(AppError::Database(format!(
            "Updating a cell in '{table}' requires the full primary key ({}).",
            pk_columns.join(", ")
        )));
    }
    let mut seen: Vec<&str> = Vec::with_capacity(predicates.len());
    for predicate in predicates {
        let column = predicate.column.as_str();
        if !pk_columns.contains(&column) {
            if all_columns.iter().any(|c| c == column) {
                return Err(AppError::Database(format!(
                    "Column '{column}' is not part of the primary key of '{table}' \
                     (primary key: {}); an update must target the row by its primary key.",
                    pk_columns.join(", ")
                )));
            }
            return Err(super::sql::validate_column(all_columns, table, column)
                .expect_err("unknown pk column"));
        }
        if seen.contains(&column) {
            return Err(AppError::Database(format!(
                "Primary-key column '{column}' is given more than once in the update."
            )));
        }
        seen.push(column);
    }
    if let Some(missing) = pk_columns.iter().find(|c| !seen.contains(*c)) {
        return Err(AppError::Database(format!(
            "Updating a cell in '{table}' requires the full primary key ({}); '{missing}' is missing.",
            pk_columns.join(", ")
        )));
    }
    Ok(())
}

/// Cosmetic, values-inlined UPDATE for the §3.5 toast (the executed query binds
/// every value).
pub(super) fn display_update_statement(
    qualified: &str,
    column: &str,
    value: &serde_json::Value,
    pk: &[PkPredicate],
) -> String {
    let set = format!("{} = {}", quote_ident(column), sql_literal(value));
    let where_sql = pk
        .iter()
        .map(|p| format!("{} = {}", quote_ident(&p.column), sql_literal(&p.value)))
        .collect::<Vec<_>>()
        .join(" AND ");
    format!("UPDATE {qualified} SET {set} WHERE {where_sql}")
}

/// A JSON scalar as a display SQL literal for the cosmetic toast (NOT executed).
pub(super) fn sql_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

// ---------------------------------------------------------------------------
// truncate / schema ops (M15)
// ---------------------------------------------------------------------------

pub(super) async fn truncate_table(
    client: &mut TdsClient,
    schema: &str,
    table: &str,
) -> Result<u64, AppError> {
    table_meta(client, schema, table).await?;
    let q = qualified(schema, table);
    let count_rows = client
        .simple_query(format!("SELECT COUNT_BIG(*) AS n FROM {q}"))
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let prior = count_rows
        .first()
        .and_then(|r| r.try_get::<i64, _>("n").ok().flatten())
        .unwrap_or(0);
    exec_batch(client, format!("TRUNCATE TABLE {q}")).await?;
    Ok(prior.max(0) as u64)
}

/// Drop every table (and the FK constraints touching them) in `schema`, leaving
/// the schema itself in place and empty (M15 drop-schema). SQL Server has no
/// `DROP SCHEMA … CASCADE`, so we drop FK constraints first, then the tables,
/// inside one transaction (SQL Server DDL is transactional → atomic).
pub(super) async fn drop_schema(client: &mut TdsClient, schema: &str) -> Result<(), AppError> {
    ensure_schema_exists(client, schema).await?;

    // FK constraints whose parent OR referenced table lives in the schema.
    let mut fk_q = Query::new(
        "SELECT fk.name AS fk, ps.name AS psch, pt.name AS ptbl \
         FROM sys.foreign_keys fk \
         JOIN sys.tables pt ON pt.object_id = fk.parent_object_id \
         JOIN sys.schemas ps ON ps.schema_id = pt.schema_id \
         JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id \
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id \
         WHERE ps.name = @P1 OR rs.name = @P1",
    );
    fk_q.bind(schema.to_string());
    let fk_rows = fk_q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let fk_drops: Vec<String> = fk_rows
        .iter()
        .map(|r| {
            format!(
                "ALTER TABLE {}.{} DROP CONSTRAINT {}",
                quote_ident(&get_str(r, "psch")),
                quote_ident(&get_str(r, "ptbl")),
                quote_ident(&get_str(r, "fk"))
            )
        })
        .collect();

    let mut tbl_q = Query::new(
        "SELECT t.name AS name FROM sys.tables t \
         JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = @P1",
    );
    tbl_q.bind(schema.to_string());
    let tbl_rows = tbl_q
        .query(client)
        .await
        .map_err(map_query_error)?
        .into_first_result()
        .await
        .map_err(map_query_error)?;
    let table_drops: Vec<String> = tbl_rows
        .iter()
        .map(|r| {
            format!(
                "DROP TABLE {}.{}",
                quote_ident(schema),
                quote_ident(&get_str(r, "name"))
            )
        })
        .collect();

    exec_batch(client, "BEGIN TRANSACTION").await?;
    for stmt in fk_drops.iter().chain(table_drops.iter()) {
        if let Err(err) = exec_batch(client, stmt.clone()).await {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(err);
        }
    }
    exec_batch(client, "COMMIT").await?;
    Ok(())
}

/// Run a whole multi-statement SQL script into `schema` (M15 import). SQL Server
/// DDL is transactional, so — unlike MySQL — the whole import is atomic: we wrap
/// it in a transaction and roll the lot back on any error.
pub(super) async fn execute_script(
    client: &mut TdsClient,
    schema: &str,
    sql: &str,
    on_progress: ProgressCallback<'_>,
) -> Result<ImportResult, AppError> {
    ensure_schema_exists(client, schema).await?;
    let statements = split_statements(sql);
    let total = statements.len() as u64;

    exec_batch(client, "BEGIN TRANSACTION").await?;
    for (applied, statement) in statements.iter().enumerate() {
        if let Err(err) = exec_batch(client, statement.clone()).await {
            let _ = exec_batch(client, "ROLLBACK").await;
            return Err(AppError::Database(format!(
                "Import failed at statement {} of {total}: {err} \
                 The whole import was rolled back (nothing changed).",
                applied + 1,
            )));
        }
        on_progress(applied as u64 + 1, total);
    }
    exec_batch(client, "COMMIT").await?;
    Ok(ImportResult { statements: total })
}
