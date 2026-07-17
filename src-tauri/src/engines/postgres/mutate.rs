//! Postgres write path: cell update, row delete, truncate, drop-schema and
//! script execution. Mirrors the `ports::sql::mutate` contract.

use sqlx::postgres::PgPool;

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::introspect::{ensure_schema_exists, table_meta};
use super::query::bind_all;
use super::sql::{qualified, quote_ident, validate_column, BoundValue};

// ---------------------------------------------------------------------------
// update_cell
// ---------------------------------------------------------------------------

/// Update a single cell (M11): `SET col = $1 WHERE <full pk>` in a transaction,
/// asserting exactly one affected row. pk-completeness policy + bound values
/// match the SQLite adapter; Postgres uses `$N` placeholders and a real
/// transaction with ROLLBACK on any deviation.
pub(super) async fn update_cell(
    pool: &PgPool,
    req: &UpdateCellRequest,
) -> Result<UpdateResult, AppError> {
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    validate_column(&column_names, &req.table, &req.column)?;

    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();
    validate_pk_predicates(&pk_columns, &column_names, &req.table, &req.pk)?;

    let qualified = qualified(&req.schema, &req.table);
    let set_col = quote_ident(&req.column);

    // $1 = SET value; $2.. = each pk value in predicate order. Binary columns
    // (req.binary / predicate.binary) bind their `0x`-hex / UUID value as raw
    // bytes (bytea) so the write and the WHERE match the bytes.
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
        where_fragments.push(format!("{} = ${}", quote_ident(&predicate.column), i + 2));
    }
    let where_sql = where_fragments.join(" AND ");
    let update_sql = format!("UPDATE {qualified} SET {set_col} = $1 WHERE {where_sql}");

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    let result = bind_all(sqlx::query(&update_sql), &params)
        .execute(&mut *tx)
        .await;
    let affected = match result {
        Ok(done) => done.rows_affected(),
        Err(err) => {
            let _ = tx.rollback().await;
            return Err(map_query_error(err));
        }
    };

    if affected == 0 {
        let _ = tx.rollback().await;
        return Err(no_row_matched_error());
    }
    if affected > 1 {
        let _ = tx.rollback().await;
        return Err(AppError::Database(format!(
            "Update would affect {affected} rows; expected exactly one. \
             No changes were applied."
        )));
    }
    tx.commit().await.map_err(map_query_error)?;

    Ok(UpdateResult {
        affected,
        statement: display_update_statement(&qualified, &req.column, &req.value, &req.pk),
    })
}

pub(super) fn no_row_matched_error() -> AppError {
    AppError::Database(
        "No row matched (it may have been deleted or changed since you loaded it).".to_string(),
    )
}

/// Delete a set of whole rows by primary key (grid multi-select bulk delete).
/// Validates the pk columns once, then runs one guarded `DELETE` per row in a
/// single transaction. A row that already vanished (affected 0) is skipped; a
/// DELETE that would hit more than one row aborts the whole batch (defense in
/// depth — impossible once the pk is validated). Returns the count deleted.
pub(super) async fn delete_rows(
    pool: &PgPool,
    req: &DeleteRowsRequest,
) -> Result<DeleteRowsResult, AppError> {
    if req.rows.is_empty() {
        return Ok(DeleteRowsResult { deleted: 0 });
    }
    let meta = table_meta(pool, &req.schema, &req.table).await?;
    let column_names: Vec<String> = meta.columns.iter().map(|c| c.name.clone()).collect();
    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();
    let qualified = qualified(&req.schema, &req.table);

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    let mut deleted: u64 = 0;
    for pk in &req.rows {
        validate_pk_predicates(&pk_columns, &column_names, &req.table, pk)?;
        let mut params: Vec<BoundValue> = Vec::with_capacity(pk.len());
        let mut where_fragments: Vec<String> = Vec::with_capacity(pk.len());
        for (i, predicate) in pk.iter().enumerate() {
            if predicate.value.is_null() {
                let _ = tx.rollback().await;
                return Err(no_row_matched_error());
            }
            params.push(if predicate.binary {
                BoundValue::from_binary_operand(&predicate.value)?
            } else {
                BoundValue::from_json_operand(&predicate.value)?
            });
            where_fragments.push(format!("{} = ${}", quote_ident(&predicate.column), i + 1));
        }
        let where_sql = where_fragments.join(" AND ");
        let delete_sql = format!("DELETE FROM {qualified} WHERE {where_sql}");
        let result = bind_all(sqlx::query(&delete_sql), &params)
            .execute(&mut *tx)
            .await;
        match result {
            Ok(done) => {
                let affected = done.rows_affected();
                if affected > 1 {
                    let _ = tx.rollback().await;
                    return Err(AppError::Database(format!(
                        "A delete would affect {affected} rows; expected at most one. \
                         No rows were deleted."
                    )));
                }
                deleted += affected;
            }
            Err(err) => {
                let _ = tx.rollback().await;
                return Err(map_query_error(err));
            }
        }
    }
    tx.commit().await.map_err(map_query_error)?;
    Ok(DeleteRowsResult { deleted })
}

/// Empty a table, keeping its structure (M15 truncate). Postgres has a native
/// `TRUNCATE TABLE`, which is faster than `DELETE` but reports no affected-row
/// count, so we `COUNT(*)` first and return that as the number removed (0 for
/// an already-empty table). The table must exist (reuse `table_meta` for the
/// §5 "Table 'x' does not exist…" message).
pub(super) async fn truncate_table(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<u64, AppError> {
    table_meta(pool, schema, table).await?;
    let qualified = qualified(schema, table);

    let prior: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {qualified}"))
        .fetch_one(pool)
        .await
        .map_err(map_query_error)?;

    sqlx::query(&format!("TRUNCATE TABLE {qualified}"))
        .execute(pool)
        .await
        .map_err(map_query_error)?;

    Ok(prior.max(0) as u64)
}

/// Drop every table in `schema` and leave the schema empty (M15 drop-schema).
///
/// Runs `DROP SCHEMA "x" CASCADE; CREATE SCHEMA "x";` inside ONE explicit
/// transaction. Postgres has transactional DDL, so this is atomic: either both
/// statements land (leaving an empty schema, exactly as the prototype's SQL
/// preview promises) or the whole thing rolls back and the schema is untouched.
/// CASCADE drops the tables and everything that depends on them (indexes, views,
/// sequences). The schema must exist (a §5 "does not exist" error otherwise,
/// matching the prototype's plain `DROP SCHEMA` — no `IF EXISTS`).
pub(super) async fn drop_schema(pool: &PgPool, schema: &str) -> Result<(), AppError> {
    ensure_schema_exists(pool, schema).await?;
    let quoted = quote_ident(schema);

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    if let Err(err) = sqlx::query(&format!("DROP SCHEMA {quoted} CASCADE"))
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        return Err(map_query_error(err));
    }
    if let Err(err) = sqlx::query(&format!("CREATE SCHEMA {quoted}"))
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        return Err(map_query_error(err));
    }
    tx.commit().await.map_err(map_query_error)?;
    Ok(())
}

/// Run a whole multi-statement SQL script (a dump) into `schema` (M15 import).
///
/// Atomicity: the whole dump runs inside one explicit sqlx transaction
/// (`pool.begin()` → COMMIT on success, ROLLBACK on any error), so a mid-script
/// failure rolls ALL statements back and a table is never left half-created
/// (Postgres has transactional DDL). We `SET search_path` first within that
/// transaction so unqualified `CREATE`s land in the target schema, then run the
/// dump statement-by-statement (split with the quote/comment-aware
/// [`split_statements`]) on the one transaction connection. Splitting
/// client-side and using `sqlx::query` per statement mirrors the proven
/// `alter_table` path and binds nothing — the statements come from a file the
/// user chose, exactly like the SQL query editor.
///
/// The schema must exist (a §5 error otherwise — same message vocabulary as the
/// rest of the adapter). Any engine error surfaces §5-style after the rollback.
pub(super) async fn execute_script(
    pool: &PgPool,
    schema: &str,
    sql: &str,
    on_progress: crate::shared::engine::ProgressCallback<'_>,
) -> Result<ImportResult, AppError> {
    ensure_schema_exists(pool, schema).await?;
    let statements = split_statements(sql);
    let total = statements.len() as u64;

    let mut tx = pool.begin().await.map_err(map_query_error)?;
    // search_path inside the transaction so the dump's unqualified names resolve
    // to the target schema (and shares the one tx connection).
    if let Err(err) = sqlx::query(&format!("SET search_path TO {}", quote_ident(schema)))
        .execute(&mut *tx)
        .await
    {
        let _ = tx.rollback().await;
        return Err(map_query_error(err));
    }
    for (i, statement) in statements.iter().enumerate() {
        if let Err(err) = sqlx::query(statement).execute(&mut *tx).await {
            // Roll the whole import back — no table left half-created.
            let _ = tx.rollback().await;
            return Err(map_query_error(err));
        }
        on_progress(i as u64 + 1, total);
    }
    tx.commit().await.map_err(map_query_error)?;

    Ok(ImportResult { statements: total })
}

/// Enforce the full-primary-key policy (mass-update prevention). Identical
/// semantics to the SQLite adapter's `validate_pk_predicates`.
pub(super) fn validate_pk_predicates(
    pk_columns: &[&str],
    all_columns: &[String],
    table: &str,
    predicates: &[PkPredicate],
) -> Result<(), AppError> {
    if pk_columns.is_empty() {
        return Err(AppError::Database(format!(
            "Cannot update '{table}': it has no primary key, so a single row \
             cannot be safely targeted."
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
            return Err(validate_column(all_columns, table, column).expect_err("unknown pk column"));
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
            "Updating a cell in '{table}' requires the full primary key ({}); \
             '{missing}' is missing.",
            pk_columns.join(", ")
        )));
    }
    Ok(())
}

/// Cosmetic, values-inlined UPDATE for the §3.5 toast (the executed query binds
/// every value — see [`UpdateResult`]).
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
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::engine::PkPredicate;

    #[test]
    fn validate_pk_predicates_enforces_full_pk() {
        let all = vec!["id".to_string(), "name".to_string()];
        // No pk → rejected.
        assert!(validate_pk_predicates(&[], &all, "t", &[]).is_err());
        // Missing pk value → rejected.
        assert!(validate_pk_predicates(&["id"], &all, "t", &[]).is_err());
        // Non-pk predicate column → rejected.
        let non_pk = vec![PkPredicate {
            column: "name".into(),
            value: serde_json::json!("x"),
            binary: false,
        }];
        assert!(validate_pk_predicates(&["id"], &all, "t", &non_pk).is_err());
        // Complete pk → ok.
        let ok = vec![PkPredicate {
            column: "id".into(),
            value: serde_json::json!(1),
            binary: false,
        }];
        assert!(validate_pk_predicates(&["id"], &all, "t", &ok).is_ok());
    }

    #[test]
    fn sql_literal_renders_display_values() {
        assert_eq!(sql_literal(&serde_json::Value::Null), "NULL");
        assert_eq!(sql_literal(&serde_json::json!(true)), "true");
        assert_eq!(sql_literal(&serde_json::json!(42)), "42");
        assert_eq!(sql_literal(&serde_json::json!("a'b")), "'a''b'");
    }
}
