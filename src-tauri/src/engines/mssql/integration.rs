//! Live-MSSQL integration tests (gated behind `BYTETABLE_TEST_MSSQL_URL`).

use super::*;

use crate::features::structure::domain::AlterOp;
use crate::shared::engine::{
    ColumnStatsRequest, Combinator, Condition, ConnectSecret, DeleteRowsRequest, FetchRowsRequest,
    FilterOp, FilterSpec, FilterValue, PkPredicate, QueryOptions, RowLookupRequest, SortDirection,
    SortSpec, UpdateCellRequest,
};

/// Parse `mssql://user:password@host:port/db`.
fn parse_url(url: &str) -> (ConnectionParams, Option<ConnectSecret>) {
    let rest = url.strip_prefix("mssql://").expect("mssql:// scheme");
    let (creds_host, db) = rest.split_once('/').expect("db path");
    let (creds, host_port) = creds_host.split_once('@').expect("@ separator");
    let (user, password) = match creds.split_once(':') {
        Some((u, p)) => (u.to_string(), Some(p.to_string())),
        None => (creds.to_string(), None),
    };
    let (host, port) = match host_port.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(1433)),
        None => (host_port.to_string(), 1433),
    };
    let params = ConnectionParams::Mssql {
        host,
        port,
        database: Some(db.to_string()),
        user: Some(user),
        tls_mode: crate::shared::engine::TlsMode::Disable,
        ssh: None,
    };
    (params, password.map(ConnectSecret::new))
}

fn gate(test: &str) -> Option<(ConnectionParams, Option<ConnectSecret>)> {
    match std::env::var("BYTETABLE_TEST_MSSQL_URL") {
        Ok(url) if !url.is_empty() => Some(parse_url(&url)),
        _ => {
            eprintln!("SKIP {test}: BYTETABLE_TEST_MSSQL_URL not set (live SQL Server required)");
            None
        }
    }
}

async fn open_conn(
    params: &ConnectionParams,
    secret: &Option<ConnectSecret>,
) -> std::sync::Arc<dyn EngineConnection> {
    MssqlConnector
        .open_with_secret(params, secret.as_ref())
        .await
        .expect("open mssql connection")
        .into_sql()
        .expect("sql connection")
}

/// Seed a fixture (dbo tables + sales/audit schemas). Each statement runs on
/// its own batch (T-SQL requires `CREATE SCHEMA` to be first in its batch).
async fn setup_fixture(conn: &std::sync::Arc<dyn EngineConnection>) {
    for stmt in [
        "IF OBJECT_ID('dbo.bt_it_books','U') IS NOT NULL DROP TABLE dbo.bt_it_books",
        "IF OBJECT_ID('dbo.bt_it_authors','U') IS NOT NULL DROP TABLE dbo.bt_it_authors",
        "IF SCHEMA_ID('sales') IS NULL EXEC('CREATE SCHEMA sales')",
        "IF SCHEMA_ID('audit') IS NULL EXEC('CREATE SCHEMA audit')",
        "CREATE TABLE dbo.bt_it_authors (\
           id INT IDENTITY(1,1) PRIMARY KEY, \
           name NVARCHAR(100) NOT NULL, \
           bio NVARCHAR(MAX) NULL)",
        "CREATE TABLE dbo.bt_it_books (\
           id INT PRIMARY KEY, \
           title NVARCHAR(200) NOT NULL, \
           author_id INT NOT NULL \
             CONSTRAINT FK_bt_it_books_authors REFERENCES dbo.bt_it_authors(id) ON DELETE CASCADE, \
           price DECIMAL(10,2) DEFAULT 0, \
           in_print BIT DEFAULT 1, \
           big BIGINT NULL, \
           note NVARCHAR(MAX) NULL)",
        "CREATE INDEX idx_bt_it_books_title ON dbo.bt_it_books(title)",
        "INSERT INTO dbo.bt_it_authors (name, bio) VALUES \
           ('Ada','pioneer'),('Grace',NULL),('Linus','kernel')",
        "INSERT INTO dbo.bt_it_books (id,title,author_id,price,in_print,big,note) VALUES \
           (10,'Notes',1,9.50,1,9007199254740993,'first'), \
           (11,'Essays',1,7.25,0,1,NULL), \
           (12,'Letters',2,0.00,1,2,'third'), \
           (13,'Memoir',3,12.00,1,3,'fourth')",
    ] {
        conn.run_query(stmt, QueryOptions::default())
            .await
            .unwrap_or_else(|e| panic!("fixture stmt failed: {stmt}\n{e}"));
    }
}

#[tokio::test]
async fn mssql_full_roundtrip() {
    let Some((params, secret)) = gate("mssql_full_roundtrip") else {
        return;
    };

    // 22.0: test-connection round-trips the version.
    let info = MssqlConnector
        .test_with_secret(&params, secret.as_ref())
        .await
        .expect("test connection");
    assert_eq!(info.engine, Engine::Mssql);
    assert!(
        info.server_version.starts_with("SQL Server"),
        "version: {}",
        info.server_version
    );

    let conn = open_conn(&params, &secret).await;
    setup_fixture(&conn).await;

    // 22.1: schemas — user schemas present, system hidden.
    let schemas: Vec<String> = conn
        .list_schemas()
        .await
        .expect("list_schemas")
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert!(schemas.contains(&"dbo".to_string()), "schemas: {schemas:?}");
    assert!(
        schemas.contains(&"sales".to_string()),
        "schemas: {schemas:?}"
    );
    assert!(
        schemas.contains(&"audit".to_string()),
        "schemas: {schemas:?}"
    );
    assert!(!schemas.contains(&"sys".to_string()), "sys must be hidden");

    // list_tables.
    let tables: Vec<String> = conn
        .list_tables("dbo")
        .await
        .expect("list_tables")
        .into_iter()
        .map(|t| t.name)
        .collect();
    assert!(
        tables.contains(&"bt_it_books".to_string()),
        "tables: {tables:?}"
    );
    assert!(tables.contains(&"bt_it_authors".to_string()));

    // table_meta: columns, pk, fk, index, bracket-quoted DDL, IDENTITY.
    let meta = conn
        .table_meta("dbo", "bt_it_books")
        .await
        .expect("table_meta");
    let col_names: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        col_names,
        vec![
            "id",
            "title",
            "author_id",
            "price",
            "in_print",
            "big",
            "note"
        ]
    );
    let id_col = meta.columns.iter().find(|c| c.name == "id").unwrap();
    assert!(id_col.pk, "id is pk");
    let title_col = meta.columns.iter().find(|c| c.name == "title").unwrap();
    assert_eq!(title_col.data_type, "NVARCHAR(200)");
    let author_col = meta.columns.iter().find(|c| c.name == "author_id").unwrap();
    assert_eq!(
        author_col.fk.as_ref().map(|f| f.table.as_str()),
        Some("bt_it_authors")
    );
    assert!(!meta.foreign_keys.is_empty(), "books has a fk");
    assert!(meta.indexes.iter().any(|i| i.primary), "pk index present");
    assert!(
        meta.indexes
            .iter()
            .any(|i| i.name == "idx_bt_it_books_title"),
        "title index present"
    );
    let ddl = meta.ddl.as_deref().unwrap_or("");
    assert!(
        ddl.contains("[dbo].[bt_it_books]"),
        "bracket-quoted DDL: {ddl}"
    );

    // authors DDL surfaces IDENTITY.
    let authors_meta = conn.table_meta("dbo", "bt_it_authors").await.unwrap();
    let authors_ddl = authors_meta.ddl.as_deref().unwrap_or("");
    assert!(
        authors_ddl.contains("IDENTITY"),
        "authors DDL has IDENTITY: {authors_ddl}"
    );

    // fetch_rows: total count + paging + filter (author_id = 1 → 2 books).
    let page = conn
        .fetch_rows(FetchRowsRequest {
            schema: "dbo".into(),
            table: "bt_it_books".into(),
            sort: Some(SortSpec {
                column: "id".into(),
                direction: SortDirection::Asc,
            }),
            filter: Some(FilterSpec::Conditions {
                items: vec![Condition {
                    column: "author_id".into(),
                    op: FilterOp::Eq,
                    value: Some(FilterValue::Scalar(serde_json::json!(1))),
                    binary: false,
                }],
                combinator: Combinator::And,
            }),
            offset: 0,
            limit: 10,
        })
        .await
        .expect("fetch_rows");
    assert_eq!(page.total_rows, Some(2), "author 1 has 2 books");
    assert_eq!(page.rows.len(), 2);

    // Type decoding: the `big` bigint (> 2^53) is a string; `in_print` bit is
    // 0/1; `price` decimal round-trips.
    let all = conn
        .fetch_rows(FetchRowsRequest {
            schema: "dbo".into(),
            table: "bt_it_books".into(),
            sort: Some(SortSpec {
                column: "id".into(),
                direction: SortDirection::Asc,
            }),
            filter: None,
            offset: 0,
            limit: 10,
        })
        .await
        .expect("fetch_rows all");
    assert_eq!(all.total_rows, Some(4));
    let cols: Vec<&str> = all.columns.iter().map(|c| c.name.as_str()).collect();
    let big_idx = cols.iter().position(|c| *c == "big").unwrap();
    let bit_idx = cols.iter().position(|c| *c == "in_print").unwrap();
    // Row 0 = book 10 (Notes): big 9007199254740993 (string), in_print 1.
    assert_eq!(all.rows[0][big_idx], serde_json::json!("9007199254740993"));
    assert_eq!(all.rows[0][bit_idx], serde_json::json!(1));

    // run_query returns a SELECT result set.
    let res = conn
        .run_query(
            "SELECT COUNT(*) AS n FROM dbo.bt_it_books",
            QueryOptions::default(),
        )
        .await
        .expect("run_query");
    assert_eq!(res.row_count, 1);

    // Teardown (drop the fixture's empty sales/audit too, so a run against a
    // scratch db like `master` leaves no leftover schemas; against a seeded
    // db they hold tables and the DROP is a harmless no-op we ignore).
    let _ = conn
        .run_query("DROP TABLE dbo.bt_it_books", QueryOptions::default())
        .await;
    let _ = conn
        .run_query("DROP TABLE dbo.bt_it_authors", QueryOptions::default())
        .await;
    let _ = conn
        .run_query("DROP SCHEMA IF EXISTS sales", QueryOptions::default())
        .await;
    let _ = conn
        .run_query("DROP SCHEMA IF EXISTS audit", QueryOptions::default())
        .await;
    let _ = conn.close().await;
}

#[tokio::test]
async fn mssql_mutation_roundtrip() {
    let Some((params, secret)) = gate("mssql_mutation_roundtrip") else {
        return;
    };
    let conn = open_conn(&params, &secret).await;
    setup_fixture(&conn).await;

    // FK peek: look up author id=1 → Ada.
    let peek = conn
        .fetch_row_by_key(RowLookupRequest {
            schema: "dbo".into(),
            table: "bt_it_authors".into(),
            column: "id".into(),
            value: serde_json::json!(1),
            binary: false,
        })
        .await
        .expect("fetch_row_by_key");
    assert_eq!(peek.match_count, 1);
    assert!(peek.row.is_some());

    // Column insights over books.price (numeric).
    let stats = conn
        .column_stats(ColumnStatsRequest {
            schema: "dbo".into(),
            table: "bt_it_books".into(),
            column: "price".into(),
            filter: None,
        })
        .await
        .expect("column_stats");
    assert_eq!(stats.total, 4);
    assert!(stats.numeric);
    assert!(stats.avg.is_some());

    // Inline edit: set note on book 11, then confirm.
    let upd = conn
        .update_cell(UpdateCellRequest {
            schema: "dbo".into(),
            table: "bt_it_books".into(),
            column: "note".into(),
            value: serde_json::json!("edited"),
            pk: vec![PkPredicate {
                column: "id".into(),
                value: serde_json::json!(11),
                binary: false,
            }],
            binary: false,
        })
        .await
        .expect("update_cell");
    assert_eq!(upd.affected, 1);

    // Staged ALTER: preview (no mutation) then apply add + rename + retype.
    let ops = vec![
        AlterOp::AddColumn {
            name: "rating".into(),
            data_type: "INT".into(),
            nullable: true,
            default_value: None,
        },
        AlterOp::ChangeType {
            column: "title".into(),
            new_type: "NVARCHAR(300)".into(),
        },
        AlterOp::RenameColumn {
            from: "note".into(),
            to: "remark".into(),
        },
    ];
    let preview = conn
        .alter_table("dbo", "bt_it_books", &ops, false)
        .await
        .expect("alter preview");
    assert!(!preview.applied);
    assert_eq!(preview.statements.len(), 3);
    let applied = conn
        .alter_table("dbo", "bt_it_books", &ops, true)
        .await
        .expect("alter apply");
    assert!(applied.applied);
    let meta = conn.table_meta("dbo", "bt_it_books").await.unwrap();
    let names: Vec<&str> = meta.columns.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"rating"), "added column present: {names:?}");
    assert!(
        names.contains(&"remark"),
        "renamed column present: {names:?}"
    );
    assert!(!names.contains(&"note"), "old name gone");
    let title = meta.columns.iter().find(|c| c.name == "title").unwrap();
    assert_eq!(title.data_type, "NVARCHAR(300)");

    // Bulk insert two rows (id/title/author_id).
    let inserted = conn
        .bulk_insert(
            "dbo",
            "bt_it_books",
            &["id".into(), "title".into(), "author_id".into()],
            &[false, false, false],
            &[
                vec![
                    serde_json::json!(20),
                    serde_json::json!("Gen1"),
                    serde_json::json!(1),
                ],
                vec![
                    serde_json::json!(21),
                    serde_json::json!("Gen2"),
                    serde_json::json!(2),
                ],
            ],
        )
        .await
        .expect("bulk_insert");
    assert_eq!(inserted, 2);

    // Delete book 13.
    let del = conn
        .delete_rows(DeleteRowsRequest {
            schema: "dbo".into(),
            table: "bt_it_books".into(),
            rows: vec![vec![PkPredicate {
                column: "id".into(),
                value: serde_json::json!(13),
                binary: false,
            }]],
        })
        .await
        .expect("delete_rows");
    assert_eq!(del.deleted, 1);

    // Truncate leaves the table empty.
    let removed = conn
        .truncate_table("dbo", "bt_it_books")
        .await
        .expect("truncate");
    assert!(removed >= 4, "truncate removed prior rows: {removed}");
    let after = conn.list_tables("dbo").await.unwrap();
    assert!(
        after.iter().any(|t| t.name == "bt_it_books"),
        "table still exists"
    );

    // create/drop schema.
    let _ = conn
        .run_query("DROP TABLE IF EXISTS bt_it_sch.t", QueryOptions::default())
        .await;
    let _ = conn
        .run_query(
            "IF SCHEMA_ID('bt_it_sch') IS NOT NULL DROP SCHEMA bt_it_sch",
            QueryOptions::default(),
        )
        .await;
    conn.create_schema("bt_it_sch")
        .await
        .expect("create_schema");
    conn.run_query(
        "CREATE TABLE bt_it_sch.t (id INT PRIMARY KEY)",
        QueryOptions::default(),
    )
    .await
    .expect("create table in schema");
    conn.drop_schema("bt_it_sch")
        .await
        .expect("drop_schema empties");
    let sch_tables = conn
        .list_tables("bt_it_sch")
        .await
        .expect("list after drop");
    assert!(sch_tables.is_empty(), "schema emptied");
    let _ = conn
        .run_query("DROP SCHEMA bt_it_sch", QueryOptions::default())
        .await;

    // Teardown (see full_roundtrip note on the schema drops).
    let _ = conn
        .run_query("DROP TABLE dbo.bt_it_books", QueryOptions::default())
        .await;
    let _ = conn
        .run_query("DROP TABLE dbo.bt_it_authors", QueryOptions::default())
        .await;
    let _ = conn
        .run_query("DROP SCHEMA IF EXISTS sales", QueryOptions::default())
        .await;
    let _ = conn
        .run_query("DROP SCHEMA IF EXISTS audit", QueryOptions::default())
        .await;
    let _ = conn.close().await;
}
