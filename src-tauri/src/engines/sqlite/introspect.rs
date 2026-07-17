//! SQLite introspection: schemas, tables, columns, indexes, foreign keys and
//! table DDL. Mirrors the `ports::sql::meta` contract.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::shared::engine::*;
use crate::shared::error::AppError;

use super::error::{map_query_error, missing_table_error};
use super::sql::quote_ident;

/// Stop running per-table `count(*)` after this many tables; the rest get
/// `approx_row_count: None`. Keeps introspection bounded on huge schemas.
const MAX_COUNTED_TABLES: usize = 200;

pub(super) fn list_schemas_blocking(conn: &Connection) -> Result<Vec<SchemaInfo>, AppError> {
    let names = schema_names(conn)?;
    let mut schemas = Vec::with_capacity(names.len());
    for name in names {
        // Best effort: a count failure (e.g. detached race) downgrades to
        // None rather than failing the whole listing.
        let table_count = count_tables(conn, &name).ok();
        schemas.push(SchemaInfo { name, table_count });
    }
    Ok(schemas)
}

pub(super) fn schema_names(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare("PRAGMA database_list")
        .map_err(|err| map_query_error(conn, err))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    Ok(names)
}

fn count_tables(conn: &Connection, schema: &str) -> Result<u64, rusqlite::Error> {
    conn.query_row(
        &format!(
            "SELECT count(*) FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            quote_ident(schema)
        ),
        [],
        |row| row.get(0),
    )
}

/// Fail with the §5 "Schema 'x' does not exist…" message unless `schema` is
/// one of the connection's databases.
pub(super) fn ensure_schema_exists(conn: &Connection, schema: &str) -> Result<(), AppError> {
    let schemas = schema_names(conn)?;
    if schemas.iter().any(|s| s == schema) {
        Ok(())
    } else {
        Err(AppError::Database(format!(
            "Schema '{schema}' does not exist. Available schemas: {}.",
            schemas.join(", ")
        )))
    }
}

pub(super) fn list_tables_blocking(
    conn: &Connection,
    schema: &str,
) -> Result<Vec<TableInfo>, AppError> {
    ensure_schema_exists(conn, schema)?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT name FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            quote_ident(schema)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

    let mut tables = Vec::with_capacity(names.len());
    for (index, name) in names.into_iter().enumerate() {
        let approx_row_count = if index < MAX_COUNTED_TABLES {
            // Best effort: a failed count is None, not a failed listing.
            conn.query_row(
                &format!(
                    "SELECT count(*) FROM {}.{}",
                    quote_ident(schema),
                    quote_ident(&name)
                ),
                [],
                |row| row.get::<_, u64>(0),
            )
            .ok()
        } else {
            None
        };
        tables.push(TableInfo {
            name,
            approx_row_count,
        });
    }
    Ok(tables)
}

pub(super) fn table_meta_blocking(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<TableMeta, AppError> {
    ensure_schema_exists(conn, schema)?;

    // `PRAGMA table_info` returns zero rows for an unknown table instead of
    // erroring, so prove existence first to get the §5 message (see module
    // docs).
    // Accept views too (`type IN ('table','view')`): a view is queryable like a
    // table — Browse data on a view runs SELECT through this path, and
    // PRAGMA table_info returns a view's columns. (Indexes/FKs/DDL below are
    // simply empty for a view.)
    let exists: i64 = conn
        .query_row(
            &format!(
                "SELECT count(*) FROM {}.sqlite_schema \
                 WHERE type IN ('table', 'view') AND name = ?1",
                quote_ident(schema)
            ),
            [table],
            |row| row.get(0),
        )
        .map_err(|err| map_query_error(conn, err))?;
    if exists == 0 {
        return Err(missing_table_error(conn, table));
    }

    // Read the foreign_key_list once and derive both views from it: the
    // per-column map for `ColumnInfo.fk` (M3 sidebar) and the grouped
    // table-level list for §3.6.
    let fk_rows = foreign_key_rows(conn, schema, table)?;
    let mut fk_by_column = foreign_keys_by_column(conn, schema, &fk_rows);
    let foreign_keys = group_foreign_keys(&fk_rows);

    // table_info columns: cid(0), name(1), type(2), notnull(3),
    // dflt_value(4), pk(5). `pk` is the 1-based position within the primary
    // key (0 = not part); `dflt_value` is the DEFAULT expression as stored SQL
    // text (NULL = no default), surfaced as `ColumnInfo.default_value`.
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.table_info({})",
            quote_ident(schema),
            quote_ident(table)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                // dflt_value(4): the column's DEFAULT expression as stored SQL
                // text, NULL when the column has no default.
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;

    let columns: Vec<ColumnInfo> = rows
        .into_iter()
        .map(|(name, data_type, notnull, dflt_value, pk)| ColumnInfo {
            fk: fk_by_column.remove(&name),
            name,
            data_type,
            nullable: notnull == 0,
            pk: pk > 0,
            default_value: dflt_value,
        })
        .collect();
    drop(stmt);

    let indexes = table_indexes(conn, schema, table)?;
    let referenced_by = inbound_foreign_keys(conn, schema, table)?;
    let ddl = table_ddl(conn, schema, table)?;

    Ok(TableMeta {
        columns,
        // SQLite has no table comments (module docs).
        comment: None,
        indexes,
        foreign_keys,
        referenced_by,
        ddl,
    })
}

/// One raw row of `PRAGMA foreign_key_list`, the shared shape both the
/// per-column map and the grouped table-level list derive from.
struct FkRow {
    /// `id` groups rows of the same (possibly composite) constraint.
    id: i64,
    /// `seq` orders columns within one constraint.
    seq: i64,
    ref_table: String,
    /// Local (child) column.
    from: String,
    /// Referenced (parent) column; `None` for implicit `REFERENCES t`.
    to: Option<String>,
    on_delete: Option<String>,
    on_update: Option<String>,
}

/// Read every `PRAGMA foreign_key_list` row for `table`. Columns:
/// id(0), seq(1), table(2), from(3), to(4), on_update(5), on_delete(6),
/// match(7).
fn foreign_key_rows(conn: &Connection, schema: &str, table: &str) -> Result<Vec<FkRow>, AppError> {
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.foreign_key_list({})",
            quote_ident(schema),
            quote_ident(table)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(FkRow {
                id: row.get::<_, i64>(0)?,
                seq: row.get::<_, i64>(1)?,
                ref_table: row.get::<_, String>(2)?,
                from: row.get::<_, String>(3)?,
                to: row.get::<_, Option<String>>(4)?,
                on_update: blank_to_none(row.get::<_, Option<String>>(5)?),
                on_delete: blank_to_none(row.get::<_, Option<String>>(6)?),
            })
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    Ok(rows)
}

/// Treat an empty string the same as absent — SQLite reports `"NO ACTION"`
/// for the default, never an empty string, but be defensive about it.
fn blank_to_none(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}

/// Foreign keys of `table`, keyed by the local (from) column, for
/// `ColumnInfo.fk`. A column in several fks keeps the first one reported (see
/// module docs).
fn foreign_keys_by_column(
    conn: &Connection,
    schema: &str,
    rows: &[FkRow],
) -> HashMap<String, FkRef> {
    let mut by_column = HashMap::new();
    for row in rows {
        let column = match &row.to {
            Some(column) => column.clone(),
            // Implicit `REFERENCES t`: resolve to the referenced table's pk
            // (same schema — SQLite fks never cross databases).
            None => referenced_pk_column(conn, schema, &row.ref_table, row.seq.max(0) as usize),
        };
        by_column.entry(row.from.clone()).or_insert(FkRef {
            table: row.ref_table.clone(),
            column,
        });
    }
    by_column
}

/// Group `foreign_key_list` rows into one [`ForeignKeyInfo`] per constraint
/// (by `id`), columns ordered by `seq`. The implicit-target `to` is left as
/// the empty string here (the grouped list is the structure view; the
/// per-column map already resolves implicit targets to the parent pk).
fn group_foreign_keys(rows: &[FkRow]) -> Vec<ForeignKeyInfo> {
    // Preserve first-seen id order so the output is stable across runs.
    let mut order: Vec<i64> = Vec::new();
    let mut grouped: HashMap<i64, Vec<&FkRow>> = HashMap::new();
    for row in rows {
        grouped.entry(row.id).or_insert_with(|| {
            order.push(row.id);
            Vec::new()
        });
        grouped.get_mut(&row.id).expect("just inserted").push(row);
    }

    order
        .into_iter()
        .map(|id| {
            let mut members = grouped.remove(&id).expect("id from order");
            members.sort_by_key(|r| r.seq);
            let first = members[0];
            ForeignKeyInfo {
                // SQLite's foreign_key_list carries no constraint name.
                name: None,
                columns: members.iter().map(|r| r.from.clone()).collect(),
                ref_table: first.ref_table.clone(),
                ref_columns: members
                    .iter()
                    .map(|r| r.to.clone().unwrap_or_default())
                    .collect(),
                on_delete: first.on_delete.clone(),
                on_update: first.on_update.clone(),
            }
        })
        .collect()
}

/// Indexes on `table` (§3.6): `PRAGMA index_list` for name/unique/origin, then
/// `PRAGMA index_info` per index for the ordered member columns.
fn table_indexes(conn: &Connection, schema: &str, table: &str) -> Result<Vec<IndexInfo>, AppError> {
    // index_list columns: seq(0), name(1), unique(2), origin(3), partial(4).
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.index_list({})",
            quote_ident(schema),
            quote_ident(table)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let listed = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    drop(stmt);

    let mut indexes = Vec::with_capacity(listed.len());
    for (name, unique, origin) in listed {
        let columns = index_columns(conn, schema, &name)?;
        let primary = origin.as_deref() == Some("pk");
        indexes.push(IndexInfo {
            name,
            columns,
            unique: unique != 0,
            primary,
            origin,
        });
    }
    Ok(indexes)
}

/// The member columns of one index, ordered by `seqno`. Expression members
/// report a NULL column name and are skipped (module docs).
fn index_columns(conn: &Connection, schema: &str, index: &str) -> Result<Vec<String>, AppError> {
    // index_info columns: seqno(0), cid(1), name(2). name is NULL for an
    // expression / rowid member.
    let mut stmt = conn
        .prepare(&format!(
            "PRAGMA {}.index_info({})",
            quote_ident(schema),
            quote_ident(index)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let mut rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(2)?))
        })
        .and_then(Iterator::collect::<Result<Vec<_>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    rows.sort_by_key(|(seqno, _)| *seqno);
    Ok(rows.into_iter().filter_map(|(_, name)| name).collect())
}

/// Inbound foreign keys (§3.6 "referenced by"): scan every *other* user table
/// in the same schema and keep the constraints whose target is `table`,
/// grouped per constraint. Cost is one `foreign_key_list` pragma per other
/// table — cheap and deliberately unbounded (module docs).
fn inbound_foreign_keys(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<InboundFkInfo>, AppError> {
    let others = user_table_names(conn, schema)?;
    let mut inbound = Vec::new();
    for child in others {
        if child == table {
            continue;
        }
        let rows = foreign_key_rows(conn, schema, &child)?;
        for fk in group_foreign_keys(&rows) {
            if fk.ref_table == table {
                inbound.push(InboundFkInfo {
                    table: child.clone(),
                    columns: fk.columns,
                    ref_columns: fk.ref_columns,
                    on_delete: fk.on_delete,
                });
            }
        }
    }
    Ok(inbound)
}

/// User table names in one schema (excludes `sqlite_%`), ordered by name.
/// Reused by the referenced-by scan.
fn user_table_names(conn: &Connection, schema: &str) -> Result<Vec<String>, AppError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT name FROM {}.sqlite_schema \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            quote_ident(schema)
        ))
        .map_err(|err| map_query_error(conn, err))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(Iterator::collect::<Result<Vec<String>, _>>)
        .map_err(|err| map_query_error(conn, err))?;
    Ok(names)
}

/// The verbatim `CREATE TABLE` statement from `sqlite_schema`. `None` when the
/// stored SQL is NULL (existence is proven before this is called).
pub(super) fn table_ddl(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<Option<String>, AppError> {
    conn.query_row(
        &format!(
            "SELECT sql FROM {}.sqlite_schema WHERE type IN ('table', 'view') AND name = ?1",
            quote_ident(schema)
        ),
        [table],
        |row| row.get::<_, Option<String>>(0),
    )
    .map_err(|err| map_query_error(conn, err))
}

/// The referenced table's primary-key column at position `seq`, for
/// resolving implicit fk targets. Best effort: an unresolvable pk (missing
/// table, no declared pk) yields an empty string — an honest "unknown"
/// rather than a guessed "id" (see module docs).
fn referenced_pk_column(conn: &Connection, schema: &str, ref_table: &str, seq: usize) -> String {
    let sql = format!(
        "PRAGMA {}.table_info({})",
        quote_ident(schema),
        quote_ident(ref_table)
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return String::new();
    };
    let Ok(columns) = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
        })
        .and_then(Iterator::collect::<Result<Vec<(i64, String)>, _>>)
    else {
        return String::new();
    };
    let mut pk_columns: Vec<(i64, String)> =
        columns.into_iter().filter(|(pk, _)| *pk > 0).collect();
    pk_columns.sort_by_key(|(position, _)| *position);
    pk_columns
        .into_iter()
        .nth(seq)
        .map(|(_, name)| name)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::sqlite::test_support::*;
    use crate::engines::sqlite::SqliteConnector;

    #[tokio::test]
    async fn lists_main_schema_with_table_count() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let schemas = conn.list_schemas().await.expect("list schemas");
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0].name, "main");
        assert_eq!(schemas[0].table_count, Some(2));
    }

    #[tokio::test]
    async fn attached_databases_show_up_as_schemas() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;

        let aux_path = dir.path().join("aux.db");
        {
            let aux = Connection::open(&aux_path).expect("create aux db");
            aux.execute_batch("CREATE TABLE logs (id INTEGER PRIMARY KEY, line TEXT);")
                .expect("seed aux");
        }
        conn.run_query(
            &format!("ATTACH DATABASE '{}' AS aux", aux_path.display()),
            QueryOptions::default(),
        )
        .await
        .expect("attach");

        let schemas = conn.list_schemas().await.expect("list schemas");
        let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["main", "aux"]);

        let tables = conn.list_tables("aux").await.expect("list aux tables");
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "logs");
        assert_eq!(tables[0].approx_row_count, Some(0));
    }

    #[tokio::test]
    async fn lists_tables_with_row_counts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let tables = conn.list_tables("main").await.expect("list tables");
        let summary: Vec<(&str, Option<u64>)> = tables
            .iter()
            .map(|t| (t.name.as_str(), t.approx_row_count))
            .collect();
        assert_eq!(summary, vec![("orders", Some(0)), ("users", Some(3))]);
    }

    #[tokio::test]
    async fn unknown_schema_is_a_human_error_listing_available_schemas() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.list_tables("warehouse").await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Schema 'warehouse' does not exist. Available schemas: main."
        );
    }

    /// Open a db exercising every `table_meta` facet: explicit + implicit
    /// fk targets, composite pk, NOT NULL, untyped columns, a non-"id" pk
    /// on the implicitly referenced table.
    async fn open_meta_fixture(dir: &tempfile::TempDir) -> std::sync::Arc<dyn EngineConnection> {
        let path = dir.path().join("meta.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
                 CREATE TABLE series (series_code TEXT PRIMARY KEY, title TEXT);
                 CREATE TABLE books (
                     id INTEGER PRIMARY KEY,
                     title TEXT NOT NULL,
                     author_id INTEGER NOT NULL REFERENCES authors(id),
                     series_code TEXT REFERENCES series,
                     ghost_id INTEGER REFERENCES phantoms,
                     notes DEFAULT 'none'
                 );
                 CREATE TABLE order_items (
                     order_id INTEGER,
                     item_no INTEGER,
                     qty INTEGER NOT NULL,
                     PRIMARY KEY (order_id, item_no)
                 );",
            )
            .expect("seed db");
        }
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open meta fixture")
            .into_sql()
            .expect("sql connection")
    }

    #[tokio::test]
    async fn table_meta_reports_types_nullability_pk_and_fks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_meta_fixture(&dir).await;
        let meta = conn.table_meta("main", "books").await.expect("table meta");

        let expected = vec![
            ColumnInfo {
                name: "id".into(),
                data_type: "INTEGER".into(),
                // SQLite does not set `notnull` for bare PRIMARY KEY columns;
                // `nullable` reports the declared constraint (module docs).
                nullable: true,
                pk: true,
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "title".into(),
                data_type: "TEXT".into(),
                nullable: false,
                pk: false,
                default_value: None,
                fk: None,
            },
            ColumnInfo {
                name: "author_id".into(),
                data_type: "INTEGER".into(),
                nullable: false,
                pk: false,
                default_value: None,
                // Explicit target: REFERENCES authors(id).
                fk: Some(FkRef {
                    table: "authors".into(),
                    column: "id".into(),
                }),
            },
            ColumnInfo {
                name: "series_code".into(),
                data_type: "TEXT".into(),
                nullable: true,
                pk: false,
                default_value: None,
                // Implicit target (`REFERENCES series`): resolved to the
                // referenced table's pk, which is deliberately not "id".
                fk: Some(FkRef {
                    table: "series".into(),
                    column: "series_code".into(),
                }),
            },
            ColumnInfo {
                name: "ghost_id".into(),
                data_type: "INTEGER".into(),
                nullable: true,
                pk: false,
                default_value: None,
                // Implicit target on a table that does not exist: the table
                // name survives, the column falls back to "" (module docs).
                fk: Some(FkRef {
                    table: "phantoms".into(),
                    column: String::new(),
                }),
            },
            ColumnInfo {
                name: "notes".into(),
                // Untyped column: empty declared type, not a made-up one.
                data_type: String::new(),
                nullable: true,
                pk: false,
                // DEFAULT expression surfaced verbatim from dflt_value.
                default_value: Some("'none'".into()),
                fk: None,
            },
        ];
        assert_eq!(meta.columns, expected);
    }

    #[tokio::test]
    async fn table_meta_marks_every_member_of_a_composite_pk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_meta_fixture(&dir).await;
        let meta = conn
            .table_meta("main", "order_items")
            .await
            .expect("table meta");
        let flags: Vec<(&str, bool, bool)> = meta
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.pk, c.nullable))
            .collect();
        assert_eq!(
            flags,
            vec![
                ("order_id", true, true),
                ("item_no", true, true),
                ("qty", false, false),
            ]
        );
    }

    #[tokio::test]
    async fn table_meta_for_unknown_table_lists_available_tables() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.table_meta("main", "customers").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert_eq!(
            err.to_string(),
            "Table 'customers' does not exist. Available tables: orders, users."
        );
    }

    #[tokio::test]
    async fn table_meta_for_unknown_schema_is_a_human_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_fixture(&dir).await;
        let err = conn.table_meta("warehouse", "users").await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Schema 'warehouse' does not exist. Available schemas: main."
        );
    }

    // -- table_meta structure view (M7 §3.6) --------------------------------

    /// A fixture exercising the structure-view facets: a parent table
    /// referenced by two children (one composite fk with `ON DELETE`), single
    /// and composite secondary indexes (unique and non-unique), and the
    /// implicit primary-key index.
    async fn open_structure_fixture(
        dir: &tempfile::TempDir,
    ) -> std::sync::Arc<dyn EngineConnection> {
        let path = dir.path().join("structure.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE authors (
                     id INTEGER PRIMARY KEY,
                     country TEXT,
                     name TEXT NOT NULL
                 );
                 CREATE UNIQUE INDEX idx_authors_name ON authors(name);
                 CREATE INDEX idx_authors_country_name ON authors(country, name);

                 CREATE TABLE books (
                     id INTEGER PRIMARY KEY,
                     author_id INTEGER REFERENCES authors(id) ON DELETE CASCADE,
                     title TEXT
                 );

                 -- A second child of authors, with a composite fk back to it.
                 CREATE TABLE coauthored (
                     book_id INTEGER,
                     primary_author INTEGER,
                     secondary_author INTEGER,
                     PRIMARY KEY (book_id, primary_author),
                     FOREIGN KEY (primary_author, secondary_author)
                         REFERENCES author_pairs(lead, support) ON DELETE SET NULL
                 );

                 -- A table with a composite fk so we can assert grouping/order.
                 CREATE TABLE author_pairs (
                     lead INTEGER,
                     support INTEGER,
                     PRIMARY KEY (lead, support)
                 );",
            )
            .expect("seed db");
        }
        SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open structure fixture")
            .into_sql()
            .expect("sql connection")
    }

    #[tokio::test]
    async fn table_meta_reports_indexes_with_ordered_columns_and_flags() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;
        let meta = conn
            .table_meta("main", "authors")
            .await
            .expect("table meta");

        // `authors.id` is `INTEGER PRIMARY KEY` — an alias for the rowid, so
        // SQLite stores NO separate pk index for it (it lists nothing with
        // origin "pk"). The implicit pk index only materialises for a
        // *non-rowid* pk (composite / non-INTEGER) — asserted on author_pairs
        // below.
        assert!(
            !meta.indexes.iter().any(|i| i.primary),
            "an INTEGER PRIMARY KEY (rowid alias) has no separate pk index"
        );

        let pairs = conn
            .table_meta("main", "author_pairs")
            .await
            .expect("author_pairs meta");
        let pk = pairs
            .indexes
            .iter()
            .find(|i| i.primary)
            .expect("a composite pk has an implicit pk index");
        assert!(pk.unique, "the pk index is unique");
        assert_eq!(pk.origin.as_deref(), Some("pk"));
        assert_eq!(pk.columns, vec!["lead", "support"]);

        // The UNIQUE single-column index.
        let unique = meta
            .indexes
            .iter()
            .find(|i| i.name == "idx_authors_name")
            .expect("the unique index");
        assert!(unique.unique);
        assert!(!unique.primary);
        assert_eq!(unique.origin.as_deref(), Some("c"));
        assert_eq!(unique.columns, vec!["name"]);

        // The non-unique composite index keeps column order.
        let composite = meta
            .indexes
            .iter()
            .find(|i| i.name == "idx_authors_country_name")
            .expect("the composite index");
        assert!(!composite.unique);
        assert!(!composite.primary);
        assert_eq!(composite.columns, vec!["country", "name"]);
    }

    #[tokio::test]
    async fn table_meta_reports_table_level_foreign_keys_grouped_and_ordered() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;

        // Single-column fk with ON DELETE captured.
        let books = conn.table_meta("main", "books").await.expect("books meta");
        assert_eq!(books.foreign_keys.len(), 1);
        let fk = &books.foreign_keys[0];
        assert_eq!(fk.name, None, "SQLite fks have no name");
        assert_eq!(fk.columns, vec!["author_id"]);
        assert_eq!(fk.ref_table, "authors");
        assert_eq!(fk.ref_columns, vec!["id"]);
        assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));

        // Composite fk: a single grouped entry with parallel, ordered columns.
        let coauthored = conn
            .table_meta("main", "coauthored")
            .await
            .expect("coauthored meta");
        assert_eq!(
            coauthored.foreign_keys.len(),
            1,
            "the composite fk is one grouped entry"
        );
        let composite = &coauthored.foreign_keys[0];
        assert_eq!(
            composite.columns,
            vec!["primary_author", "secondary_author"]
        );
        assert_eq!(composite.ref_table, "author_pairs");
        assert_eq!(composite.ref_columns, vec!["lead", "support"]);
        assert_eq!(composite.on_delete.as_deref(), Some("SET NULL"));
    }

    #[tokio::test]
    async fn table_meta_reports_inbound_foreign_keys_from_every_child() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;

        // authors is referenced by `books` (author_id → id).
        let authors = conn
            .table_meta("main", "authors")
            .await
            .expect("authors meta");
        let inbound: Vec<&str> = authors
            .referenced_by
            .iter()
            .map(|f| f.table.as_str())
            .collect();
        assert_eq!(inbound, vec!["books"]);
        let from_books = &authors.referenced_by[0];
        assert_eq!(from_books.columns, vec!["author_id"]);
        assert_eq!(from_books.ref_columns, vec!["id"]);
        assert_eq!(from_books.on_delete.as_deref(), Some("CASCADE"));

        // author_pairs is referenced by `coauthored`'s composite fk.
        let pairs = conn
            .table_meta("main", "author_pairs")
            .await
            .expect("author_pairs meta");
        assert_eq!(pairs.referenced_by.len(), 1);
        let inbound = &pairs.referenced_by[0];
        assert_eq!(inbound.table, "coauthored");
        assert_eq!(inbound.columns, vec!["primary_author", "secondary_author"]);
        assert_eq!(inbound.ref_columns, vec!["lead", "support"]);
    }

    #[tokio::test]
    async fn table_meta_referenced_by_can_list_multiple_children() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("multi.db");
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE parent (id INTEGER PRIMARY KEY);
                 CREATE TABLE child_a (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id));
                 CREATE TABLE child_b (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id) ON DELETE CASCADE);",
            )
            .expect("seed db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        let parent = conn
            .table_meta("main", "parent")
            .await
            .expect("parent meta");
        let mut children: Vec<&str> = parent
            .referenced_by
            .iter()
            .map(|f| f.table.as_str())
            .collect();
        children.sort_unstable();
        assert_eq!(children, vec!["child_a", "child_b"]);
        for inbound in &parent.referenced_by {
            assert_eq!(inbound.columns, vec!["pid"]);
            assert_eq!(inbound.ref_columns, vec!["id"]);
        }
        // The cascade child carries its ON DELETE.
        let cascade = parent
            .referenced_by
            .iter()
            .find(|f| f.table == "child_b")
            .expect("child_b");
        assert_eq!(cascade.on_delete.as_deref(), Some("CASCADE"));
    }

    #[tokio::test]
    async fn table_meta_ddl_is_returned_verbatim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;
        let meta = conn.table_meta("main", "books").await.expect("books meta");
        let ddl = meta.ddl.expect("ddl is present");
        assert!(
            ddl.contains("CREATE TABLE"),
            "ddl should be the CREATE TABLE statement: {ddl:?}"
        );
        assert!(ddl.contains("author_id"), "ddl is verbatim: {ddl:?}");
    }

    #[tokio::test]
    async fn table_meta_comment_is_none_for_sqlite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;
        let meta = conn.table_meta("main", "books").await.expect("books meta");
        assert_eq!(meta.comment, None);
    }

    #[tokio::test]
    async fn table_meta_for_unknown_table_still_errors_with_structure_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_structure_fixture(&dir).await;
        let err = conn.table_meta("main", "ghosts").await.unwrap_err();
        assert!(matches!(err, AppError::Database(_)));
        assert!(
            err.to_string().contains("does not exist"),
            "unknown table is still a §5 error: {err}"
        );
    }

    #[tokio::test]
    async fn table_meta_handles_a_wide_64_column_table() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("wide.db");
        let column_defs: Vec<String> = (0..64).map(|i| format!("c{i} INTEGER")).collect();
        {
            let conn = Connection::open(&path).expect("create db");
            conn.execute_batch(&format!("CREATE TABLE wide ({});", column_defs.join(", ")))
                .expect("seed db");
        }
        let conn = SqliteConnector
            .open(&params_for(&path))
            .await
            .expect("open db")
            .into_sql()
            .expect("sql connection");
        let meta = conn.table_meta("main", "wide").await.expect("wide meta");
        assert_eq!(meta.columns.len(), 64, "all 64 columns are returned");
        let names: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names[0], "c0");
        assert_eq!(names[63], "c63");
        // A wide table with no constraints has no fks/indexes but valid ddl.
        assert!(meta.foreign_keys.is_empty());
        assert!(meta.referenced_by.is_empty());
        assert!(meta.ddl.expect("ddl").contains("CREATE TABLE"));
    }
}
