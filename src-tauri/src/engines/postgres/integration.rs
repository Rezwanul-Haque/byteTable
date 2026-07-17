//! Live-Postgres integration tests (gated behind `BYTETABLE_TEST_PG_URL`).

use super::*;

use crate::shared::engine::{
    Combinator, Condition, FilterOp, FilterSpec, FilterValue, PkPredicate, RowLookupRequest,
    SortDirection, SortSpec,
};

/// Parse `postgres://user:password@host:port/db` into params + the transient
/// secret. Minimal — handles the shape the M12 test container emits.
fn parse_url(url: &str) -> (ConnectionParams, Option<ConnectSecret>) {
    let rest = url
        .strip_prefix("postgres://")
        .or_else(|| url.strip_prefix("postgresql://"))
        .expect("url scheme");
    let (creds_host, db) = rest.split_once('/').expect("db path");
    let (creds, host_port) = creds_host.split_once('@').expect("@ separator");
    let (user, password) = match creds.split_once(':') {
        Some((u, p)) => (u.to_string(), Some(p.to_string())),
        None => (creds.to_string(), None),
    };
    let (host, port) = match host_port.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(5432)),
        None => (host_port.to_string(), 5432),
    };
    let params = ConnectionParams::Postgres {
        host,
        port,
        database: Some(db.to_string()),
        user: Some(user),
        tls_mode: crate::shared::engine::TlsMode::Disable,
        ssh: None,
    };
    (params, password.map(ConnectSecret::new))
}

/// The gate: `Some((params, secret))` when the env var is set, else `None`
/// after printing a skip notice.
fn gate(test: &str) -> Option<(ConnectionParams, Option<ConnectSecret>)> {
    match std::env::var("BYTETABLE_TEST_PG_URL") {
        Ok(url) if !url.is_empty() => Some(parse_url(&url)),
        _ => {
            eprintln!("SKIP {test}: BYTETABLE_TEST_PG_URL not set (live Postgres required)");
            None
        }
    }
}

/// Open a pool connection for fixture setup/teardown (raw sqlx), separate
/// from the adapter under test.
async fn raw_pool(params: &ConnectionParams, secret: &Option<ConnectSecret>) -> PgPool {
    let options =
        super::sql::connect_options(params, db_password(secret.as_ref()), None, None).unwrap();
    PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .expect("connect raw pool")
}

async fn open_conn(
    params: &ConnectionParams,
    secret: &Option<ConnectSecret>,
) -> std::sync::Arc<dyn EngineConnection> {
    PostgresConnector
        .open_with_secret(params, secret.as_ref())
        .await
        .expect("open postgres connection")
        .into_sql()
        .expect("sql connection")
}

/// Create a throwaway schema with a rich fixture: pk/fk/indexes, bool,
/// numeric, int8, text, null columns, plus a second schema. Drops first so
/// reruns are clean.
async fn setup_fixture(pool: &PgPool, schema: &str, other: &str) {
    for stmt in [
        format!("DROP SCHEMA IF EXISTS {schema} CASCADE"),
        format!("DROP SCHEMA IF EXISTS {other} CASCADE"),
        format!("CREATE SCHEMA {schema}"),
        format!("CREATE SCHEMA {other}"),
        format!(
            "CREATE TABLE {schema}.authors (\
               id bigint PRIMARY KEY, name text NOT NULL, bio text)"
        ),
        format!("COMMENT ON TABLE {schema}.authors IS 'people who write'"),
        format!(
            "CREATE TABLE {schema}.books (\
               id int PRIMARY KEY, \
               title text NOT NULL, \
               author_id bigint NOT NULL REFERENCES {schema}.authors(id) ON DELETE CASCADE, \
               price numeric(10,2) DEFAULT 0.0, \
               in_print boolean DEFAULT true, \
               big bigint, \
               note text)"
        ),
        format!("CREATE INDEX idx_books_title ON {schema}.books(title)"),
        format!("CREATE UNIQUE INDEX idx_books_author_title ON {schema}.books(author_id, title)"),
        // A table in the OTHER schema (multi-schema check).
        format!("CREATE TABLE {other}.tags (id int PRIMARY KEY, label text)"),
        // Seed data: authors.
        format!(
            "INSERT INTO {schema}.authors (id, name, bio) VALUES \
               (1, 'Ada', 'pioneer'), (2, 'Grace', NULL), (3, 'Linus', 'kernel')"
        ),
        // Seed data: books — bool true/false, numeric, big int8 (> 2^53),
        // a NULL note.
        format!(
            "INSERT INTO {schema}.books (id, title, author_id, price, in_print, big, note) VALUES \
               (10, 'Notes', 1, 9.50, true, 9007199254740993, 'first'), \
               (11, 'Essays', 1, 7.25, false, 1, NULL), \
               (12, 'Letters', 2, 0.00, true, 2, 'third'), \
               (13, 'Memoir', 3, 12.00, true, 3, 'fourth')"
        ),
    ] {
        sqlx::query(&stmt)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("fixture stmt failed: {stmt}\n{e}"));
    }
}

async fn drop_fixture(pool: &PgPool, schema: &str, other: &str) {
    let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
        .execute(pool)
        .await;
    let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {other} CASCADE"))
        .execute(pool)
        .await;
}

#[tokio::test]
async fn connect_and_server_version() {
    let Some((params, secret)) = gate("connect_and_server_version") else {
        return;
    };
    let info = PostgresConnector
        .test_with_secret(&params, secret.as_ref())
        .await
        .expect("test connection");
    assert_eq!(info.engine, Engine::Postgres);
    assert!(
        info.server_version.starts_with("PostgreSQL "),
        "got {:?}",
        info.server_version
    );
    // A wrong password is a §5 database error, not a panic.
    let bad = PostgresConnector
        .test_with_secret(&params, Some(&ConnectSecret::new("definitely-wrong")))
        .await;
    assert!(matches!(bad, Err(AppError::Database(_))));
}

#[tokio::test]
async fn schemas_tables_and_counts() {
    let Some((params, secret)) = gate("schemas_tables_and_counts") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_lists", "bt_it_lists_other");
    setup_fixture(&pool, schema, other).await;
    // ANALYZE so reltuples is populated (else -1 → None).
    let _ = sqlx::query(&format!("ANALYZE {schema}.books"))
        .execute(&pool)
        .await;

    let conn = open_conn(&params, &secret).await;

    let schemas = conn.list_schemas().await.expect("list schemas");
    let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&schema), "user schema present: {names:?}");
    assert!(names.contains(&other), "second schema present");
    assert!(names.contains(&"public"), "public present");
    // System schemas excluded.
    assert!(!names.iter().any(|n| n.starts_with("pg_")));
    assert!(!names.contains(&"information_schema"));

    let tables = conn.list_tables(schema).await.expect("list tables");
    let tnames: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(tnames, vec!["authors", "books"]);
    // The count is an estimate; after ANALYZE it should be Some(4) for books.
    let books = tables.iter().find(|t| t.name == "books").unwrap();
    assert_eq!(books.approx_row_count, Some(4));

    // Unknown schema → §5.
    let err = conn.list_tables("no_such_schema").await.unwrap_err();
    assert!(err.to_string().contains("does not exist"));

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn run_query_maps_types() {
    let Some((params, secret)) = gate("run_query_maps_types") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_query", "bt_it_query_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    let result = conn
        .run_query(
            &format!("SELECT in_print, big, note, price FROM {schema}.books ORDER BY id"),
            QueryOptions::default(),
        )
        .await
        .expect("run query");
    // bool → JSON true/false.
    assert_eq!(result.rows[0][0], serde_json::json!(true));
    assert_eq!(result.rows[1][0], serde_json::json!(false));
    // int8 beyond 2^53 → string (precision preserved).
    assert_eq!(result.rows[0][1], serde_json::json!("9007199254740993"));
    assert_eq!(result.rows[1][1], serde_json::json!(1));
    // NULL → null.
    assert_eq!(result.rows[1][2], serde_json::Value::Null);
    // numeric → number when it normalizes to a lossless, JS-safe value
    // (numeric(10,2) value 9.50 normalizes to 9.5). High-precision numerics
    // beyond f64 stay exact strings (CellValue precision contract); see
    // `numeric_text_to_json_preserves_precision`.
    assert_eq!(result.rows[0][3], serde_json::json!(9.5));

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn fetch_rows_paging_sort_filter_and_total() {
    let Some((params, secret)) = gate("fetch_rows_paging_sort_filter_and_total") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_fetch", "bt_it_fetch_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    // Sorted page, no filter → total 4.
    let page = conn
        .fetch_rows(FetchRowsRequest {
            schema: schema.into(),
            table: "books".into(),
            sort: Some(SortSpec {
                column: "id".into(),
                direction: SortDirection::Asc,
            }),
            filter: None,
            offset: 1,
            limit: 2,
        })
        .await
        .expect("fetch rows");
    assert_eq!(page.total_rows, Some(4));
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.offset, 1);

    // Filtered: in_print = true → 3 rows; bound boolean value.
    let filtered = conn
        .fetch_rows(FetchRowsRequest {
            schema: schema.into(),
            table: "books".into(),
            sort: None,
            filter: Some(FilterSpec::Conditions {
                items: vec![Condition {
                    column: "in_print".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(true))),
                    binary: false,
                }],
                combinator: Combinator::And,
            }),
            offset: 0,
            limit: 100,
        })
        .await
        .expect("filtered fetch");
    assert_eq!(filtered.total_rows, Some(3));

    // Each remaining operator compiles + runs without error.
    let ops: Vec<(FilterOp, FilterValue)> = vec![
        (FilterOp::Ne, FilterValue::Scalar(serde_json::json!(10))),
        (FilterOp::Gt, FilterValue::Scalar(serde_json::json!(10))),
        (FilterOp::Gte, FilterValue::Scalar(serde_json::json!(10))),
        (FilterOp::Lt, FilterValue::Scalar(serde_json::json!(13))),
        (FilterOp::Lte, FilterValue::Scalar(serde_json::json!(13))),
        (
            FilterOp::InList,
            FilterValue::List(vec![serde_json::json!(10), serde_json::json!(11)]),
        ),
    ];
    for (op, value) in ops {
        let r = conn
            .fetch_rows(FetchRowsRequest {
                schema: schema.into(),
                table: "books".into(),
                sort: None,
                filter: Some(FilterSpec::Conditions {
                    items: vec![Condition {
                        column: "id".into(),
                        op,
                        value: Some(value),
                        binary: false,
                    }],
                    combinator: Combinator::And,
                }),
                offset: 0,
                limit: 100,
            })
            .await
            .unwrap_or_else(|e| panic!("op {op:?} failed: {e}"));
        assert!(r.total_rows.is_some(), "op {op:?}");
    }

    // LIKE family on a text column.
    let like = conn
        .fetch_rows(FetchRowsRequest {
            schema: schema.into(),
            table: "books".into(),
            sort: None,
            filter: Some(FilterSpec::Conditions {
                items: vec![Condition {
                    column: "title".into(),
                    op: FilterOp::Contains,
                    value: Some(FilterValue::Scalar(serde_json::json!("ette"))),
                    binary: false,
                }],
                combinator: Combinator::And,
            }),
            offset: 0,
            limit: 100,
        })
        .await
        .expect("contains");
    assert_eq!(like.total_rows, Some(1)); // "Letters"

    // Injection inertness: a payload binds as a literal → matches nothing.
    let inj = conn
        .fetch_rows(FetchRowsRequest {
            schema: schema.into(),
            table: "books".into(),
            sort: None,
            filter: Some(FilterSpec::Conditions {
                items: vec![Condition {
                    column: "title".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(
                        "'; DROP TABLE books; --"
                    ))),
                    binary: false,
                }],
                combinator: Combinator::And,
            }),
            offset: 0,
            limit: 100,
        })
        .await
        .expect("injection bound");
    assert_eq!(inj.total_rows, Some(0));
    // The table still exists (the payload did not execute).
    assert_eq!(
        conn.list_tables(schema).await.unwrap().len(),
        2,
        "books table survived the injection attempt"
    );

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn table_meta_full_surface() {
    let Some((params, secret)) = gate("table_meta_full_surface") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_meta", "bt_it_meta_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    let meta = conn.table_meta(schema, "books").await.expect("meta");
    // Columns, types, nullability, defaults.
    let by_name = |n: &str| meta.columns.iter().find(|c| c.name == n).unwrap();
    assert!(by_name("id").pk);
    assert!(!by_name("title").nullable);
    assert!(by_name("note").nullable);
    assert_eq!(by_name("in_print").data_type, "boolean");
    assert!(by_name("price").default_value.is_some());
    // fk on author_id.
    let author_fk = by_name("author_id").fk.as_ref().expect("fk");
    assert_eq!(author_fk.table, "authors");
    assert_eq!(author_fk.column, "id");
    // Table-level foreign keys.
    assert_eq!(meta.foreign_keys.len(), 1);
    assert_eq!(meta.foreign_keys[0].ref_table, "authors");
    assert_eq!(meta.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
    // Indexes incl. the primary-key index.
    assert!(meta.indexes.iter().any(|i| i.primary));
    assert!(meta
        .indexes
        .iter()
        .any(|i| i.name == "idx_books_author_title" && i.unique && i.columns.len() == 2));
    // referenced_by on authors: books references it.
    let authors_meta = conn
        .table_meta(schema, "authors")
        .await
        .expect("authors meta");
    assert_eq!(authors_meta.comment.as_deref(), Some("people who write"));
    assert!(authors_meta
        .referenced_by
        .iter()
        .any(|r| r.table == "books" && r.columns == vec!["author_id".to_string()]));
    // DDL is a valid-ish CREATE TABLE.
    let ddl = meta.ddl.as_ref().expect("ddl");
    assert!(ddl.contains("CREATE TABLE"));
    assert!(ddl.contains("PRIMARY KEY (\"id\")"));
    assert!(ddl.contains("FOREIGN KEY"));

    // Unknown table → §5.
    let err = conn.table_meta(schema, "ghost").await.unwrap_err();
    assert!(err.to_string().contains("does not exist"));

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn fetch_row_by_key_and_column_stats() {
    let Some((params, secret)) = gate("fetch_row_by_key_and_column_stats") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_peek", "bt_it_peek_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    let hit = conn
        .fetch_row_by_key(RowLookupRequest {
            schema: schema.into(),
            table: "authors".into(),
            column: "id".into(),
            value: serde_json::json!(1),
            binary: false,
        })
        .await
        .expect("lookup");
    assert_eq!(hit.match_count, 1);
    assert!(hit.row.is_some());

    let miss = conn
        .fetch_row_by_key(RowLookupRequest {
            schema: schema.into(),
            table: "authors".into(),
            column: "id".into(),
            value: serde_json::json!(999),
            binary: false,
        })
        .await
        .expect("lookup miss");
    assert_eq!(miss.match_count, 0);
    assert!(miss.row.is_none());
    assert!(!miss.columns.is_empty(), "columns returned even on a miss");

    // Column stats: numeric column with avg, distinct, top.
    let stats = conn
        .column_stats(ColumnStatsRequest {
            schema: schema.into(),
            table: "books".into(),
            column: "price".into(),
            filter: None,
        })
        .await
        .expect("stats");
    assert_eq!(stats.total, 4);
    assert!(stats.numeric);
    assert!(stats.avg.is_some());
    assert!(stats.min.is_some() && stats.max.is_some());

    // Filtered stats: only in_print = true rows.
    let filtered = conn
        .column_stats(ColumnStatsRequest {
            schema: schema.into(),
            table: "books".into(),
            column: "price".into(),
            filter: Some(FilterSpec::Conditions {
                items: vec![Condition {
                    column: "in_print".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(true))),
                    binary: false,
                }],
                combinator: Combinator::And,
            }),
        })
        .await
        .expect("filtered stats");
    assert_eq!(filtered.total, 3);

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn update_cell_persists_and_is_pk_gated() {
    let Some((params, secret)) = gate("update_cell_persists_and_is_pk_gated") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_update", "bt_it_update_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    // Successful update of a non-pk column, targeted by full pk.
    let result = conn
        .update_cell(UpdateCellRequest {
            schema: schema.into(),
            table: "books".into(),
            column: "note".into(),
            value: serde_json::json!("updated"),
            pk: vec![PkPredicate {
                column: "id".into(),
                value: serde_json::json!(10),
                binary: false,
            }],
            binary: false,
        })
        .await
        .expect("update");
    assert_eq!(result.affected, 1);
    // Verify it persisted.
    let check: String =
        sqlx::query_scalar(&format!("SELECT note FROM {schema}.books WHERE id = 10"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(check, "updated");

    // pk-gating: missing pk is rejected.
    let no_pk = conn
        .update_cell(UpdateCellRequest {
            schema: schema.into(),
            table: "books".into(),
            column: "note".into(),
            value: serde_json::json!("x"),
            pk: vec![],
            binary: false,
        })
        .await;
    assert!(matches!(no_pk, Err(AppError::Database(_))));

    // Stale pk → no row matched, nothing changes.
    let stale = conn
        .update_cell(UpdateCellRequest {
            schema: schema.into(),
            table: "books".into(),
            column: "note".into(),
            value: serde_json::json!("x"),
            pk: vec![PkPredicate {
                column: "id".into(),
                value: serde_json::json!(99999),
                binary: false,
            }],
            binary: false,
        })
        .await;
    assert!(matches!(stale, Err(AppError::Database(_))));

    // Constraint failure rolls back (NOT NULL on title).
    let rollback = conn
        .update_cell(UpdateCellRequest {
            schema: schema.into(),
            table: "books".into(),
            column: "title".into(),
            value: serde_json::Value::Null,
            pk: vec![PkPredicate {
                column: "id".into(),
                value: serde_json::json!(10),
                binary: false,
            }],
            binary: false,
        })
        .await;
    assert!(matches!(rollback, Err(AppError::Database(_))));
    // Title unchanged after the rolled-back NOT NULL violation.
    let title: String =
        sqlx::query_scalar(&format!("SELECT title FROM {schema}.books WHERE id = 10"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(title, "Notes");

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn alter_table_native_ops_preserve_data() {
    let Some((params, secret)) = gate("alter_table_native_ops_preserve_data") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_alter", "bt_it_alter_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    // Preview does not mutate.
    let preview = conn
        .alter_table(
            schema,
            "books",
            &[AlterOp::AddColumn {
                name: "rating".into(),
                data_type: "integer".into(),
                nullable: true,
                default_value: Some("5".into()),
            }],
            false,
        )
        .await
        .expect("preview");
    assert!(!preview.applied);
    assert_eq!(preview.statements.len(), 1);
    assert!(preview.statements[0].contains("ADD COLUMN"));

    // A batch that references a non-existent column is rejected before any
    // statement runs (validation matches the SQLite adapter: each op's
    // target is checked against the original column set). Confirm it rolls
    // back cleanly — no partial 'rating' column afterwards.
    let bad = vec![
        AlterOp::AddColumn {
            name: "rating".into(),
            data_type: "integer".into(),
            nullable: true,
            default_value: Some("5".into()),
        },
        AlterOp::DropColumn {
            name: "bio_legacy".into(),
        },
    ];
    let bad_result = conn.alter_table(schema, "books", &bad, true).await;
    assert!(matches!(bad_result, Err(AppError::Database(_))));
    let meta = conn.table_meta(schema, "books").await.unwrap();
    assert!(
        !meta.columns.iter().any(|c| c.name == "rating"),
        "failed batch rolled back: no partial 'rating' column"
    );

    // A valid batch — add, rename, retype, set-nullable, set-default — each
    // targeting an original column. All apply in one transaction and
    // preserve data.
    let good = vec![
        AlterOp::AddColumn {
            name: "rating".into(),
            data_type: "integer".into(),
            nullable: false,
            default_value: Some("5".into()),
        },
        AlterOp::RenameColumn {
            from: "note".into(),
            to: "remark".into(),
        },
        AlterOp::ChangeType {
            column: "price".into(),
            new_type: "numeric(12,3)".into(),
        },
        AlterOp::SetNullable {
            column: "title".into(),
            nullable: true,
        },
        AlterOp::SetDefault {
            column: "big".into(),
            default_value: Some("0".into()),
        },
    ];
    let applied = conn
        .alter_table(schema, "books", &good, true)
        .await
        .expect("apply");
    assert!(applied.applied);
    // Re-introspect: changes landed, row count preserved.
    let meta = conn.table_meta(schema, "books").await.unwrap();
    let names: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"rating"));
    assert!(names.contains(&"remark"));
    assert!(!names.contains(&"note"));
    assert!(!meta.columns.iter().find(|c| c.name == "rating").unwrap().pk);
    let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {schema}.books"))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 4, "data preserved across native ALTERs");

    // pk-protection: dropping the pk column is rejected.
    let drop_pk = conn
        .alter_table(
            schema,
            "books",
            &[AlterOp::DropColumn { name: "id".into() }],
            true,
        )
        .await;
    assert!(matches!(drop_pk, Err(AppError::Database(_))));

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

// -- SSH tunnel (M12 Task 3) ---------------------------------------------
//
// Gated behind `BYTETABLE_TEST_SSH=1`. Connects the Postgres adapter to
// `bt-pg:5432` THROUGH the live bastion at localhost:2222 (user `tunnel`),
// using both private-key auth (`/tmp/bt_ssh_key`, overridable via
// `BYTETABLE_TEST_SSH_KEY`) and password auth ("bytetable"), then runs a
// real query. Also asserts a bad key path / password is a clean §5 error.
//
// Run: `BYTETABLE_TEST_SSH=1 cargo test --lib
//   engines::postgres::integration::ssh -- --test-threads=1`

/// `(bastion_host, bastion_port, user, target_host, target_port, db, db_user,
/// db_password, key_path, ssh_password)` for the SSH test, or `None` (skip).
#[allow(clippy::type_complexity)]
fn ssh_gate(
    test: &str,
) -> Option<(
    String,
    u16,
    String,
    String,
    u16,
    String,
    String,
    String,
    String,
    String,
)> {
    if std::env::var("BYTETABLE_TEST_SSH").as_deref() != Ok("1") {
        eprintln!("SKIP {test}: BYTETABLE_TEST_SSH=1 not set (live bastion required)");
        return None;
    }
    let key_path =
        std::env::var("BYTETABLE_TEST_SSH_KEY").unwrap_or_else(|_| "/tmp/bt_ssh_key".into());
    Some((
        std::env::var("BYTETABLE_TEST_SSH_HOST").unwrap_or_else(|_| "localhost".into()),
        std::env::var("BYTETABLE_TEST_SSH_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(2222),
        std::env::var("BYTETABLE_TEST_SSH_USER").unwrap_or_else(|_| "tunnel".into()),
        std::env::var("BYTETABLE_TEST_SSH_TARGET_HOST").unwrap_or_else(|_| "bt-pg".into()),
        5432,
        "bytetable".into(),
        "postgres".into(),
        "bytetable".into(),
        key_path,
        "bytetable".into(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn tunnelled_params(
    bastion_host: &str,
    bastion_port: u16,
    user: &str,
    target_host: &str,
    target_port: u16,
    db: &str,
    db_user: &str,
    auth: crate::shared::engine::SshAuth,
) -> ConnectionParams {
    ConnectionParams::Postgres {
        host: target_host.to_string(),
        port: target_port,
        database: Some(db.to_string()),
        user: Some(db_user.to_string()),
        tls_mode: crate::shared::engine::TlsMode::Disable,
        ssh: Some(crate::shared::engine::SshConfig {
            host: bastion_host.to_string(),
            port: bastion_port,
            user: user.to_string(),
            auth,
        }),
    }
}

// ---- M15: truncate + export against live Postgres ----

#[tokio::test]
async fn truncate_empties_table_and_reports_prior_count() {
    let Some((params, secret)) = gate("truncate_empties_table_and_reports_prior_count") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_truncate", "bt_it_truncate_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    // books has 4 seeded rows.
    let affected = conn
        .truncate_table(schema, "books")
        .await
        .expect("truncate books");
    assert_eq!(affected, 4);
    let after: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {schema}.books"))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, 0);

    // Truncating an already-empty table reports 0.
    let again = conn
        .truncate_table(schema, "books")
        .await
        .expect("re-truncate");
    assert_eq!(again, 0);

    // Unknown table is a §5 error.
    let err = conn.truncate_table(schema, "ghost").await.unwrap_err();
    assert!(matches!(err, AppError::Database(_)));
    assert!(err.to_string().contains("does not exist"));

    drop_fixture(&pool, schema, other).await;
}

/// drop_schema empties a THROWAWAY schema (never `public`/`byteshop`):
/// the schema still exists afterward but holds 0 tables, and the seeded
/// rows are gone. A nonexistent schema is a §5 error.
#[tokio::test]
async fn drop_schema_empties_throwaway_schema_and_leaves_it() {
    let Some((params, secret)) = gate("drop_schema_empties_throwaway_schema_and_leaves_it") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_dropschema", "bt_it_dropschema_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    // Sanity: the fixture seeded tables in the throwaway schema.
    let before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = $1",
    )
    .bind(schema)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(before >= 2, "fixture should seed tables, got {before}");

    conn.drop_schema(schema).await.expect("drop schema");

    // The schema still exists…
    let schema_exists: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM pg_namespace WHERE nspname = $1")
            .bind(schema)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(schema_exists.is_some(), "schema must be recreated empty");

    // …but it is empty.
    let after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = $1",
    )
    .bind(schema)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, 0, "dropped schema must hold 0 tables");

    // The OTHER throwaway schema is untouched.
    let other_tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = $1",
    )
    .bind(other)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(other_tables, 1, "drop must not touch other schemas");

    // A nonexistent schema is a §5 error (plain DROP, no IF EXISTS).
    let err = conn.drop_schema("bt_it_nope_xyz").await.unwrap_err();
    assert!(matches!(err, AppError::Database(_)));
    assert!(err.to_string().contains("does not exist"));

    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn export_csv_and_sql_against_live_postgres() {
    use crate::features::connections::application::ConnectionManager;
    use crate::features::export::application::{export_schema_sql, export_table};
    use crate::features::export::domain::{ExportFormat, ExportScope};

    let Some((params, secret)) = gate("export_csv_and_sql_against_live_postgres") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_export", "bt_it_export_other");
    setup_fixture(&pool, schema, other).await;

    let open = PostgresConnector
        .open_with_secret(&params, secret.as_ref())
        .await
        .expect("open");
    let manager = ConnectionManager::new();
    let handle = manager.insert(open).await;

    // CSV: header + every authors row (3), NULL bio → empty field.
    let csv = export_table(
        &manager,
        &handle,
        schema,
        "authors",
        ExportFormat::Csv,
        ExportScope::Both,
        &|_: u64, _: u64| {},
    )
    .await
    .expect("export csv");
    assert_eq!(csv.lines().next().unwrap(), "id,name,bio");
    assert_eq!(csv.lines().count(), 4);
    assert!(csv.contains("2,Grace,")); // null bio → trailing empty field

    // SQL: DDL + one INSERT per row, backtick-free double-quoted idents.
    let sql = export_table(
        &manager,
        &handle,
        schema,
        "books",
        ExportFormat::Sql,
        ExportScope::Both,
        &|_: u64, _: u64| {},
    )
    .await
    .expect("export sql");
    assert!(sql.contains(&format!("INSERT INTO \"{schema}\".\"books\"")));
    assert_eq!(sql.matches("INSERT INTO").count(), 4);
    assert!(sql.contains("NULL")); // the null note book

    // Schema dump touches both base tables.
    let dump = export_schema_sql(
        &manager,
        &handle,
        schema,
        ExportScope::Both,
        &|_: u64, _: u64| {},
    )
    .await
    .expect("export schema");
    assert!(dump.contains("-- ByteTable schema dump"));
    assert!(dump.contains("authors"));
    assert!(dump.contains("books"));

    // Empty table after a truncate exports the no-rows marker.
    conn_truncate(&manager, &handle, schema, "books").await;
    let empty_sql = export_table(
        &manager,
        &handle,
        schema,
        "books",
        ExportFormat::Sql,
        ExportScope::Both,
        &|_: u64, _: u64| {},
    )
    .await
    .expect("export empty");
    assert!(empty_sql.contains("-- (no rows)"));

    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn import_round_trip_multi_statement_and_error_rollback_against_live_postgres() {
    use crate::features::connections::application::ConnectionManager;
    use crate::features::export::application::{export_table, import_sql};
    use crate::features::export::domain::{ExportFormat, ExportScope};

    let Some((params, secret)) =
        gate("import_round_trip_multi_statement_and_error_rollback_against_live_postgres")
    else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_import", "bt_it_import_other");
    setup_fixture(&pool, schema, other).await;
    // A fresh, empty target schema for the round-trip + hand-written imports.
    let fresh = "bt_it_import_fresh";
    let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {fresh} CASCADE"))
        .execute(&pool)
        .await;
    sqlx::query(&format!("CREATE SCHEMA {fresh}"))
        .execute(&pool)
        .await
        .expect("create fresh schema");

    let open = PostgresConnector
        .open_with_secret(&params, secret.as_ref())
        .await
        .expect("open");
    let manager = ConnectionManager::new();
    let handle = manager.insert(open).await;
    let dir = tempfile::tempdir().expect("tempdir");

    // --- ROUND-TRIP: export authors (qualified dump) → rewrite it to target
    // the FRESH schema → import → verify the table + 3 rows landed there.
    let dump = export_table(
        &manager,
        &handle,
        schema,
        "authors",
        ExportFormat::Sql,
        ExportScope::Both,
        &|_: u64, _: u64| {},
    )
    .await
    .expect("export sql");
    let retargeted = dump.replace(
        &format!("\"{schema}\".\"authors\""),
        &format!("\"{fresh}\".\"authors\""),
    );
    let rt_path = dir.path().join("authors.sql");
    std::fs::write(&rt_path, &retargeted).expect("write dump");
    let result = import_sql(
        &manager,
        &handle,
        fresh,
        &rt_path.to_string_lossy(),
        &|_: u64, _: u64| {},
    )
    .await
    .expect("import round-trip");
    // DDL + 3 INSERTs.
    assert_eq!(result.statements, 4);
    let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {fresh}.authors"))
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(n, 3, "all rows round-tripped into the fresh schema");

    // --- MULTI-STATEMENT: a hand-written CREATE + 2 INSERTs (unqualified, so
    // search_path lands them in the target schema).
    let script = "CREATE TABLE gadgets (id INT PRIMARY KEY, label TEXT);\n\
                  INSERT INTO gadgets (id, label) VALUES (1, 'one');\n\
                  INSERT INTO gadgets (id, label) VALUES (2, 'two');\n";
    let ms_path = dir.path().join("gadgets.sql");
    std::fs::write(&ms_path, script).expect("write script");
    let result = import_sql(
        &manager,
        &handle,
        fresh,
        &ms_path.to_string_lossy(),
        &|_: u64, _: u64| {},
    )
    .await
    .expect("import multi-statement");
    assert_eq!(result.statements, 3);
    let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {fresh}.gadgets"))
        .fetch_one(&pool)
        .await
        .expect("count gadgets");
    assert_eq!(n, 2);

    // --- ERROR ROLLBACK: statement 1 creates a table, statement 2 fails →
    // Postgres has transactional DDL, so the whole import rolls back and the
    // table from statement 1 is NOT created.
    let bad = "CREATE TABLE rollback_me (id INT);\n\
               INSERT INTO no_such_table (id) VALUES (1);\n";
    let bad_path = dir.path().join("bad.sql");
    std::fs::write(&bad_path, bad).expect("write bad");
    let err = import_sql(
        &manager,
        &handle,
        fresh,
        &bad_path.to_string_lossy(),
        &|_: u64, _: u64| {},
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Database(_)), "got {err:?}");
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = 'rollback_me'",
    )
    .bind(fresh)
    .fetch_optional(&pool)
    .await
    .expect("existence");
    assert!(exists.is_none(), "statement 1 must have rolled back");

    // --- BAD PATH: a missing file is a §5 IO error naming the path.
    let err = import_sql(
        &manager,
        &handle,
        fresh,
        "/tmp/bytetable-nonexistent.sql",
        &|_: u64, _: u64| {},
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Io(_)), "got {err:?}");
    assert!(err.to_string().contains("Could not read"));

    // --- EXECUTE_SCRIPT_TEXT: run generated SQL directly (no temp file),
    // the way ImportModal applies CSV-derived INSERTs.
    {
        use crate::features::export::application::execute_script_text;
        let text = "CREATE TABLE from_text (id INT PRIMARY KEY, label TEXT);\n\
                    INSERT INTO from_text (id, label) VALUES (1, 'O''Brien');\n";
        let result = execute_script_text(&manager, &handle, fresh, text, &|_: u64, _: u64| {})
            .await
            .expect("execute_script_text");
        assert_eq!(result.statements, 2);
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {fresh}.from_text"))
            .fetch_one(&pool)
            .await
            .expect("count from_text");
        assert_eq!(n, 1);
    }

    let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {fresh} CASCADE"))
        .execute(&pool)
        .await;
    drop_fixture(&pool, schema, other).await;
}

/// Truncate via the open connection (helper to keep the export test tidy).
async fn conn_truncate(
    manager: &crate::features::connections::application::ConnectionManager,
    handle: &crate::features::connections::application::ConnectionHandleId,
    schema: &str,
    table: &str,
) {
    manager
        .get_sql(handle)
        .await
        .expect("handle")
        .truncate_table(schema, table)
        .await
        .expect("truncate");
}

#[tokio::test]
async fn ssh_tunnel_key_auth_connects_and_queries() {
    let Some((bh, bp, user, th, tp, db, du, dpw, key, _sshpw)) =
        ssh_gate("ssh_tunnel_key_auth_connects_and_queries")
    else {
        return;
    };
    let params = tunnelled_params(
        &bh,
        bp,
        &user,
        &th,
        tp,
        &db,
        &du,
        crate::shared::engine::SshAuth::Key { key_path: key },
    );
    // No SSH passphrase on the test key; db password is the only secret.
    let secret = ConnectSecret::new(dpw);

    // test_with_secret opens the tunnel, connects, reads the version, drops.
    let info = PostgresConnector
        .test_with_secret(&params, Some(&secret))
        .await
        .expect("tunnelled test connection (key auth)");
    assert!(info.server_version.starts_with("PostgreSQL "));

    // open_with_secret keeps the tunnel alive on the connection; query it.
    let conn = PostgresConnector
        .open_with_secret(&params, Some(&secret))
        .await
        .expect("tunnelled open (key auth)")
        .into_sql()
        .expect("sql connection");
    let result = conn
        .run_query("SELECT 1 AS one", QueryOptions::default())
        .await
        .expect("query through tunnel");
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0][0], serde_json::json!(1));
    // list_schemas works through the tunnel too.
    let schemas = conn.list_schemas().await.expect("schemas through tunnel");
    assert!(schemas.iter().any(|s| s.name == "public"));
    conn.close().await.expect("close tunnelled conn");
}

#[tokio::test]
async fn ssh_tunnel_password_auth_connects() {
    let Some((bh, bp, user, th, tp, db, du, dpw, _key, sshpw)) =
        ssh_gate("ssh_tunnel_password_auth_connects")
    else {
        return;
    };
    let params = tunnelled_params(
        &bh,
        bp,
        &user,
        &th,
        tp,
        &db,
        &du,
        crate::shared::engine::SshAuth::Password,
    );
    // Both secrets: the bastion password (ssh) and the db password.
    let secret = ConnectSecret::with_ssh(Some(dpw), Some(sshpw));
    let info = PostgresConnector
        .test_with_secret(&params, Some(&secret))
        .await
        .expect("tunnelled test connection (password auth)");
    assert!(info.server_version.starts_with("PostgreSQL "));
}

#[tokio::test]
async fn ssh_tunnel_bad_auth_is_a_clean_error() {
    let Some((bh, bp, user, th, tp, db, du, dpw, _key, _sshpw)) =
        ssh_gate("ssh_tunnel_bad_auth_is_a_clean_error")
    else {
        return;
    };
    // Wrong SSH password → a §5 Database error from the tunnel, not a panic.
    let params = tunnelled_params(
        &bh,
        bp,
        &user,
        &th,
        tp,
        &db,
        &du,
        crate::shared::engine::SshAuth::Password,
    );
    let secret = ConnectSecret::with_ssh(Some(dpw), Some("definitely-wrong".into()));
    let err = PostgresConnector
        .test_with_secret(&params, Some(&secret))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Database(_)), "got {err:?}");
    assert!(err.to_string().contains("SSH authentication"), "got {err}");

    // A bad key PATH is also a clean §5 error (key auth, missing file).
    let bad_key = tunnelled_params(
        &bh,
        bp,
        &user,
        &th,
        tp,
        &db,
        &du,
        crate::shared::engine::SshAuth::Key {
            key_path: "/tmp/bytetable-nonexistent-key".into(),
        },
    );
    let err = PostgresConnector
        .test_with_secret(&bad_key, Some(&ConnectSecret::new("bytetable")))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Database(_)), "got {err:?}");
}
