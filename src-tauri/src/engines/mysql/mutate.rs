//! MySQL write path: cell update, row delete, truncate, drop-schema and
//! script execution. Mirrors the `ports::sql::mutate` contract.

use sqlx::mysql::MySqlPool;

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::introspect::{ensure_schema_exists, table_meta};
use super::query::bind_all;
use super::sql::{qualified, quote_ident, validate_column, BoundValue};

// ---------------------------------------------------------------------------
// update_cell
// ---------------------------------------------------------------------------

/// Update a single cell (M11): `SET col = ? WHERE <full pk>` in a transaction,
/// asserting exactly one affected row. pk-completeness policy + bound values
/// match the SQLite/Postgres adapters; MySQL uses `?` placeholders and a real
/// transaction with ROLLBACK on any deviation. (DML — not DDL — IS transactional
/// on InnoDB, so the rollback here is genuine, unlike the alter_table caveat.)
pub(super) async fn update_cell(
    pool: &MySqlPool,
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

    // ?1 = SET value; ?2.. = each pk value in predicate order. Binary columns
    // (req.binary / predicate.binary) bind their `0x`-hex / UUID value as raw
    // bytes so `SET col = ?` writes — and `WHERE pk = ?` matches — the bytes.
    let mut params: Vec<BoundValue> = Vec::with_capacity(1 + req.pk.len());
    params.push(if req.binary {
        BoundValue::from_binary_set(&req.value)?
    } else {
        BoundValue::from_json_set(&req.value)
    });

    let mut where_fragments: Vec<String> = Vec::with_capacity(req.pk.len());
    for predicate in &req.pk {
        if predicate.value.is_null() {
            return Err(no_row_matched_error());
        }
        params.push(if predicate.binary {
            BoundValue::from_binary_operand(&predicate.value)?
        } else {
            BoundValue::from_json_operand(&predicate.value)?
        });
        where_fragments.push(format!("{} = ?", quote_ident(&predicate.column)));
    }
    let where_sql = where_fragments.join(" AND ");
    let update_sql = format!("UPDATE {qualified} SET {set_col} = ? WHERE {where_sql}");

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

/// Delete a set of whole rows by primary key (grid multi-select bulk delete).
/// Validates the pk columns once, then runs one guarded `DELETE` per row in a
/// single transaction. A vanished row (affected 0) is skipped; a DELETE hitting
/// more than one row aborts the batch. Returns the count deleted.
pub(super) async fn delete_rows(
    pool: &MySqlPool,
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
        for predicate in pk {
            if predicate.value.is_null() {
                let _ = tx.rollback().await;
                return Err(no_row_matched_error());
            }
            params.push(if predicate.binary {
                BoundValue::from_binary_operand(&predicate.value)?
            } else {
                BoundValue::from_json_operand(&predicate.value)?
            });
            where_fragments.push(format!("{} = ?", quote_ident(&predicate.column)));
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

pub(super) fn no_row_matched_error() -> AppError {
    AppError::Database(
        "No row matched (it may have been deleted or changed since you loaded it).".to_string(),
    )
}

/// Empty a table, keeping its structure (M15 truncate). MySQL has a native
/// `TRUNCATE TABLE`, which reports no affected-row count, so we `COUNT(*)`
/// first and return that as the number removed (0 for an already-empty table).
/// The table must exist (reuse `table_meta` for the §5 "Table 'x' does not
/// exist…" message).
pub(super) async fn truncate_table(
    pool: &MySqlPool,
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
/// In MySQL a schema IS a database, so this runs `DROP DATABASE \`x\`;
/// CREATE DATABASE \`x\`;`. **NOT atomic:** MySQL implicitly commits each DDL
/// statement, so the drop commits before the recreate runs — there is no
/// rolling it back. We recreate immediately so a successful call always leaves
/// an empty database; if the recreate itself fails the §5 error says the drop
/// already committed (the database is gone). The schema must exist first
/// (a §5 "does not exist" error otherwise).
///
/// We do NOT re-`USE` afterward: every other adapter operation fully qualifies
/// names (`` `db`.`table` ``) and does not depend on the connection's default
/// database, and the pool may hand out a different session anyway. The pool's
/// configured default database (if it was this one) is simply recreated empty.
pub(super) async fn drop_schema(pool: &MySqlPool, schema: &str) -> Result<(), AppError> {
    ensure_schema_exists(pool, schema).await?;
    let quoted = quote_ident(schema);

    use sqlx::Executor as _;
    // One acquired connection so the drop + recreate run on the same session,
    // back to back, minimizing the window where the database does not exist.
    let mut conn = pool.acquire().await.map_err(map_query_error)?;

    conn.execute(format!("DROP DATABASE {quoted}").as_str())
        .await
        .map_err(map_query_error)?;

    if let Err(err) = conn
        .execute(format!("CREATE DATABASE {quoted}").as_str())
        .await
    {
        let engine_msg = map_query_error(err);
        return Err(AppError::Database(format!(
            "Schema '{schema}' was dropped, but recreating the empty database \
             failed: {engine_msg} MySQL commits each DDL statement, so the drop \
             was NOT rolled back — the schema is gone. Recreate it manually."
        )));
    }
    Ok(())
}

/// Run a whole multi-statement SQL script (a dump) into `schema` (M15 import).
///
/// **NOT atomic.** MySQL implicitly commits each DDL statement, so a
/// multi-statement import cannot be rolled back: if statement N fails,
/// statements 1..N-1 have already landed. We surface that honestly — the §5
/// error names how many statements ran before the failure so the user can
/// recover. (Postgres/SQLite roll the whole import back; MySQL is the
/// documented exception, the same caveat the `alter_table` batch carries.)
///
/// Mechanism: we set the target database with `USE` and run the dump
/// statement-by-statement on the SAME acquired connection (so `USE` and every
/// statement share one session — a `USE` on the pool surface could land on a
/// different pooled connection). We split the script client-side with the
/// quote/comment-aware [`split_statements`] and execute each in order, so a
/// mid-script failure tells us exactly how many statements committed before the
/// error.
///
/// The schema must exist (a §5 error otherwise).
pub(super) async fn execute_script(
    pool: &MySqlPool,
    schema: &str,
    sql: &str,
    on_progress: crate::shared::engine::ProgressCallback<'_>,
) -> Result<ImportResult, AppError> {
    ensure_schema_exists(pool, schema).await?;
    let statements = split_statements(sql);
    let total = statements.len() as u64;

    use sqlx::Executor as _;

    // One acquired connection so `USE` and every statement share a session (a
    // `USE` on the pool surface could land on a different pooled connection).
    let mut conn = pool.acquire().await.map_err(map_query_error)?;

    // We execute each statement as a bare `&str`, which carries NO bound
    // arguments — so the MySQL driver runs it over the TEXT protocol, not the
    // prepared-statement protocol. That matters: dump statements include DDL
    // (e.g. `SHOW CREATE TABLE` output) that MySQL rejects over the prepared
    // protocol ("This command is not supported in the prepared statement
    // protocol yet."). `&str` also avoids the `raw_sql` executor's higher-ranked
    // lifetime bound, which does not unify inside an async-trait method.
    conn.execute(format!("USE {}", quote_ident(schema)).as_str())
        .await
        .map_err(map_query_error)?;

    // Disable FK checks for this import session. A schema dump lists tables in
    // listing order, NOT foreign-key order, so a `CREATE TABLE` with a forward
    // FK (referencing a table dumped later) fails with "Failed to open the
    // referenced table" — and INSERTs can likewise arrive parent-after-child.
    // This is exactly what `mysqldump` does (`SET FOREIGN_KEY_CHECKS=0` around
    // the dump). It is session-scoped on this one acquired connection; we
    // restore it before the connection returns to the pool (below), regardless
    // of outcome, so no other query inherits the relaxed setting.
    conn.execute("SET FOREIGN_KEY_CHECKS = 0")
        .await
        .map_err(map_query_error)?;

    let mut outcome: Result<(), AppError> = Ok(());
    for (applied, statement) in statements.iter().enumerate() {
        let applied = applied as u64;
        if let Err(err) = conn.execute(statement.as_str()).await {
            let engine_msg = map_query_error(err);
            outcome = Err(AppError::Database(format!(
                "Import failed at statement {} of {total}: {engine_msg} \
                 MySQL commits each statement as it runs, so the {applied} statement(s) \
                 before the failure were applied and were NOT rolled back.",
                applied + 1,
            )));
            break;
        }
        on_progress(applied + 1, total);
    }

    // Restore FK enforcement on this pooled connection before returning (on the
    // happy path AND after a mid-script failure), so a later borrower of the
    // same connection isn't left with checks disabled.
    let _ = conn.execute("SET FOREIGN_KEY_CHECKS = 1").await;

    outcome?;
    Ok(ImportResult { statements: total })
}

/// Enforce the full-primary-key policy (mass-update prevention). Identical
/// semantics to the SQLite/Postgres adapters' `validate_pk_predicates`.
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

    #[test]
    fn validate_pk_predicates_enforces_full_pk() {
        let all = vec!["id".to_string(), "name".to_string()];
        assert!(validate_pk_predicates(&[], &all, "t", &[]).is_err());
        assert!(validate_pk_predicates(&["id"], &all, "t", &[]).is_err());
        let non_pk = vec![PkPredicate {
            column: "name".into(),
            value: serde_json::json!("x"),
            binary: false,
        }];
        assert!(validate_pk_predicates(&["id"], &all, "t", &non_pk).is_err());
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
