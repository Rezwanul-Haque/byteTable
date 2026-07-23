//! Live-MySQL integration tests (gated behind `BYTETABLE_TEST_MYSQL_URL`).

use super::introspect::SYSTEM_SCHEMAS;
use super::*;

use crate::shared::engine::{
    Combinator, Condition, FilterOp, FilterSpec, FilterValue, PkPredicate, RowLookupRequest,
    SortDirection, SortSpec,
};

/// Parse `mysql://user:password@host:port/db` into params + the transient
/// secret. Minimal — handles the shape the M12 test container emits.
fn parse_url(url: &str) -> (ConnectionParams, Option<ConnectSecret>) {
    let rest = url
        .strip_prefix("mysql://")
        .or_else(|| url.strip_prefix("mariadb://"))
        .expect("url scheme");
    let (creds_host, db) = rest.split_once('/').expect("db path");
    let (creds, host_port) = creds_host.split_once('@').expect("@ separator");
    let (user, password) = match creds.split_once(':') {
        Some((u, p)) => (u.to_string(), Some(p.to_string())),
        None => (creds.to_string(), None),
    };
    let (host, port) = match host_port.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(3306)),
        None => (host_port.to_string(), 3306),
    };
    let params = ConnectionParams::Mysql {
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
    match std::env::var("BYTETABLE_TEST_MYSQL_URL") {
        Ok(url) if !url.is_empty() => Some(parse_url(&url)),
        _ => {
            eprintln!("SKIP {test}: BYTETABLE_TEST_MYSQL_URL not set (live MySQL required)");
            None
        }
    }
}

/// Open a pool connection for fixture setup/teardown (raw sqlx), separate
/// from the adapter under test. Points at the default DB; fixtures create
/// and use their own databases via fully-qualified names.
async fn raw_pool(params: &ConnectionParams, secret: &Option<ConnectSecret>) -> MySqlPool {
    let options =
        super::sql::connect_options(params, db_password(secret.as_ref()), None, None).unwrap();
    MySqlPoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await
        .expect("connect raw pool")
}

async fn open_conn(
    params: &ConnectionParams,
    secret: &Option<ConnectSecret>,
) -> std::sync::Arc<dyn EngineConnection> {
    MysqlConnector
        .open_with_secret(params, secret.as_ref())
        .await
        .expect("open mysql connection")
        .into_sql()
        .expect("sql connection")
}

/// Create a throwaway database with a rich fixture: pk/fk/indexes,
/// tinyint(1) bool, decimal, bigint, text, null columns, plus a second
/// database. Drops first so reruns are clean.
async fn setup_fixture(pool: &MySqlPool, schema: &str, other: &str) {
    for stmt in [
        format!("DROP DATABASE IF EXISTS `{schema}`"),
        format!("DROP DATABASE IF EXISTS `{other}`"),
        format!("CREATE DATABASE `{schema}`"),
        format!("CREATE DATABASE `{other}`"),
        format!(
            "CREATE TABLE `{schema}`.`authors` (\
               id bigint PRIMARY KEY, name varchar(100) NOT NULL, bio text) \
             COMMENT 'people who write'"
        ),
        format!(
            "CREATE TABLE `{schema}`.`books` (\
               id int PRIMARY KEY, \
               title varchar(200) NOT NULL, \
               author_id bigint NOT NULL, \
               price decimal(10,2) DEFAULT 0.00, \
               in_print tinyint(1) DEFAULT 1, \
               big bigint, \
               note text, \
               INDEX idx_books_title (title), \
               UNIQUE INDEX idx_books_author_title (author_id, title), \
               CONSTRAINT fk_books_author FOREIGN KEY (author_id) \
                 REFERENCES `{schema}`.`authors`(id) ON DELETE CASCADE)"
        ),
        format!("CREATE TABLE `{other}`.`tags` (id int PRIMARY KEY, label varchar(50))"),
        format!(
            "INSERT INTO `{schema}`.`authors` (id, name, bio) VALUES \
               (1, 'Ada', 'pioneer'), (2, 'Grace', NULL), (3, 'Linus', 'kernel')"
        ),
        // bool 1/0, decimal, big bigint (> 2^53), a NULL note.
        format!(
            "INSERT INTO `{schema}`.`books` (id, title, author_id, price, in_print, big, note) VALUES \
               (10, 'Notes', 1, 9.50, 1, 9007199254740993, 'first'), \
               (11, 'Essays', 1, 7.25, 0, 1, NULL), \
               (12, 'Letters', 2, 0.00, 1, 2, 'third'), \
               (13, 'Memoir', 3, 12.00, 1, 3, 'fourth')"
        ),
    ] {
        sqlx::query(&stmt)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("fixture stmt failed: {stmt}\n{e}"));
    }
}

async fn drop_fixture(pool: &MySqlPool, schema: &str, other: &str) {
    let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS `{schema}`"))
        .execute(pool)
        .await;
    let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS `{other}`"))
        .execute(pool)
        .await;
}

#[tokio::test]
async fn connect_and_server_version() {
    let Some((params, secret)) = gate("connect_and_server_version") else {
        return;
    };
    let info = MysqlConnector
        .test_with_secret(&params, secret.as_ref())
        .await
        .expect("test connection");
    assert_eq!(info.engine, Engine::Mysql);
    assert!(
        info.server_version.starts_with("MySQL "),
        "got {:?}",
        info.server_version
    );
    // A wrong password is a §5 database error, not a panic.
    let bad = MysqlConnector
        .test_with_secret(&params, Some(&ConnectSecret::new("definitely-wrong")))
        .await;
    assert!(matches!(bad, Err(AppError::Database(_))));
}

/// M16: generate fake data across a schema with the type/constraint shapes
/// that broke on MySQL (datetime format, varchar length, tinyint range,
/// decimal, a non-FK sized-string id) and FK ordering. Every table must
/// succeed (no per-table error) and FK rows must be valid.
#[tokio::test]
async fn generate_data_respects_mysql_types_and_constraints() {
    use crate::features::connections::application::ConnectionManager;
    use crate::features::generate::application::{run_generation, GenProgress, RunCtx};
    use crate::features::generate::domain::GenerateSize;

    let Some((params, secret)) = gate("generate_data_respects_mysql_types_and_constraints") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let schema = "bt_it_generate";
    for stmt in [
        format!("DROP DATABASE IF EXISTS `{schema}`"),
        format!("CREATE DATABASE `{schema}`"),
        // Binary(16) UUID pk + binary FK — the byteshop shape that broke.
        format!(
            "CREATE TABLE `{schema}`.`accounts` (\
               id binary(16) NOT NULL PRIMARY KEY, name varchar(50) NOT NULL)"
        ),
        format!(
            "CREATE TABLE `{schema}`.`documents` (\
               id binary(16) NOT NULL PRIMARY KEY, \
               account_id binary(16) NOT NULL, \
               country varchar(2) NOT NULL, \
               created_at datetime NOT NULL, \
               CONSTRAINT fk_docs_account FOREIGN KEY (account_id) \
                 REFERENCES `{schema}`.`accounts`(id))"
        ),
        format!(
            "CREATE TABLE `{schema}`.`users` (\
               id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, \
               country varchar(2) NOT NULL, \
               created_at datetime NOT NULL)"
        ),
        format!(
            "CREATE TABLE `{schema}`.`orders` (\
               id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY, \
               user_id bigint NOT NULL, \
               paid tinyint NOT NULL, \
               amount decimal(6,2) NOT NULL, \
               CONSTRAINT fk_orders_user FOREIGN KEY (user_id) \
                 REFERENCES `{schema}`.`users`(id))"
        ),
    ] {
        sqlx::query(&stmt).execute(&pool).await.expect("ddl");
    }

    let open = MysqlConnector
        .open_with_secret(&params, secret.as_ref())
        .await
        .expect("open mysql");
    let manager = ConnectionManager::new();
    let handle = manager.insert(open).await;

    let cancel = std::sync::atomic::AtomicBool::new(false);
    let noop = |_p: GenProgress| {};
    let summary = run_generation(
        &manager,
        &handle,
        schema,
        GenerateSize::OneK,
        RunCtx {
            cancel: &cancel,
            on_progress: &noop,
            seed: 1,
        },
    )
    .await
    .expect("run");

    for r in &summary.tables {
        assert!(r.error.is_none(), "table {} failed: {:?}", r.table, r.error);
    }
    assert!(summary.total_inserted > 0, "rows inserted");

    let conn = manager.get_sql(&handle).await.expect("sql");
    let orphans = conn
        .run_query(
            &format!(
                "SELECT count(*) FROM `{schema}`.`orders` o \
                 LEFT JOIN `{schema}`.`users` u ON o.user_id = u.id WHERE u.id IS NULL"
            ),
            QueryOptions::default(),
        )
        .await
        .expect("orphan query");
    assert_eq!(orphans.rows[0][0].as_i64().unwrap(), 0, "no orphan FKs");

    sqlx::query(&format!("DROP DATABASE IF EXISTS `{schema}`"))
        .execute(&pool)
        .await
        .expect("drop db");
}

#[tokio::test]
async fn schemas_tables_and_counts() {
    let Some((params, secret)) = gate("schemas_tables_and_counts") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_lists", "bt_it_lists_other");
    setup_fixture(&pool, schema, other).await;
    // ANALYZE so table_rows is populated.
    let _ = sqlx::query(&format!("ANALYZE TABLE `{schema}`.`books`"))
        .execute(&pool)
        .await;

    let conn = open_conn(&params, &secret).await;

    let schemas = conn.list_schemas().await.expect("list schemas");
    let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&schema), "user schema present: {names:?}");
    assert!(names.contains(&other), "second schema present");
    // System DBs excluded.
    for sys in SYSTEM_SCHEMAS {
        assert!(!names.contains(&sys), "system db {sys} excluded");
    }

    let tables = conn.list_tables(schema).await.expect("list tables");
    let tnames: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(tnames, vec!["authors", "books"]);

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
            &format!("SELECT in_print, big, note, price FROM `{schema}`.`books` ORDER BY id"),
            QueryOptions::default(),
        )
        .await
        .expect("run query");
    // tinyint(1)/bool → integer 0/1 (NOT JSON bool — MySQL has no native
    // bool; module docs).
    assert_eq!(result.rows[0][0], serde_json::json!(1));
    assert_eq!(result.rows[1][0], serde_json::json!(0));
    // bigint beyond 2^53 → string (precision preserved).
    assert_eq!(result.rows[0][1], serde_json::json!("9007199254740993"));
    assert_eq!(result.rows[1][1], serde_json::json!(1));
    // NULL → null.
    assert_eq!(result.rows[1][2], serde_json::Value::Null);
    // decimal 9.50 normalizes to a lossless 9.5 → number.
    assert_eq!(result.rows[0][3], serde_json::json!(9.5));

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn run_batch_pins_one_session_across_transaction_and_savepoint() {
    let Some((params, secret)) =
        gate("run_batch_pins_one_session_across_transaction_and_savepoint")
    else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_batch", "bt_it_batch_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    // A transaction + savepoint spanning five statements. A per-statement
    // `run_query` loop would hand each statement a DIFFERENT pooled connection,
    // so the SAVEPOINT set on one connection would be invisible to the
    // ROLLBACK TO on another ("SAVEPOINT sp1 does not exist"). Pinned to one
    // session, all five succeed and the UPDATE is undone by the savepoint.
    let statements: Vec<String> = vec![
        "START TRANSACTION".into(),
        "SAVEPOINT sp1".into(),
        format!("UPDATE `{schema}`.`authors` SET name = 'changed' WHERE id = 1"),
        "ROLLBACK TO SAVEPOINT sp1".into(),
        "COMMIT".into(),
    ];
    let outcomes = conn
        .run_batch(&statements, QueryOptions::default())
        .await
        .expect("run batch");
    assert_eq!(outcomes.len(), 5);
    for (i, o) in outcomes.iter().enumerate() {
        assert!(o.error.is_none(), "statement {i} errored: {:?}", o.error);
    }

    // The UPDATE was rolled back to the savepoint, so the original name
    // survives the COMMIT.
    let check = conn
        .run_query(
            &format!("SELECT name FROM `{schema}`.`authors` WHERE id = 1"),
            QueryOptions::default(),
        )
        .await
        .expect("verify");
    assert_eq!(check.rows[0][0], serde_json::json!("Ada"));

    // Continue-on-error: a failing statement mid-batch reports its own error
    // and does NOT abort the statements after it.
    let mixed: Vec<String> = vec![
        format!("SELECT 1 FROM `{schema}`.`authors` LIMIT 1"),
        "SELECT * FROM nonexistent_table_xyz".into(),
        "SELECT 2".into(),
    ];
    let outcomes = conn
        .run_batch(&mixed, QueryOptions::default())
        .await
        .expect("run mixed batch");
    assert_eq!(outcomes.len(), 3);
    assert!(outcomes[0].error.is_none());
    assert!(
        outcomes[1].error.is_some(),
        "bad statement reports its error"
    );
    assert!(outcomes[2].error.is_none(), "run continues after a failure");

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

    // Filtered: in_print = 1 → 3 rows; bound integer value (bool-as-0/1).
    let filtered = conn
        .fetch_rows(FetchRowsRequest {
            schema: schema.into(),
            table: "books".into(),
            sort: None,
            filter: Some(FilterSpec::Conditions {
                items: vec![Condition {
                    column: "in_print".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(1))),
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
    let by_name = |n: &str| meta.columns.iter().find(|c| c.name == n).unwrap();
    assert!(by_name("id").pk);
    assert!(!by_name("title").nullable);
    assert!(by_name("note").nullable);
    // tinyint(1) surfaces its full column type.
    assert!(by_name("in_print").data_type.contains("tinyint"));
    assert!(by_name("price").default_value.is_some());
    // fk on author_id.
    let author_fk = by_name("author_id").fk.as_ref().expect("fk");
    assert_eq!(author_fk.table, "authors");
    assert_eq!(author_fk.column, "id");
    // Table-level foreign keys.
    assert_eq!(meta.foreign_keys.len(), 1);
    assert_eq!(meta.foreign_keys[0].ref_table, "authors");
    assert_eq!(meta.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
    // Indexes incl. the primary-key index (named PRIMARY).
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
    // DDL via SHOW CREATE TABLE — faithful CREATE TABLE.
    let ddl = meta.ddl.as_ref().expect("ddl");
    assert!(ddl.contains("CREATE TABLE"));
    assert!(ddl.to_uppercase().contains("PRIMARY KEY"));
    assert!(ddl.to_uppercase().contains("FOREIGN KEY"));

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

    // Column stats: numeric (decimal) column with avg, distinct, top.
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

    // Filtered stats: only in_print = 1 rows.
    let filtered = conn
        .column_stats(ColumnStatsRequest {
            schema: schema.into(),
            table: "books".into(),
            column: "price".into(),
            filter: Some(FilterSpec::Conditions {
                items: vec![Condition {
                    column: "in_print".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(1))),
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
    let check: String = sqlx::query_scalar(&format!(
        "SELECT note FROM `{schema}`.`books` WHERE id = 10"
    ))
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

    // Stale pk → no row matched.
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

    // Constraint failure rolls back (NOT NULL on title — DML is
    // transactional on InnoDB).
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
    let title: String = sqlx::query_scalar(&format!(
        "SELECT title FROM `{schema}`.`books` WHERE id = 10"
    ))
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
                data_type: "int".into(),
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
    // Preview did not add the column.
    let meta = conn.table_meta(schema, "books").await.unwrap();
    assert!(!meta.columns.iter().any(|c| c.name == "rating"));

    // A batch referencing a non-existent column is rejected before any
    // statement runs (validate_ops up front).
    let bad = vec![
        AlterOp::AddColumn {
            name: "rating".into(),
            data_type: "int".into(),
            nullable: true,
            default_value: Some("5".into()),
        },
        AlterOp::DropColumn {
            name: "ghost_col".into(),
        },
    ];
    let bad_result = conn.alter_table(schema, "books", &bad, true).await;
    assert!(matches!(bad_result, Err(AppError::Database(_))));
    let meta = conn.table_meta(schema, "books").await.unwrap();
    assert!(
        !meta.columns.iter().any(|c| c.name == "rating"),
        "bad batch rejected up front: no partial 'rating' column"
    );

    // A valid batch — add, rename, modify-type, set-nullable, set-default.
    let good = vec![
        AlterOp::AddColumn {
            name: "rating".into(),
            data_type: "int".into(),
            nullable: false,
            default_value: Some("5".into()),
        },
        AlterOp::RenameColumn {
            from: "note".into(),
            to: "remark".into(),
        },
        AlterOp::ChangeType {
            column: "price".into(),
            new_type: "decimal(12,3)".into(),
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
    // title is now nullable after MODIFY.
    assert!(
        meta.columns
            .iter()
            .find(|c| c.name == "title")
            .unwrap()
            .nullable
    );
    // price retyped.
    assert!(meta
        .columns
        .iter()
        .find(|c| c.name == "price")
        .unwrap()
        .data_type
        .contains("decimal(12,3)"));
    let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{schema}`.`books`"))
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

// ---- M15: truncate + export against live MySQL ----

#[tokio::test]
async fn truncate_empties_table_and_reports_prior_count() {
    let Some((params, secret)) = gate("truncate_empties_table_and_reports_prior_count") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_truncate", "bt_it_truncate_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    // books (the child of the FK) has 4 rows; truncating the child is safe.
    let affected = conn
        .truncate_table(schema, "books")
        .await
        .expect("truncate books");
    assert_eq!(affected, 4);
    let after: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{schema}`.`books`"))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, 0);

    let again = conn
        .truncate_table(schema, "books")
        .await
        .expect("re-truncate");
    assert_eq!(again, 0);

    let err = conn.truncate_table(schema, "ghost").await.unwrap_err();
    assert!(matches!(err, AppError::Database(_)));
    assert!(err.to_string().contains("does not exist"));

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

/// drop_schema drops + recreates a THROWAWAY database empty (never
/// `byteshop`): the database still exists afterward but holds 0 tables. A
/// nonexistent schema is a §5 error.
#[tokio::test]
async fn drop_schema_recreates_throwaway_database_empty() {
    let Some((params, secret)) = gate("drop_schema_recreates_throwaway_database_empty") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_dropschema", "bt_it_dropschema_other");
    setup_fixture(&pool, schema, other).await;
    let conn = open_conn(&params, &secret).await;

    let before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema = ?")
            .bind(schema)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(before >= 2, "fixture should seed tables, got {before}");

    conn.drop_schema(schema).await.expect("drop schema");

    // The database still exists…
    let db_exists: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM information_schema.schemata WHERE schema_name = ?")
            .bind(schema)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(db_exists.is_some(), "database must be recreated empty");

    // …but it is empty.
    let after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema = ?")
            .bind(schema)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after, 0, "dropped database must hold 0 tables");

    // The OTHER throwaway database is untouched.
    let other_tables: i64 =
        sqlx::query_scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema = ?")
            .bind(other)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(other_tables, 1, "drop must not touch other databases");

    let err = conn.drop_schema("bt_it_nope_xyz").await.unwrap_err();
    assert!(matches!(err, AppError::Database(_)));
    assert!(err.to_string().contains("does not exist"));

    conn.close().await.expect("close");
    drop_fixture(&pool, schema, other).await;
}

#[tokio::test]
async fn export_csv_and_sql_against_live_mysql() {
    use crate::features::connections::application::ConnectionManager;
    use crate::features::export::application::{export_schema_sql, export_table};
    use crate::features::export::domain::{ExportFormat, ExportScope};

    let Some((params, secret)) = gate("export_csv_and_sql_against_live_mysql") else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_export", "bt_it_export_other");
    setup_fixture(&pool, schema, other).await;

    let open = MysqlConnector
        .open_with_secret(&params, secret.as_ref())
        .await
        .expect("open");
    let manager = ConnectionManager::new();
    let handle = manager.insert(open).await;

    // CSV: header + every authors row (3); NULL bio → empty field.
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
    assert!(csv.contains("2,Grace,"));

    // SQL: DDL + one INSERT per row, MySQL backtick identifiers.
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
    assert!(sql.contains(&format!("INSERT INTO `{schema}`.`books`")));
    assert_eq!(sql.matches("INSERT INTO").count(), 4);
    assert!(sql.contains("NULL"));

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

    // Empty table after truncate exports the no-rows marker.
    manager
        .get_sql(&handle)
        .await
        .unwrap()
        .truncate_table(schema, "books")
        .await
        .expect("truncate");
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
async fn import_round_trip_multi_statement_and_nonatomic_error_against_live_mysql() {
    use crate::features::connections::application::ConnectionManager;
    use crate::features::export::application::{export_table, import_sql};
    use crate::features::export::domain::{ExportFormat, ExportScope};

    let Some((params, secret)) =
        gate("import_round_trip_multi_statement_and_nonatomic_error_against_live_mysql")
    else {
        return;
    };
    let pool = raw_pool(&params, &secret).await;
    let (schema, other) = ("bt_it_import", "bt_it_import_other");
    setup_fixture(&pool, schema, other).await;
    // A fresh, empty target database for the imports.
    let fresh = "bt_it_import_fresh";
    let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS `{fresh}`"))
        .execute(&pool)
        .await;
    sqlx::query(&format!("CREATE DATABASE `{fresh}`"))
        .execute(&pool)
        .await
        .expect("create fresh db");

    let open = MysqlConnector
        .open_with_secret(&params, secret.as_ref())
        .await
        .expect("open");
    let manager = ConnectionManager::new();
    let handle = manager.insert(open).await;
    let dir = tempfile::tempdir().expect("tempdir");

    // --- ROUND-TRIP: export authors → retarget the qualified names to the
    // FRESH db → import → verify the table + 3 rows landed there.
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
    // The INSERTs are `schema`.`authors`; the SHOW CREATE TABLE DDL names the
    // table unqualified, so it lands in the USEd (fresh) db. Retarget the
    // qualified INSERT prefix to the fresh db.
    let retargeted = dump.replace(
        &format!("`{schema}`.`authors`"),
        &format!("`{fresh}`.`authors`"),
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
    assert_eq!(result.statements, 4); // DDL + 3 INSERTs
    let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{fresh}`.`authors`"))
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(n, 3);

    // --- MULTI-STATEMENT: hand-written CREATE + 2 INSERTs (unqualified → USE).
    let script = "CREATE TABLE gadgets (id INT PRIMARY KEY, label VARCHAR(20));\n\
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
    let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{fresh}`.`gadgets`"))
        .fetch_one(&pool)
        .await
        .expect("count gadgets");
    assert_eq!(n, 2);

    // --- NON-ATOMIC ERROR: statement 1 (CREATE) auto-commits, statement 2
    // fails. MySQL cannot roll back the committed DDL, so the table from
    // statement 1 SURVIVES and the §5 error names how far it got.
    let bad = "CREATE TABLE survives_me (id INT);\n\
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
    let msg = err.to_string();
    assert!(
        msg.contains("statement 2 of 2"),
        "names the failing stmt: {msg}"
    );
    assert!(
        msg.contains("were applied and were NOT rolled back"),
        "surfaces the non-atomic caveat: {msg}"
    );
    // The auto-committed table 1 is still there.
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM information_schema.tables \
         WHERE table_schema = ? AND table_name = 'survives_me'",
    )
    .bind(fresh)
    .fetch_optional(&pool)
    .await
    .expect("existence");
    assert!(
        exists.is_some(),
        "statement 1's table auto-committed (MySQL DDL)"
    );

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
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM `{fresh}`.`from_text`"))
            .fetch_one(&pool)
            .await
            .expect("count from_text");
        assert_eq!(n, 1);
    }

    let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS `{fresh}`"))
        .execute(&pool)
        .await;
    drop_fixture(&pool, schema, other).await;
}
