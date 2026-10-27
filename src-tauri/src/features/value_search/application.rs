//! The sweep: walk every table in scope, ask it whether it holds the needle,
//! and stream each hit back as it lands. Depends on the shared engine
//! abstraction plus the connections feature's `ConnectionManager` (the
//! cross-feature composition documented in the slice docs). No Tauri, no
//! drivers.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::{
    ColumnMeta, Combinator, EngineConnection, FetchRowsRequest, FilterSpec,
};
use crate::shared::error::AppError;

use super::domain::{
    conditions_for, matched_columns, MatchMode, DEFAULT_MAX_HIT_TABLES, DEFAULT_PER_TABLE_LIMIT,
};

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// What the renderer asks for beyond the needle itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ValueSearchOptions {
    pub mode: MatchMode,
    /// Schemas to sweep. Empty means every schema the connection reports,
    /// minus the system ones unless [`Self::include_system_schemas`] is set.
    pub schemas: Vec<String>,
    /// Matching rows kept per table.
    pub per_table_limit: u32,
    /// Stop once this many tables have produced a hit.
    pub max_hit_tables: u32,
    /// Sweep the engine's own catalog too. Off by default: it is large, slow,
    /// and almost never what the user meant.
    pub include_system_schemas: bool,
}

impl Default for ValueSearchOptions {
    fn default() -> Self {
        Self {
            mode: MatchMode::default(),
            schemas: Vec::new(),
            per_table_limit: DEFAULT_PER_TABLE_LIMIT,
            max_hit_tables: DEFAULT_MAX_HIT_TABLES,
            include_system_schemas: false,
        }
    }
}

/// One table that holds the needle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableHit {
    pub schema: String,
    pub table: String,
    pub columns: Vec<ColumnMeta>,
    /// The first page of matching rows, capped at
    /// [`ValueSearchOptions::per_table_limit`].
    pub rows: Vec<Vec<Value>>,
    /// Columns the needle was actually found in, across the returned page.
    pub matched_columns: Vec<String>,
    /// Exact count of matching rows in the whole table — the engine computes
    /// it alongside the page. `None` only when the adapter could not.
    pub total_matches: Option<u64>,
    /// More matches exist than the returned page holds.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// A table the sweep could not read. Never aborts the run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableError {
    pub schema: String,
    pub table: String,
    pub message: String,
}

/// A progress tick, emitted once per table. Carries the table's hit (when it
/// had one) so the renderer fills results live instead of waiting for the whole
/// sweep.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    pub schema: String,
    pub table: String,
    /// Tables finished, including this one.
    pub done: u64,
    pub total: u64,
    /// Tables with a hit so far.
    pub hit_tables: u64,
    pub hit: Option<TableHit>,
}

/// The outcome of a whole sweep. Authoritative — it repeats every hit already
/// streamed over the progress channel, so a renderer may ignore the stream and
/// just take this.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSearchSummary {
    pub needle: String,
    pub hits: Vec<TableHit>,
    /// Tables actually queried.
    pub tables_scanned: u64,
    /// Tables skipped because no column could hold the needle (all binary, or
    /// in exact mode no column of a fitting type).
    pub tables_skipped: u64,
    /// Total tables in scope, including skipped ones.
    pub tables_total: u64,
    pub errors: Vec<TableError>,
    /// The user cancelled between tables.
    pub cancelled: bool,
    /// The sweep stopped itself at [`ValueSearchOptions::max_hit_tables`].
    pub stopped_early: bool,
    pub elapsed_ms: u64,
}

/// Per-run controls passed into [`run_search`], mirroring the generate slice.
pub struct RunCtx<'a> {
    pub cancel: &'a AtomicBool,
    pub on_progress: &'a (dyn Fn(SearchProgress) + Send + Sync),
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/// Find `needle` in every table in scope.
///
/// **A full table scan per table.** No index answers "this value in any
/// column", so each table in scope is read end to end; the adapters pair the
/// filtered page with an exact filtered count, so it is two passes per table.
/// Tables are visited smallest-first (by the engine's row estimate) so the
/// cheap answers arrive while the expensive ones are still running, `ctx.cancel`
/// is honored between tables, and a table that fails is recorded and stepped
/// over rather than aborting the sweep — one unreadable view should not cost
/// the user the other two hundred tables.
///
/// Read-only throughout: no `ensure_writable` gate, and nothing here issues a
/// statement that is not a `SELECT`.
pub async fn run_search(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    needle: &str,
    options: &ValueSearchOptions,
    ctx: RunCtx<'_>,
) -> Result<ValueSearchSummary, AppError> {
    let started = Instant::now();

    if needle.trim().is_empty() {
        return Err(AppError::Invalid(
            "Enter a value to search for. An empty search would match every row in every table."
                .into(),
        ));
    }

    let sql = manager.get_sql(handle).await?;
    let targets = collect_targets(&*sql, options).await?;
    let tables_total = targets.len() as u64;

    let per_table_limit = options.per_table_limit.max(1);
    let max_hit_tables = options.max_hit_tables.max(1) as usize;

    let mut hits: Vec<TableHit> = Vec::new();
    let mut errors: Vec<TableError> = Vec::new();
    let mut tables_scanned = 0u64;
    let mut tables_skipped = 0u64;
    let mut done = 0u64;
    let mut cancelled = false;
    let mut stopped_early = false;

    for (schema, table) in targets {
        if ctx.cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        done += 1;

        // Which columns can hold the needle at all. A table whose metadata we
        // cannot read is an error row, not a dead sweep.
        let meta = match sql.table_meta(&schema, &table).await {
            Ok(meta) => meta,
            Err(err) => {
                errors.push(TableError {
                    schema: schema.clone(),
                    table: table.clone(),
                    message: err.to_string(),
                });
                tick(&ctx, &schema, &table, done, tables_total, hits.len(), None);
                continue;
            }
        };

        let conditions = conditions_for(&meta.columns, needle, options.mode);
        if conditions.is_empty() {
            tables_skipped += 1;
            tick(&ctx, &schema, &table, done, tables_total, hits.len(), None);
            continue;
        }

        let table_started = Instant::now();
        let page = sql
            .fetch_rows(FetchRowsRequest {
                schema: schema.clone(),
                table: table.clone(),
                sort: None,
                filter: Some(FilterSpec::Conditions {
                    items: conditions,
                    // Any one column matching is a hit — that is the whole
                    // question being asked.
                    combinator: Combinator::Or,
                }),
                offset: 0,
                limit: per_table_limit,
            })
            .await;
        tables_scanned += 1;

        let hit = match page {
            Ok(page) if page.rows.is_empty() => None,
            Ok(page) => {
                let matched = matched_columns(&page.columns, &page.rows, needle, options.mode);
                let truncated = page
                    .total_rows
                    .is_some_and(|total| total > page.rows.len() as u64);
                Some(TableHit {
                    schema: schema.clone(),
                    table: table.clone(),
                    columns: page.columns,
                    rows: page.rows,
                    matched_columns: matched,
                    total_matches: page.total_rows,
                    truncated,
                    elapsed_ms: table_started.elapsed().as_millis() as u64,
                })
            }
            Err(err) => {
                errors.push(TableError {
                    schema: schema.clone(),
                    table: table.clone(),
                    message: err.to_string(),
                });
                None
            }
        };

        if let Some(hit) = hit {
            hits.push(hit.clone());
            tick(
                &ctx,
                &schema,
                &table,
                done,
                tables_total,
                hits.len(),
                Some(hit),
            );
            if hits.len() >= max_hit_tables {
                stopped_early = true;
                break;
            }
        } else {
            tick(&ctx, &schema, &table, done, tables_total, hits.len(), None);
        }
    }

    Ok(ValueSearchSummary {
        needle: needle.to_string(),
        hits,
        tables_scanned,
        tables_skipped,
        tables_total,
        errors,
        cancelled,
        stopped_early,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Emit one progress tick.
fn tick(
    ctx: &RunCtx<'_>,
    schema: &str,
    table: &str,
    done: u64,
    total: u64,
    hit_tables: usize,
    hit: Option<TableHit>,
) {
    (ctx.on_progress)(SearchProgress {
        schema: schema.to_string(),
        table: table.to_string(),
        done,
        total,
        hit_tables: hit_tables as u64,
        hit,
    });
}

/// Every `(schema, table)` the sweep will visit, smallest table first.
///
/// Ordering by the engine's row estimate is what makes a sweep of a large
/// database usable: the user sees hits from the small lookup tables within a
/// second or two and can cancel once they have their answer, instead of waiting
/// on the 40-million-row events table to decide whether anything matched.
/// Engines with no estimate (SQLite) report `None`, which sorts last and leaves
/// their natural order intact.
async fn collect_targets(
    sql: &dyn EngineConnection,
    options: &ValueSearchOptions,
) -> Result<Vec<(String, String)>, AppError> {
    let schemas: Vec<String> = if options.schemas.is_empty() {
        // `list_schemas` is user data only by contract; the engine's own
        // catalog is a separate, opt-in call.
        let mut all = sql.list_schemas().await?;
        if options.include_system_schemas {
            all.extend(sql.list_system_schemas().await.unwrap_or_default());
        }
        all.into_iter().map(|s| s.name).collect()
    } else {
        options.schemas.clone()
    };

    let mut targets: Vec<(String, String)> = Vec::new();
    for schema in schemas {
        // A schema that vanished or that we cannot list is not fatal — the
        // other schemas are still worth sweeping.
        let Ok(mut tables) = sql.list_tables(&schema).await else {
            continue;
        };
        tables.sort_by_key(|t| t.approx_row_count.unwrap_or(u64::MAX));
        targets.extend(tables.into_iter().map(|t| (schema.clone(), t.name)));
    }
    Ok(targets)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::shared::engine::{
        ColumnInfo, Condition, Engine, EngineInfo, FilterOp, FilterValue, OpenConnection,
        QueryOptions, QueryResult, RowsPage, SchemaInfo, TableInfo, TableMeta,
    };

    /// A fake SQL connection over an in-memory catalog, enough to drive the
    /// sweep: it records the filters it was asked for and answers from a
    /// per-table row list.
    struct FakeDb {
        /// User schemas, as `list_schemas` reports them.
        schemas: Vec<SchemaInfo>,
        /// The engine's own catalog, behind `list_system_schemas`.
        system_schemas: Vec<SchemaInfo>,
        tables: HashMap<String, Vec<TableInfo>>,
        /// "schema.table" → (columns, rows)
        content: HashMap<String, (Vec<ColumnInfo>, Vec<Vec<Value>>)>,
        /// Tables whose `fetch_rows` fails, simulating a broken view.
        failing: Vec<String>,
        asked: Mutex<Vec<String>>,
    }

    impl FakeDb {
        fn key(schema: &str, table: &str) -> String {
            format!("{schema}.{table}")
        }
    }

    #[async_trait]
    impl EngineConnection for FakeDb {
        fn engine_info(&self) -> EngineInfo {
            EngineInfo {
                engine: Engine::Sqlite,
                server_version: "fake".into(),
            }
        }

        async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
            Ok(self.schemas.clone())
        }

        async fn list_system_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
            Ok(self.system_schemas.clone())
        }

        async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, AppError> {
            Ok(self.tables.get(schema).cloned().unwrap_or_default())
        }

        async fn table_meta(&self, schema: &str, table: &str) -> Result<TableMeta, AppError> {
            let key = Self::key(schema, table);
            let (columns, _) = self
                .content
                .get(&key)
                .ok_or_else(|| AppError::NotFound(format!("no such table {key}")))?;
            Ok(TableMeta {
                columns: columns.clone(),
                ..Default::default()
            })
        }

        async fn run_query(&self, _sql: &str, _o: QueryOptions) -> Result<QueryResult, AppError> {
            unreachable!("the sweep never runs raw SQL")
        }

        async fn fetch_rows(&self, req: FetchRowsRequest) -> Result<RowsPage, AppError> {
            let key = Self::key(&req.schema, &req.table);
            self.asked.lock().unwrap().push(key.clone());
            if self.failing.contains(&key) {
                return Err(AppError::Database(format!("relation {key} is broken")));
            }
            let (columns, rows) = self.content.get(&key).expect("known table");

            // Minimal stand-in for the adapters' WHERE compilation: OR of
            // per-column substring / equality over the cell's rendering.
            let FilterSpec::Conditions { items, .. } = req.filter.as_ref().expect("a filter")
            else {
                panic!("the sweep only builds structured conditions")
            };
            let matches = |row: &Vec<Value>| {
                items.iter().any(|c: &Condition| {
                    let Some(idx) = columns.iter().position(|col| col.name == c.column) else {
                        return false;
                    };
                    let cell = row[idx].to_string().to_lowercase();
                    let Some(FilterValue::Scalar(v)) = &c.value else {
                        return false;
                    };
                    let want = match v {
                        Value::String(s) => s.to_lowercase(),
                        other => other.to_string().to_lowercase(),
                    };
                    match c.op {
                        FilterOp::Contains => cell.contains(&want),
                        FilterOp::Eq => cell.trim_matches('"') == want,
                        _ => false,
                    }
                })
            };

            let hit: Vec<Vec<Value>> = rows.iter().filter(|r| matches(r)).cloned().collect();
            let total = hit.len() as u64;
            Ok(RowsPage {
                columns: columns
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name.clone(),
                        type_hint: c.data_type.clone(),
                    })
                    .collect(),
                rows: hit.into_iter().take(req.limit as usize).collect(),
                offset: 0,
                limit: req.limit,
                total_rows: Some(total),
                elapsed_ms: 0,
            })
        }

        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    fn col(name: &str, ty: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable: true,
            pk: false,
            default_value: None,
            fk: None,
            comment: None,
            auto_increment: false,
        }
    }

    fn table(name: &str, rows: Option<u64>) -> TableInfo {
        TableInfo {
            name: name.into(),
            approx_row_count: rows,
            ..Default::default()
        }
    }

    /// users (small) + events (huge) + audit (system schema) + broken view.
    fn fake() -> FakeDb {
        let mut tables = HashMap::new();
        tables.insert(
            "public".to_string(),
            vec![
                table("events", Some(40_000_000)),
                table("users", Some(12)),
                table("broken_view", Some(1)),
            ],
        );
        tables.insert("pg_catalog".to_string(), vec![table("pg_class", Some(400))]);

        let mut content = HashMap::new();
        content.insert(
            "public.users".to_string(),
            (
                vec![col("id", "bigint"), col("email", "text")],
                vec![
                    vec![Value::from(1i64), Value::String("ada@example.com".into())],
                    vec![Value::from(2i64), Value::String("grace@example.com".into())],
                ],
            ),
        );
        content.insert(
            "public.events".to_string(),
            (
                vec![col("id", "bigint"), col("actor", "text")],
                vec![vec![
                    Value::from(9i64),
                    Value::String("ada@example.com".into()),
                ]],
            ),
        );
        content.insert(
            "public.broken_view".to_string(),
            (vec![col("x", "text")], vec![]),
        );
        content.insert(
            "pg_catalog.pg_class".to_string(),
            (
                vec![col("relname", "text")],
                vec![vec![Value::String("ada@example.com".into())]],
            ),
        );

        FakeDb {
            schemas: vec![SchemaInfo {
                name: "public".into(),
                table_count: Some(3),
                is_system: false,
            }],
            system_schemas: vec![SchemaInfo {
                name: "pg_catalog".into(),
                table_count: Some(1),
                is_system: true,
            }],
            tables,
            content,
            failing: vec!["public.broken_view".to_string()],
            asked: Mutex::new(Vec::new()),
        }
    }

    /// Drive a sweep, returning the summary and the ticks it emitted.
    async fn sweep(
        db: FakeDb,
        needle: &str,
        options: ValueSearchOptions,
        cancel_after: Option<u64>,
    ) -> (ValueSearchSummary, Vec<SearchProgress>) {
        let manager = ConnectionManager::new();
        let handle = manager.insert(OpenConnection::sql(db)).await;
        let cancel = AtomicBool::new(false);
        let ticks: Mutex<Vec<SearchProgress>> = Mutex::new(Vec::new());
        let on_progress = |p: SearchProgress| {
            if Some(p.done) == cancel_after {
                cancel.store(true, Ordering::Relaxed);
            }
            ticks.lock().unwrap().push(p);
        };
        let summary = run_search(
            &manager,
            &handle,
            needle,
            &options,
            RunCtx {
                cancel: &cancel,
                on_progress: &on_progress,
            },
        )
        .await
        .expect("sweep");
        let ticks = ticks.into_inner().unwrap();
        (summary, ticks)
    }

    #[tokio::test]
    async fn finds_the_value_in_every_table_that_holds_it() {
        let (summary, _) = fake_sweep("ada@example.com").await;
        let found: Vec<&str> = summary.hits.iter().map(|h| h.table.as_str()).collect();
        assert_eq!(found, ["users", "events"]);
        assert_eq!(summary.hits[0].matched_columns, ["email"]);
        assert_eq!(summary.hits[0].total_matches, Some(1));
    }

    async fn fake_sweep(needle: &str) -> (ValueSearchSummary, Vec<SearchProgress>) {
        sweep(fake(), needle, ValueSearchOptions::default(), None).await
    }

    #[tokio::test]
    async fn visits_small_tables_before_large_ones() {
        let (_, ticks) = fake_sweep("ada@example.com").await;
        let order: Vec<&str> = ticks.iter().map(|t| t.table.as_str()).collect();
        // broken_view (1 row) < users (12) < events (40M).
        assert_eq!(order, ["broken_view", "users", "events"]);
    }

    #[tokio::test]
    async fn system_schemas_are_left_out_unless_asked_for() {
        let (summary, _) = fake_sweep("ada@example.com").await;
        assert!(summary.hits.iter().all(|h| h.schema == "public"));

        let (summary, _) = sweep(
            fake(),
            "ada@example.com",
            ValueSearchOptions {
                include_system_schemas: true,
                ..Default::default()
            },
            None,
        )
        .await;
        assert!(summary.hits.iter().any(|h| h.schema == "pg_catalog"));
    }

    #[tokio::test]
    async fn a_broken_table_is_recorded_and_the_sweep_carries_on() {
        let (summary, _) = fake_sweep("ada@example.com").await;
        assert_eq!(summary.errors.len(), 1);
        assert_eq!(summary.errors[0].table, "broken_view");
        assert!(summary.errors[0].message.contains("broken"));
        // The two good tables were still searched.
        assert_eq!(summary.hits.len(), 2);
    }

    #[tokio::test]
    async fn hits_stream_as_they_land() {
        let (summary, ticks) = fake_sweep("ada@example.com").await;
        let streamed: Vec<&str> = ticks
            .iter()
            .filter_map(|t| t.hit.as_ref())
            .map(|h| h.table.as_str())
            .collect();
        assert_eq!(streamed, ["users", "events"]);
        // The summary repeats them, so a renderer may ignore the stream.
        assert_eq!(streamed.len(), summary.hits.len());
    }

    #[tokio::test]
    async fn cancelling_stops_between_tables() {
        // Cancel once the first table has reported.
        let (summary, ticks) = sweep(
            fake(),
            "ada@example.com",
            ValueSearchOptions::default(),
            Some(1),
        )
        .await;
        assert!(summary.cancelled);
        assert_eq!(ticks.len(), 1);
        assert!(summary.hits.is_empty());
    }

    #[tokio::test]
    async fn stops_itself_once_enough_tables_have_matched() {
        let (summary, _) = sweep(
            fake(),
            "ada@example.com",
            ValueSearchOptions {
                max_hit_tables: 1,
                ..Default::default()
            },
            None,
        )
        .await;
        assert!(summary.stopped_early);
        assert_eq!(summary.hits.len(), 1);
        assert!(!summary.cancelled);
    }

    #[tokio::test]
    async fn exact_mode_skips_tables_no_column_could_match() {
        // "ada@example.com" fits no column of `events` in exact mode? It does
        // (actor is text) — but an integer-only table is skipped outright.
        let mut db = fake();
        db.tables.insert(
            "public".to_string(),
            vec![table("counters", Some(3)), table("users", Some(12))],
        );
        db.content.insert(
            "public.counters".to_string(),
            (
                vec![col("id", "bigint"), col("n", "integer")],
                vec![vec![Value::from(1i64), Value::from(5i64)]],
            ),
        );
        let (summary, _) = sweep(
            db,
            "ada@example.com",
            ValueSearchOptions {
                mode: MatchMode::Exact,
                ..Default::default()
            },
            None,
        )
        .await;
        assert_eq!(summary.tables_skipped, 1);
        assert_eq!(summary.tables_scanned, 1);
        assert_eq!(summary.hits.len(), 1);
        assert_eq!(summary.hits[0].table, "users");
    }

    #[tokio::test]
    async fn an_empty_needle_is_refused_rather_than_matching_everything() {
        let manager = ConnectionManager::new();
        let handle = manager.insert(OpenConnection::sql(fake())).await;
        let cancel = AtomicBool::new(false);
        let noop = |_: SearchProgress| {};
        let err = run_search(
            &manager,
            &handle,
            "   ",
            &ValueSearchOptions::default(),
            RunCtx {
                cancel: &cancel,
                on_progress: &noop,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }

    // -----------------------------------------------------------------------
    // End-to-end over a real engine
    // -----------------------------------------------------------------------
    //
    // The tests above drive a fake whose WHERE evaluation is ours. These drive
    // the real SQLite adapter, so they are the ones that prove the actual
    // contract this slice bets on: that a `Contains` condition per column,
    // OR'd, compiles to working SQL against columns of every type — including
    // the integer and blob columns a naive `LIKE` would choke on.

    mod over_real_sqlite {
        use super::*;
        use crate::engines::sqlite::SqliteConnector;
        use crate::shared::engine::{ConnectionParams, Connector};

        async fn seeded() -> (tempfile::TempDir, ConnectionManager, ConnectionHandleId) {
            let dir = tempfile::tempdir().expect("tempdir");
            let path = dir.path().join("search.db");
            {
                let db = rusqlite::Connection::open(&path).expect("create db");
                db.execute_batch(
                    "CREATE TABLE users (
                         id      INTEGER PRIMARY KEY,
                         email   TEXT,
                         avatar  BLOB,
                         created TEXT
                     );
                     INSERT INTO users (id, email, avatar, created) VALUES
                         (42, 'ada@example.com', x'deadbeef', '2024-01-01'),
                         (7,  'grace@example.com', NULL, '2024-02-02');

                     CREATE TABLE orders (
                         id       INTEGER PRIMARY KEY,
                         user_ref INTEGER,
                         note     TEXT
                     );
                     INSERT INTO orders (id, user_ref, note) VALUES
                         (1, 42, 'ship to ada@example.com'),
                         (2, 7,  'no email');

                     CREATE TABLE untyped (anything);
                     INSERT INTO untyped (anything) VALUES ('ada@example.com');

                     CREATE TABLE unrelated (label TEXT);
                     INSERT INTO unrelated (label) VALUES ('nothing to see');",
                )
                .expect("seed db");
            }
            let open = SqliteConnector
                .open(&ConnectionParams::Sqlite {
                    path: path.to_string_lossy().into_owned(),
                })
                .await
                .expect("open db");
            let manager = ConnectionManager::new();
            let handle = manager.insert(open).await;
            (dir, manager, handle)
        }

        async fn search(
            manager: &ConnectionManager,
            handle: &ConnectionHandleId,
            needle: &str,
            mode: MatchMode,
        ) -> ValueSearchSummary {
            let cancel = AtomicBool::new(false);
            let noop = |_: SearchProgress| {};
            run_search(
                manager,
                handle,
                needle,
                &ValueSearchOptions {
                    mode,
                    ..Default::default()
                },
                RunCtx {
                    cancel: &cancel,
                    on_progress: &noop,
                },
            )
            .await
            .expect("sweep")
        }

        #[tokio::test]
        async fn finds_a_value_across_tables_and_names_the_columns() {
            let (_dir, manager, handle) = seeded().await;
            let summary = search(&manager, &handle, "ada@example.com", MatchMode::Contains).await;

            let mut found: Vec<(String, Vec<String>)> = summary
                .hits
                .iter()
                .map(|h| (h.table.clone(), h.matched_columns.clone()))
                .collect();
            found.sort();
            assert_eq!(
                found,
                vec![
                    ("orders".to_string(), vec!["note".to_string()]),
                    ("untyped".to_string(), vec!["anything".to_string()]),
                    ("users".to_string(), vec!["email".to_string()]),
                ]
            );
            // The table that does not hold it is reported as scanned, not as a
            // hit, and nothing errored along the way.
            assert!(summary.errors.is_empty(), "{:?}", summary.errors);
            assert_eq!(summary.tables_scanned, 4);
        }

        #[tokio::test]
        async fn an_integer_column_is_searchable_as_text() {
            // `orders.user_ref` is an INTEGER holding 42. A plain `LIKE` on an
            // int is exactly the case the adapters' text cast exists for, and
            // the whole "paste an id, find where it lives" use-case rides on
            // it working.
            let (_dir, manager, handle) = seeded().await;
            let summary = search(&manager, &handle, "42", MatchMode::Contains).await;

            let orders = summary
                .hits
                .iter()
                .find(|h| h.table == "orders")
                .expect("orders matched");
            assert_eq!(orders.matched_columns, ["user_ref"]);

            let users = summary
                .hits
                .iter()
                .find(|h| h.table == "users")
                .expect("users matched");
            assert_eq!(users.matched_columns, ["id"]);
            assert_eq!(users.total_matches, Some(1));
        }

        #[tokio::test]
        async fn a_blob_column_is_never_scanned() {
            // `users.avatar` holds x'deadbeef'. Searching "deadbeef" must not
            // find it: a hex rendering of binary is not something a user pasted,
            // and matching it would be noise in every result.
            let (_dir, manager, handle) = seeded().await;
            let summary = search(&manager, &handle, "deadbeef", MatchMode::Contains).await;
            assert!(summary.hits.is_empty(), "{:?}", summary.hits);
            assert!(summary.errors.is_empty(), "{:?}", summary.errors);
        }

        #[tokio::test]
        async fn wildcards_in_the_needle_are_literal_not_patterns() {
            // "%" would match every row of every table if the adapters did not
            // escape it. They do — so a needle of "%" finds nothing here.
            let (_dir, manager, handle) = seeded().await;
            let summary = search(&manager, &handle, "%", MatchMode::Contains).await;
            assert!(summary.hits.is_empty(), "{:?}", summary.hits);
        }

        #[tokio::test]
        async fn exact_mode_matches_whole_values_only() {
            let (_dir, manager, handle) = seeded().await;

            // Contains finds the fragment inside `orders.note`; exact does not.
            let loose = search(&manager, &handle, "ada@example.com", MatchMode::Contains).await;
            assert!(loose.hits.iter().any(|h| h.table == "orders"));

            let strict = search(&manager, &handle, "ada@example.com", MatchMode::Exact).await;
            let tables: Vec<&str> = strict.hits.iter().map(|h| h.table.as_str()).collect();
            assert!(tables.contains(&"users"), "{tables:?}");
            assert!(!tables.contains(&"orders"), "{tables:?}");
        }
    }

    #[tokio::test]
    async fn a_closed_handle_is_a_not_found_with_a_human_message() {
        let manager = ConnectionManager::new();
        let cancel = AtomicBool::new(false);
        let noop = |_: SearchProgress| {};
        let err = run_search(
            &manager,
            &ConnectionHandleId("ghost".into()),
            "x",
            &ValueSearchOptions::default(),
            RunCtx {
                cancel: &cancel,
                on_progress: &noop,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        assert!(err.to_string().contains("closed"));
    }
}
