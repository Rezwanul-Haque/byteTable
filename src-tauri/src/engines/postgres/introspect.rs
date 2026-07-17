//! Postgres introspection: schemas, tables, columns, indexes, foreign keys,
//! comments and assembled DDL. Mirrors the `ports::sql::meta` contract.

use sqlx::postgres::PgPool;
use sqlx::Row;

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::map_query_error;
use super::sql::{qualified, quote_ident};

/// Extracted from the `EngineConnection` impl (canonical layout: the impl
/// delegates; the SQL lives in the concern module).
pub(super) async fn list_schemas(pool: &PgPool) -> Result<Vec<SchemaInfo>, AppError> {
    // User schemas only (system schemas excluded), each with a cheap table
    // count from the catalog.
    let rows = sqlx::query(
        "SELECT n.nspname AS name, \
            count(c.oid) FILTER (WHERE c.relkind = 'r') AS table_count \
         FROM pg_namespace n \
         LEFT JOIN pg_class c ON c.relnamespace = n.oid \
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
           AND n.nspname NOT LIKE 'pg_toast%' \
           AND n.nspname NOT LIKE 'pg_temp%' \
           AND n.nspname NOT LIKE 'pg_toast_temp%' \
         GROUP BY n.nspname \
         ORDER BY n.nspname",
    )
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

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
pub(super) async fn list_tables(pool: &PgPool, schema: &str) -> Result<Vec<TableInfo>, AppError> {
    ensure_schema_exists(pool, schema).await?;
    // Base tables in the schema, with the planner's row ESTIMATE
    // (reltuples). A never-analyzed table reports -1 → None (module docs).
    let rows = sqlx::query(
        "SELECT c.relname AS name, c.reltuples::bigint AS est \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind = 'r' \
         ORDER BY c.relname",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let name: String = row.get("name");
            let est: i64 = row.try_get("est").unwrap_or(-1);
            TableInfo {
                name,
                approx_row_count: if est < 0 { None } else { Some(est as u64) },
            }
        })
        .collect())
}

/// §5 "Schema 'x' does not exist…" unless `schema` is a user schema.
pub(super) async fn ensure_schema_exists(pool: &PgPool, schema: &str) -> Result<(), AppError> {
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM pg_namespace WHERE nspname = $1")
        .bind(schema)
        .fetch_optional(pool)
        .await
        .map_err(map_query_error)?;
    if exists.is_some() {
        return Ok(());
    }
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT nspname FROM pg_namespace \
         WHERE nspname NOT IN ('pg_catalog', 'information_schema') \
           AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' \
         ORDER BY nspname",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
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
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<TableMeta, AppError> {
    ensure_schema_exists(pool, schema).await?;

    // Existence: a base table or view in the schema. (We surface the §5 missing
    // message with the available-tables listing, like the SQLite adapter.)
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'v', 'm', 'p')",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(map_query_error)?;
    if exists.is_none() {
        return Err(missing_table_error(pool, schema, table).await);
    }

    let pk_columns = primary_key_columns(pool, schema, table).await?;
    let foreign_keys = foreign_keys(pool, schema, table).await?;
    let fk_by_column = fk_by_first_column(&foreign_keys);

    // Columns from information_schema.columns; udt_name carries the canonical
    // type (int4/int8/bool/numeric/_text/jsonb/…) we use for numeric detection.
    let col_rows = sqlx::query(
        "SELECT column_name, data_type, udt_name, is_nullable, column_default \
         FROM information_schema.columns \
         WHERE table_schema = $1 AND table_name = $2 \
         ORDER BY ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    let mut columns = Vec::with_capacity(col_rows.len());
    let mut udt_by_name = std::collections::HashMap::new();
    for row in &col_rows {
        let name: String = row.get("column_name");
        let data_type: String = row.get("data_type");
        let udt_name: String = row.get("udt_name");
        let is_nullable: String = row.get("is_nullable");
        let default_value: Option<String> = row.try_get("column_default").unwrap_or(None);
        udt_by_name.insert(name.clone(), udt_name.clone());
        columns.push(ColumnInfo {
            fk: fk_by_column.get(&name).cloned(),
            pk: pk_columns.iter().any(|c| c == &name),
            name,
            // Display `data_type` (information_schema's readable form, e.g.
            // "integer", "timestamp with time zone"). For ARRAY columns
            // data_type is just "ARRAY"; prefer the udt_name (e.g. "_text").
            data_type: if data_type == "ARRAY" {
                udt_name
            } else {
                data_type
            },
            nullable: is_nullable.eq_ignore_ascii_case("YES"),
            default_value,
        });
    }

    let indexes = table_indexes(pool, schema, table).await?;
    let referenced_by = inbound_foreign_keys(pool, schema, table).await?;
    let comment = table_comment(pool, schema, table).await?;
    let ddl = Some(assemble_ddl(
        schema,
        table,
        &columns,
        &pk_columns,
        &foreign_keys,
    ));

    Ok(TableMeta {
        columns,
        comment,
        indexes,
        foreign_keys,
        referenced_by,
        ddl,
    })
}

/// Primary-key column names, in key order.
pub(super) async fn primary_key_columns(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, AppError> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname \
         FROM pg_index i \
         JOIN pg_class c ON c.oid = i.indrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey) \
         WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary \
         ORDER BY array_position(i.indkey, a.attnum)",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;
    Ok(names)
}

/// Outbound foreign keys, grouped per constraint with ordered column lists and
/// on_delete/on_update actions decoded from confdeltype/confupdtype.
pub(super) async fn foreign_keys(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT con.conname AS name, \
            con.confdeltype::text AS on_delete, con.confupdtype::text AS on_update, \
            cl.relname AS ref_table, \
            (SELECT array_agg(att.attname ORDER BY u.ord) \
             FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord) \
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum) AS cols, \
            (SELECT array_agg(att.attname ORDER BY u.ord) \
             FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ord) \
             JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.attnum) AS ref_cols \
         FROM pg_constraint con \
         JOIN pg_class c ON c.oid = con.conrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_class cl ON cl.oid = con.confrelid \
         WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f' \
         ORDER BY con.conname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let name: String = row.get("name");
            let cols: Vec<String> = row.try_get("cols").unwrap_or_default();
            let ref_cols: Vec<String> = row.try_get("ref_cols").unwrap_or_default();
            let ref_table: String = row.get("ref_table");
            let on_delete: String = row.get("on_delete");
            let on_update: String = row.get("on_update");
            ForeignKeyInfo {
                name: Some(name),
                columns: cols,
                ref_table,
                ref_columns: ref_cols,
                on_delete: Some(fk_action(&on_delete)),
                on_update: Some(fk_action(&on_update)),
            }
        })
        .collect())
}

/// Decode a `pg_constraint.confdeltype` / `confupdtype` action char.
pub(super) fn fk_action(code: &str) -> String {
    match code {
        "a" => "NO ACTION",
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .to_string()
}

/// Per-column fk map for `ColumnInfo.fk` (sidebar icon): the first fk a column
/// participates in, target = the parallel referenced column.
pub(super) fn fk_by_column(
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

/// Alias kept readable at the call site.
pub(super) fn fk_by_first_column(
    foreign_keys: &[ForeignKeyInfo],
) -> std::collections::HashMap<String, FkRef> {
    fk_by_column(foreign_keys)
}

/// Indexes on the table (name, member columns in order, unique, primary).
pub(super) async fn table_indexes(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT ic.relname AS name, idx.indisunique AS uniq, idx.indisprimary AS prim, \
            (SELECT array_agg(a.attname ORDER BY k.ord) \
             FROM unnest(idx.indkey) WITH ORDINALITY k(attnum, ord) \
             LEFT JOIN pg_attribute a ON a.attrelid = idx.indrelid AND a.attnum = k.attnum \
             WHERE a.attname IS NOT NULL) AS cols \
         FROM pg_index idx \
         JOIN pg_class tc ON tc.oid = idx.indrelid \
         JOIN pg_namespace n ON n.oid = tc.relnamespace \
         JOIN pg_class ic ON ic.oid = idx.indexrelid \
         WHERE n.nspname = $1 AND tc.relname = $2 \
         ORDER BY ic.relname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let name: String = row.get("name");
            let unique: bool = row.get("uniq");
            let primary: bool = row.get("prim");
            let columns: Vec<String> = row.try_get("cols").unwrap_or_default();
            IndexInfo {
                name,
                columns,
                unique,
                primary,
                // Postgres does not expose SQLite's c/u/pk origin code; mark the
                // primary-key index, leave the rest None.
                origin: if primary {
                    Some("pk".to_string())
                } else {
                    None
                },
            }
        })
        .collect())
}

/// Inbound foreign keys (§3.6 "referenced by"): constraints in the same schema
/// whose referenced table is this one.
pub(super) async fn inbound_foreign_keys(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<InboundFkInfo>, AppError> {
    let rows = sqlx::query(
        "SELECT child.relname AS child_table, con.confdeltype::text AS on_delete, \
            (SELECT array_agg(att.attname ORDER BY u.ord) \
             FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord) \
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum) AS cols, \
            (SELECT array_agg(att.attname ORDER BY u.ord) \
             FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ord) \
             JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.attnum) AS ref_cols \
         FROM pg_constraint con \
         JOIN pg_class parent ON parent.oid = con.confrelid \
         JOIN pg_namespace pn ON pn.oid = parent.relnamespace \
         JOIN pg_class child ON child.oid = con.conrelid \
         WHERE pn.nspname = $1 AND parent.relname = $2 AND con.contype = 'f' \
         ORDER BY child.relname, con.conname",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(map_query_error)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let child_table: String = row.get("child_table");
            let cols: Vec<String> = row.try_get("cols").unwrap_or_default();
            let ref_cols: Vec<String> = row.try_get("ref_cols").unwrap_or_default();
            let on_delete: String = row.get("on_delete");
            InboundFkInfo {
                table: child_table,
                columns: cols,
                ref_columns: ref_cols,
                on_delete: Some(fk_action(&on_delete)),
            }
        })
        .collect())
}

/// The table's comment (`COMMENT ON TABLE`), via `obj_description`.
pub(super) async fn table_comment(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Option<String>, AppError> {
    let comment: Option<String> = sqlx::query_scalar(
        "SELECT obj_description(c.oid) \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(map_query_error)?
    .flatten();
    Ok(comment.filter(|s| !s.is_empty()))
}

/// Assemble a reasonable, valid-ish `CREATE TABLE` from the catalog (module
/// docs: best-effort, not pg_dump-grade). Columns with type/nullability/default,
/// the primary key, and table-level foreign keys.
pub(super) fn assemble_ddl(
    schema: &str,
    table: &str,
    columns: &[ColumnInfo],
    pk_columns: &[String],
    foreign_keys: &[ForeignKeyInfo],
) -> String {
    let mut lines: Vec<String> = Vec::new();
    for col in columns {
        let mut line = format!("    {} {}", quote_ident(&col.name), col.data_type);
        if !col.nullable {
            line.push_str(" NOT NULL");
        }
        if let Some(default) = &col.default_value {
            line.push_str(&format!(" DEFAULT {default}"));
        }
        lines.push(line);
    }
    if !pk_columns.is_empty() {
        let cols = pk_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("    PRIMARY KEY ({cols})"));
    }
    for fk in foreign_keys {
        let cols = fk
            .columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let ref_cols = fk
            .ref_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let mut line = format!(
            "    FOREIGN KEY ({cols}) REFERENCES {} ({ref_cols})",
            quote_ident(&fk.ref_table)
        );
        if let Some(on_delete) = &fk.on_delete {
            if on_delete != "NO ACTION" {
                line.push_str(&format!(" ON DELETE {on_delete}"));
            }
        }
        if let Some(on_update) = &fk.on_update {
            if on_update != "NO ACTION" {
                line.push_str(&format!(" ON UPDATE {on_update}"));
            }
        }
        lines.push(line);
    }
    format!(
        "CREATE TABLE {} (\n{}\n);",
        qualified(schema, table),
        lines.join(",\n")
    )
}

/// §5 unknown-table message with the schema's available tables.
pub(super) async fn missing_table_error(pool: &PgPool, schema: &str, table: &str) -> AppError {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname",
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
    fn fk_action_decodes_constraint_chars() {
        assert_eq!(fk_action("c"), "CASCADE");
        assert_eq!(fk_action("n"), "SET NULL");
        assert_eq!(fk_action("a"), "NO ACTION");
        assert_eq!(fk_action("r"), "RESTRICT");
        assert_eq!(fk_action("d"), "SET DEFAULT");
        assert_eq!(fk_action("?"), "NO ACTION");
    }

    #[test]
    fn assemble_ddl_includes_columns_pk_and_fks() {
        let columns = vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "integer".into(),
                nullable: false,
                pk: true,
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "author_id".into(),
                data_type: "bigint".into(),
                nullable: false,
                pk: false,
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "price".into(),
                data_type: "numeric".into(),
                nullable: true,
                pk: false,
                default_value: Some("0.0".into()),
                fk: None,
            },
        ];
        let fks = vec![ForeignKeyInfo {
            name: Some("books_author_id_fkey".into()),
            columns: vec!["author_id".into()],
            ref_table: "authors".into(),
            ref_columns: vec!["id".into()],
            on_delete: Some("CASCADE".into()),
            on_update: Some("NO ACTION".into()),
        }];
        let ddl = assemble_ddl("bt", "books", &columns, &["id".to_string()], &fks);
        assert!(ddl.starts_with("CREATE TABLE \"bt\".\"books\" ("));
        assert!(ddl.contains("\"id\" integer NOT NULL"));
        assert!(ddl.contains("\"price\" numeric DEFAULT 0.0"));
        assert!(ddl.contains("PRIMARY KEY (\"id\")"));
        assert!(ddl.contains(
            "FOREIGN KEY (\"author_id\") REFERENCES \"authors\" (\"id\") ON DELETE CASCADE"
        ));
        // NO ACTION on_update is omitted (it is the default).
        assert!(!ddl.contains("ON UPDATE"));
    }
}
