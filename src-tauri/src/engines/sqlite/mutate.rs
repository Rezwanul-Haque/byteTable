//! SQLite write path: cell update, row delete, truncate, drop-schema and
//! script execution. Mirrors the `ports::sql::mutate` contract.

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::introspect::{ensure_schema_exists, table_meta_blocking};
use super::sql::{
    json_to_blob_operand, json_to_blob_set, json_to_set_value, json_to_sql_value, quote_ident,
    sql_literal, validate_column,
};

/// Update a single cell on one row (M11 inline edit, DESIGN_SPEC §3.5):
/// `SET req.column = req.value WHERE <full pk>`.
///
/// # Safety (this MUTATES user data)
///
/// - Schema/table existence is checked first (the §5 messages); `column` is
///   validated against the table's real columns before being quoted.
/// - The `pk` predicate columns must match the table's REAL primary key
///   *exactly* — every pk column present, and no predicate naming a non-pk
///   column. A table with no primary key, a partial pk, or a non-pk predicate
///   column is a §5 error. This is the mass-update guard: a complete pk WHERE
///   clause matches at most one row.
/// - **Every value is bound**, never interpolated: the new value first
///   (`SET "c" = ?`), then each pk value (`WHERE "pk" = ?`). A `null` new value
///   binds as `SET "c" = NULL` correctly (a bound NULL is fine in a SET; only
///   `WHERE c = NULL` is the SQL trap). An injection payload binds as an inert
///   literal. The only interpolated identifiers are quoted via [`quote_ident`].
/// - A `null` pk value can never match (`= NULL` is `UNKNOWN`); we surface that
///   as the same "no row matched" result the affected-count guard produces.
/// - Executed inside a transaction. The affected-row count is asserted: `0` →
///   §5 "no row matched" (stale/deleted pk), nothing changed; `>1` → ROLLBACK
///   and a §5 error (defense in depth — impossible once the pk is validated,
///   but a bug must never silently mass-update); `1` → COMMIT. Any engine
///   error (e.g. a NOT NULL violation) rolls back, leaving the row untouched.
pub(super) fn update_cell_blocking(
    conn: &Connection,
    req: &UpdateCellRequest,
) -> Result<UpdateResult, AppError> {
    // Existence first: unknown schema/table get the §5 human messages, and this
    // gives us the real column list (incl. pk membership) to validate against.
    let meta = table_meta_blocking(conn, &req.schema, &req.table)?;
    validate_column(&meta, &req.table, &req.column)?;

    // Enforce the full-primary-key policy (mass-update prevention). The pk
    // predicate set must equal the table's real pk column set exactly.
    validate_pk_predicates(&meta, &req.table, &req.pk)?;

    let qualified = format!("{}.{}", quote_ident(&req.schema), quote_ident(&req.table));
    let set_col = quote_ident(&req.column);

    // Bind order: the SET value first, then each pk value in predicate order.
    let mut params: Vec<SqlValue> = Vec::with_capacity(1 + req.pk.len());
    // The SET value is bound even when NULL — a bound NULL produces the correct
    // `SET col = NULL` (json_to_sql_value rejects NULL because it is written for
    // WHERE-equality; for the SET we want NULL, so map it directly here).
    // Binary columns (req.binary / predicate.binary) bind their `0x`-hex / UUID
    // value as a BLOB so the write and the WHERE match the bytes.
    params.push(if req.binary {
        json_to_blob_set(&req.value)?
    } else {
        json_to_set_value(&req.value)
    });

    // Build `WHERE "pk1" = ? AND "pk2" = ? …` in predicate order. A null pk
    // value never matches — short-circuit to the "no row matched" miss without
    // touching the database (binding a NULL into `= ?` would also never match,
    // but the explicit check keeps the intent and the message clear).
    let mut where_fragments: Vec<String> = Vec::with_capacity(req.pk.len());
    for predicate in &req.pk {
        if predicate.value.is_null() {
            return Err(no_row_matched_error());
        }
        params.push(if predicate.binary {
            json_to_blob_operand(&predicate.value)?
        } else {
            json_to_sql_value(&predicate.value)?
        });
        where_fragments.push(format!("{} = ?", quote_ident(&predicate.column)));
    }
    let where_sql = where_fragments.join(" AND ");

    let update_sql = format!("UPDATE {qualified} SET {set_col} = ? WHERE {where_sql}");

    // Transaction so the >1 guard can roll back; a busy timeout turns a transient
    // lock into a clear error rather than an immediate "database is locked".
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;

    let affected = match conn.execute(&update_sql, rusqlite::params_from_iter(params.iter())) {
        Ok(affected) => affected as u64,
        Err(err) => {
            // Roll back so the row is untouched, then surface the engine error
            // §5-style (e.g. a NOT NULL violation when setting NULL).
            let _ = conn.execute_batch("ROLLBACK");
            return Err(map_query_error(conn, err));
        }
    };

    if affected == 0 {
        // Nothing changed → no row matched the pk (stale value / deleted row).
        // ROLLBACK is a no-op here but keeps the transaction tidy.
        let _ = conn.execute_batch("ROLLBACK");
        return Err(no_row_matched_error());
    }
    if affected > 1 {
        // Defense in depth: a complete-pk WHERE should match at most one row, so
        // this is unreachable once the pk is validated — but never silently
        // mass-update on a bug or a non-unique "pk".
        let _ = conn.execute_batch("ROLLBACK");
        return Err(AppError::Database(format!(
            "Update would affect {affected} rows; expected exactly one. \
             No changes were applied."
        )));
    }

    conn.execute_batch("COMMIT")
        .map_err(|err| map_query_error(conn, err))?;

    Ok(UpdateResult {
        affected,
        statement: display_update_statement(&qualified, &req.column, &req.value, &req.pk),
    })
}

/// Delete a set of whole rows by primary key (grid multi-select bulk delete).
/// Validates the pk columns once, then runs one guarded `DELETE` per row inside
/// a single transaction. A vanished row (affected 0) is skipped; a DELETE that
/// would hit more than one row aborts the batch. Returns the count deleted.
pub(super) fn delete_rows_blocking(
    conn: &Connection,
    req: &DeleteRowsRequest,
) -> Result<DeleteRowsResult, AppError> {
    if req.rows.is_empty() {
        return Ok(DeleteRowsResult { deleted: 0 });
    }
    let meta = table_meta_blocking(conn, &req.schema, &req.table)?;
    let qualified = format!("{}.{}", quote_ident(&req.schema), quote_ident(&req.table));

    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;

    let mut deleted: u64 = 0;
    for pk in &req.rows {
        if let Err(e) = validate_pk_predicates(&meta, &req.table, pk) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
        let mut params: Vec<SqlValue> = Vec::with_capacity(pk.len());
        let mut where_fragments: Vec<String> = Vec::with_capacity(pk.len());
        let mut null_pk = false;
        for predicate in pk {
            if predicate.value.is_null() {
                null_pk = true;
                break;
            }
            let bound = if predicate.binary {
                json_to_blob_operand(&predicate.value)
            } else {
                json_to_sql_value(&predicate.value)
            };
            match bound {
                Ok(v) => params.push(v),
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(e);
                }
            }
            where_fragments.push(format!("{} = ?", quote_ident(&predicate.column)));
        }
        if null_pk {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(no_row_matched_error());
        }
        let where_sql = where_fragments.join(" AND ");
        let delete_sql = format!("DELETE FROM {qualified} WHERE {where_sql}");
        match conn.execute(&delete_sql, rusqlite::params_from_iter(params.iter())) {
            Ok(affected) => {
                let affected = affected as u64;
                if affected > 1 {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(AppError::Database(format!(
                        "A delete would affect {affected} rows; expected at most one. \
                         No rows were deleted."
                    )));
                }
                deleted += affected;
            }
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(map_query_error(conn, err));
            }
        }
    }

    conn.execute_batch("COMMIT")
        .map_err(|err| map_query_error(conn, err))?;
    Ok(DeleteRowsResult { deleted })
}

/// Empty a table, keeping its structure (M15 truncate). SQLite has no
/// `TRUNCATE`, so this runs `DELETE FROM "schema"."table"` inside a
/// transaction; the affected count is the number of rows removed (0 for an
/// already-empty table). The table must exist (a §5 error otherwise) — we
/// reuse `table_meta_blocking` for the same "Table 'x' does not exist…"
/// message the rest of the adapter produces.
pub(super) fn truncate_table_blocking(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<u64, AppError> {
    // Existence + schema validation, identical message vocabulary to update.
    table_meta_blocking(conn, schema, table)?;

    let qualified = format!("{}.{}", quote_ident(schema), quote_ident(table));
    let delete_sql = format!("DELETE FROM {qualified}");

    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;
    let affected = match conn.execute(&delete_sql, []) {
        Ok(affected) => affected as u64,
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(map_query_error(conn, err));
        }
    };
    conn.execute_batch("COMMIT")
        .map_err(|err| map_query_error(conn, err))?;
    Ok(affected)
}

/// Drop every user table in `schema`, leaving an empty schema (M15 drop-schema).
///
/// SQLite has no droppable schema or database — `main` IS the file, and we must
/// never delete the file. So "drop schema" is defined as dropping every
/// non-`sqlite_%` table in the schema, inside one `BEGIN`/`COMMIT` transaction
/// (all-or-nothing: any failure rolls back, leaving the schema untouched). The
/// schema must be one of the connection's databases (main/attached) — a §5
/// "does not exist" error otherwise.
///
/// `PRAGMA defer_foreign_keys = ON` for the transaction so the drop order does
/// not matter: foreign-key checks are deferred to COMMIT, and since every table
/// is gone by then there is nothing left to violate. The pragma resets at the
/// transaction's end.
pub(super) fn drop_schema_blocking(conn: &Connection, schema: &str) -> Result<(), AppError> {
    ensure_schema_exists(conn, schema)?;

    let quoted_schema = quote_ident(schema);
    let names: Vec<String> = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT name FROM {quoted_schema}.sqlite_schema \
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ))
            .map_err(|err| map_query_error(conn, err))?;
        stmt.query_map([], |row| row.get::<_, String>(0))
            .and_then(Iterator::collect::<Result<Vec<String>, _>>)
            .map_err(|err| map_query_error(conn, err))?
    };

    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;

    let run = || -> Result<(), AppError> {
        // Defer FK checks so drop order is irrelevant; everything is gone by COMMIT.
        conn.execute_batch("PRAGMA defer_foreign_keys = ON")
            .map_err(|err| map_query_error(conn, err))?;
        for name in &names {
            let drop_sql = format!("DROP TABLE {quoted_schema}.{}", quote_ident(name));
            conn.execute(&drop_sql, [])
                .map_err(|err| map_query_error(conn, err))?;
        }
        Ok(())
    };

    match run() {
        Ok(()) => {
            conn.execute_batch("COMMIT")
                .map_err(|err| map_query_error(conn, err))?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

/// Run a whole multi-statement SQL script (a dump) into the connection (M15
/// import). The script is wrapped in `BEGIN`/`COMMIT` so the import is atomic:
/// any error rolls back, leaving no half-created tables. `execute_batch` runs
/// every `;`-separated statement in one call.
///
/// Schema note: SQLite has no "current schema" beyond `main` + attached
/// databases, so the `schema` argument cannot redirect unqualified `CREATE`s —
/// they land in `main`. Importing into a specific attached schema requires the
/// script itself to qualify names (out of scope, M15). We surface a §5 error
/// when the caller targets a schema that is not `main` and is not an attached
/// database, so the limitation fails loudly rather than silently writing to
/// `main`.
pub(super) fn execute_script_blocking(
    conn: &Connection,
    schema: &str,
    sql: &str,
) -> Result<ImportResult, AppError> {
    // The schema must be one of the connection's databases (main/attached). We
    // cannot make unqualified statements target it, but rejecting an unknown
    // schema keeps the same vocabulary as the rest of the adapter.
    ensure_schema_exists(conn, schema)?;
    if schema != "main" {
        return Err(AppError::Unsupported(format!(
            "SQLite imports run into 'main'; importing into the attached schema \
             '{schema}' requires the script to qualify table names (e.g. \
             CREATE TABLE \"{schema}\".\"…\"). Re-run the import there, or qualify \
             the names in the .sql."
        )));
    }

    let statements = count_statements(sql);

    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch("BEGIN")
        .map_err(|err| map_query_error(conn, err))?;
    if let Err(err) = conn.execute_batch(sql) {
        // Roll back so a partial dump leaves the database untouched.
        let _ = conn.execute_batch("ROLLBACK");
        return Err(map_query_error(conn, err));
    }
    conn.execute_batch("COMMIT")
        .map_err(|err| map_query_error(conn, err))?;

    Ok(ImportResult { statements })
}

/// The §5 "no row matched" error shared by the null-pk short-circuit and the
/// affected-count-zero case.
fn no_row_matched_error() -> AppError {
    AppError::Database(
        "No row matched (it may have been deleted or changed since you loaded it).".to_string(),
    )
}

/// Enforce the full-primary-key policy for an [`UpdateCellRequest`]: the `pk`
/// predicate columns must be exactly the table's real primary-key columns.
///
/// Rejected (all §5 errors): a table with NO primary key; a predicate naming a
/// non-pk (or unknown) column; a partial pk (some pk column missing); a
/// duplicate pk column in the predicates. This guarantees the WHERE clause
/// targets at most one row — the mass-update prevention the editor relies on.
fn validate_pk_predicates(
    meta: &TableMeta,
    table: &str,
    predicates: &[PkPredicate],
) -> Result<(), AppError> {
    let pk_columns: Vec<&str> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.as_str())
        .collect();

    if pk_columns.is_empty() {
        return Err(AppError::Database(format!(
            "Cannot update '{table}': it has no primary key, so a single row \
             cannot be safely targeted."
        )));
    }

    if predicates.is_empty() {
        return Err(AppError::Database(format!(
            "Updating a cell in '{table}' requires the full primary key \
             ({}).",
            pk_columns.join(", ")
        )));
    }

    // Every predicate must name a real pk column, with no duplicates.
    let mut seen: Vec<&str> = Vec::with_capacity(predicates.len());
    for predicate in predicates {
        let column = predicate.column.as_str();
        if !pk_columns.contains(&column) {
            // Distinguish "exists but not pk" from "unknown column" for a
            // clearer message; both are §5 errors.
            if meta.columns.iter().any(|c| c.name == column) {
                return Err(AppError::Database(format!(
                    "Column '{column}' is not part of the primary key of '{table}' \
                     (primary key: {}); an update must target the row by its primary key.",
                    pk_columns.join(", ")
                )));
            }
            return Err(validate_column(meta, table, column).expect_err("unknown pk column"));
        }
        if seen.contains(&column) {
            return Err(AppError::Database(format!(
                "Primary-key column '{column}' is given more than once in the update."
            )));
        }
        seen.push(column);
    }

    // And the predicate set must COVER the whole pk — no missing pk column.
    if let Some(missing) = pk_columns.iter().find(|c| !seen.contains(c)) {
        return Err(AppError::Database(format!(
            "Updating a cell in '{table}' requires the full primary key \
             ({}); '{missing}' is missing.",
            pk_columns.join(", ")
        )));
    }

    Ok(())
}

/// Render a human-readable, values-inlined UPDATE for the §3.5 toast. Cosmetic
/// only — the executed query binds every value (see [`UpdateResult`]); this
/// shows what the bound query does, with identifiers quoted and values rendered
/// as SQL literals so the toast reads naturally.
fn display_update_statement(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::sqlite::test_support::*;
    use crate::engines::sqlite::SqliteConnector;

    use rusqlite::Connection;

    use super::super::error::value_to_json;

    // -- update_cell (M11 inline edit) -------------------------------------
    //
    // These drive `update_cell_blocking` directly against an in-memory
    // connection (the structure.rs convention) so the SQL behaviour and the
    // affected-count / pk guards are observable without IPC.

    /// An in-memory connection seeded with the given SQL batch.
    fn mem_db(setup: &str) -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(setup).expect("seed db");
        conn
    }

    fn pk(column: &str, value: serde_json::Value) -> PkPredicate {
        PkPredicate {
            column: column.into(),
            value,
            binary: false,
        }
    }

    fn update_req(
        table: &str,
        column: &str,
        value: serde_json::Value,
        pk: Vec<PkPredicate>,
    ) -> UpdateCellRequest {
        UpdateCellRequest {
            schema: "main".into(),
            table: table.into(),
            column: column.into(),
            value,
            pk,
            binary: false,
        }
    }

    /// Read one cell back as JSON for verification (via `value_to_json`, so it
    /// matches what the grid would see).
    fn cell(conn: &Connection, sql: &str) -> serde_json::Value {
        conn.query_row(sql, [], |row| Ok(value_to_json(row.get_ref(0)?)))
            .expect("read cell")
    }

    #[test]
    fn update_text_cell_persists_and_reports_one_affected() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL); \
             INSERT INTO users VALUES (1, 'ada'), (2, 'grace');",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("Ada L"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update");
        assert_eq!(result.affected, 1);
        // Cosmetic statement reads as a sane, values-inlined UPDATE.
        assert_eq!(
            result.statement,
            r#"UPDATE "main"."users" SET "name" = 'Ada L' WHERE "id" = 1"#
        );
        // Value persisted; the other row is untouched.
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("Ada L")
        );
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 2"),
            serde_json::json!("grace")
        );
    }

    #[test]
    fn update_number_cell_persists() {
        let conn = mem_db(
            "CREATE TABLE products (id INTEGER PRIMARY KEY, price REAL); \
             INSERT INTO products VALUES (1, 1.5);",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "products",
                "price",
                serde_json::json!(9.99),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update");
        assert_eq!(result.affected, 1);
        assert_eq!(
            cell(&conn, "SELECT price FROM products WHERE id = 1"),
            serde_json::json!(9.99)
        );
    }

    #[test]
    fn update_to_null_on_nullable_column_persists_null() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, score REAL); \
             INSERT INTO users VALUES (1, 9.5);",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "score",
                serde_json::Value::Null,
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update to null");
        assert_eq!(result.affected, 1);
        assert_eq!(
            result.statement,
            r#"UPDATE "main"."users" SET "score" = NULL WHERE "id" = 1"#
        );
        // Stored as a real SQL NULL.
        assert_eq!(
            cell(&conn, "SELECT score FROM users WHERE id = 1"),
            serde_json::Value::Null
        );
        let nulls: i64 = conn
            .query_row("SELECT count(*) FROM users WHERE score IS NULL", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(nulls, 1);
    }

    #[test]
    fn update_composite_pk_targets_the_one_row() {
        let conn = mem_db(
            "CREATE TABLE t (a INTEGER, b TEXT, val TEXT, PRIMARY KEY (a, b)); \
             INSERT INTO t VALUES (1, 'x', 'old1'), (1, 'y', 'old2'), (2, 'x', 'old3');",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "t",
                "val",
                serde_json::json!("new"),
                vec![
                    pk("a", serde_json::json!(1)),
                    pk("b", serde_json::json!("x")),
                ],
            ),
        )
        .expect("composite update");
        assert_eq!(result.affected, 1);
        // Only (1,'x') changed; the others are untouched.
        assert_eq!(
            cell(&conn, "SELECT val FROM t WHERE a = 1 AND b = 'x'"),
            serde_json::json!("new")
        );
        assert_eq!(
            cell(&conn, "SELECT val FROM t WHERE a = 1 AND b = 'y'"),
            serde_json::json!("old2")
        );
        assert_eq!(
            cell(&conn, "SELECT val FROM t WHERE a = 2 AND b = 'x'"),
            serde_json::json!("old3")
        );
    }

    #[test]
    fn update_composite_pk_partial_pk_is_rejected() {
        let conn = mem_db(
            "CREATE TABLE t (a INTEGER, b TEXT, val TEXT, PRIMARY KEY (a, b)); \
             INSERT INTO t VALUES (1, 'x', 'old');",
        );
        // Only one of the two pk columns given → partial pk → §5 error.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "t",
                "val",
                serde_json::json!("new"),
                vec![pk("a", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("full primary key"), "got {err}");
        assert!(err.to_string().contains("'b' is missing"), "got {err}");
        // Table unchanged.
        assert_eq!(
            cell(&conn, "SELECT val FROM t WHERE a = 1 AND b = 'x'"),
            serde_json::json!("old")
        );
    }

    #[test]
    fn update_on_table_with_no_pk_is_rejected() {
        let conn = mem_db(
            "CREATE TABLE logs (msg TEXT, level TEXT); \
             INSERT INTO logs VALUES ('hi', 'info');",
        );
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "logs",
                "msg",
                serde_json::json!("bye"),
                vec![pk("rowid", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("no primary key"), "got {err}");
        // Table unchanged.
        assert_eq!(cell(&conn, "SELECT msg FROM logs"), serde_json::json!("hi"));
    }

    #[test]
    fn update_pk_predicate_on_non_pk_column_is_rejected() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT); \
             INSERT INTO users VALUES (1, 'ada', 'a@b');",
        );
        // 'email' is a real column but not the pk → reject (must target by pk).
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("x"),
                vec![pk("email", serde_json::json!("a@b"))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(
            err.to_string().contains("not part of the primary key"),
            "got {err}"
        );
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("ada")
        );
    }

    #[test]
    fn update_unknown_pk_column_is_a_human_error() {
        let conn = mem_db("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("x"),
                vec![pk("ghost", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("does not exist"), "got {err}");
    }

    #[test]
    fn update_stale_pk_matches_no_row() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); \
             INSERT INTO users VALUES (1, 'ada');",
        );
        // id 999 does not exist → affected 0 → §5 "no row matched".
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("x"),
                vec![pk("id", serde_json::json!(999))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("No row matched"), "got {err}");
        // Existing row untouched.
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("ada")
        );
    }

    #[test]
    fn update_null_pk_value_matches_no_row() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); \
             INSERT INTO users VALUES (1, 'ada');",
        );
        // A null pk value can never match `= NULL` — short-circuits to "no row".
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("x"),
                vec![pk("id", serde_json::Value::Null)],
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("No row matched"), "got {err}");
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("ada")
        );
    }

    #[test]
    fn update_binds_injection_payload_as_a_literal() {
        let conn = mem_db(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); \
             INSERT INTO t VALUES (1, 'safe'), (2, 'other');",
        );
        let payload = "'; DROP TABLE t; --";
        let result = update_cell_blocking(
            &conn,
            // Both the new value AND a pk value carry injection text. The pk
            // value won't match row 1, so target row 1 by its real id and put
            // the payload only in the new value to assert the literal store; a
            // second call exercises an injection pk value matching nothing.
            &update_req(
                "t",
                "name",
                serde_json::json!(payload),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update with injection payload");
        assert_eq!(result.affected, 1);
        // The table still exists and only row 1's cell holds the literal string.
        assert_eq!(
            cell(&conn, "SELECT name FROM t WHERE id = 1"),
            serde_json::json!(payload)
        );
        assert_eq!(
            cell(&conn, "SELECT name FROM t WHERE id = 2"),
            serde_json::json!("other")
        );
        let count: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "table survived — payload was not executed");

        // An injection string as the PK value binds as a literal that matches
        // nothing (it is not a real id), and the table is untouched.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "t",
                "name",
                serde_json::json!("x"),
                vec![pk("id", serde_json::json!("1; DROP TABLE t; --"))],
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("No row matched"), "got {err}");
        let count: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "table survived the pk injection payload");
    }

    #[test]
    fn update_unknown_column_table_schema_are_human_errors() {
        let conn = mem_db("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
        // Unknown column.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "ghost",
                serde_json::json!("x"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("Column 'ghost' does not exist"),
            "got {err}"
        );
        // Unknown table.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "ghosts",
                "name",
                serde_json::json!("x"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("Table 'ghosts' does not exist"),
            "got {err}"
        );
        // Unknown schema.
        let err = update_cell_blocking(
            &conn,
            &UpdateCellRequest {
                schema: "warehouse".into(),
                ..update_req(
                    "users",
                    "name",
                    serde_json::json!("x"),
                    vec![pk("id", serde_json::json!(1))],
                )
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("Schema 'warehouse'"), "got {err}");
    }

    #[test]
    fn update_not_null_violation_rolls_back_and_leaves_row_unchanged() {
        let conn = mem_db(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL); \
             INSERT INTO users VALUES (1, 'ada');",
        );
        // Setting a NOT NULL column to NULL fails the constraint → §5 error,
        // transaction rolls back, the row keeps its old value.
        let err = update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::Value::Null,
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("ada")
        );
        // And a subsequent valid update still works (the connection isn't stuck
        // in a half-open transaction after the rollback).
        update_cell_blocking(
            &conn,
            &update_req(
                "users",
                "name",
                serde_json::json!("grace"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update after rollback");
        assert_eq!(
            cell(&conn, "SELECT name FROM users WHERE id = 1"),
            serde_json::json!("grace")
        );
    }

    #[test]
    fn update_statement_quotes_identifiers_and_doubles_quotes_in_string_literals() {
        let conn = mem_db(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT); \
             INSERT INTO t VALUES (1, 'x');",
        );
        let result = update_cell_blocking(
            &conn,
            &update_req(
                "t",
                "note",
                serde_json::json!("O'Brien"),
                vec![pk("id", serde_json::json!(1))],
            ),
        )
        .expect("update");
        // The cosmetic statement doubles the single quote so it is itself valid
        // display SQL; the executed query bound the value (the cell is exact).
        assert_eq!(
            result.statement,
            r#"UPDATE "main"."t" SET "note" = 'O''Brien' WHERE "id" = 1"#
        );
        assert_eq!(
            cell(&conn, "SELECT note FROM t WHERE id = 1"),
            serde_json::json!("O'Brien")
        );
    }

    #[tokio::test]
    async fn truncate_empties_a_table_and_reports_prior_count() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        // users has 3 rows.
        let affected = conn
            .truncate_table("main", "users")
            .await
            .expect("truncate");
        assert_eq!(affected, 3);
        let page = conn
            .fetch_rows(FetchRowsRequest {
                schema: "main".into(),
                table: "users".into(),
                sort: None,
                filter: None,
                offset: 0,
                limit: 100,
            })
            .await
            .expect("fetch after truncate");
        assert_eq!(page.total_rows, Some(0));
        assert!(page.rows.is_empty());
    }

    #[tokio::test]
    async fn truncate_empty_table_is_zero() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        // orders is created empty.
        let affected = conn
            .truncate_table("main", "orders")
            .await
            .expect("truncate");
        assert_eq!(affected, 0);
    }

    #[tokio::test]
    async fn truncate_unknown_table_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.truncate_table("main", "ghost").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));
    }

    // ---- M15 drop-schema (drop every user table; the file IS the schema) ----

    #[tokio::test]
    async fn drop_schema_drops_every_user_table_and_keeps_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("fixture.db");
        create_fixture_db(&path); // users (3 rows) + orders
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open fixture db")
            .into_sql()
            .expect("sql connection");

        // Two user tables before.
        let before = conn.list_tables("main").await.expect("list before");
        assert_eq!(before.len(), 2);

        conn.drop_schema("main").await.expect("drop schema");

        // Zero user tables after — but the schema (and file) still exist.
        let after = conn.list_tables("main").await.expect("list after");
        assert!(after.is_empty(), "schema must be emptied, got {after:?}");
        assert!(path.exists(), "the database file must NOT be deleted");

        // The empty schema is reusable: a fresh CREATE works.
        conn.run_query(
            "CREATE TABLE again (id INTEGER PRIMARY KEY)",
            QueryOptions::default(),
        )
        .await
        .expect("recreate a table in the emptied schema");
        let reborn = conn.list_tables("main").await.expect("list reborn");
        assert_eq!(reborn.len(), 1);
    }

    #[tokio::test]
    async fn drop_schema_handles_foreign_keys_regardless_of_order() {
        // FK parent/child: deferring FK checks lets us drop in any order without
        // a constraint violation, leaving an empty schema.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("fk.db");
        {
            let raw = Connection::open(&path).expect("create db");
            raw.execute_batch(
                "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                 CREATE TABLE books (
                     id INTEGER PRIMARY KEY,
                     author_id INTEGER NOT NULL REFERENCES authors(id)
                 );
                 INSERT INTO authors (id, name) VALUES (1, 'ada');
                 INSERT INTO books (id, author_id) VALUES (10, 1);",
            )
            .expect("seed fk db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open fk db")
            .into_sql()
            .expect("sql connection");

        conn.drop_schema("main")
            .await
            .expect("drop schema with FKs");
        let after = conn.list_tables("main").await.expect("list after");
        assert!(after.is_empty(), "all tables dropped, got {after:?}");
    }

    #[tokio::test]
    async fn drop_schema_on_an_empty_schema_is_a_no_op() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("empty.db");
        {
            let raw = Connection::open(&path).expect("create db");
            raw.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);")
                .expect("seed");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        conn.drop_schema("main").await.expect("first drop");
        // Dropping an already-empty schema succeeds (nothing to drop).
        conn.drop_schema("main")
            .await
            .expect("second drop is a no-op");
        assert!(conn.list_tables("main").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn drop_schema_unknown_schema_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.drop_schema("ghost").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(err.to_string().contains("does not exist"));
    }
}
