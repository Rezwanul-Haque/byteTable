//! Use-cases for the generate slice (M16). Depends on the shared engine
//! abstraction plus the connections feature's `ConnectionManager`. No Tauri.
//!
//! Two entry points: [`build_plan`] (introspect → a display [`GeneratePlan`] for
//! the preview) and [`run_generation`] (introspect → generate rows → write them
//! via `bulk_insert`, sourcing FK values from `fetch_pk_pool`). Append-only.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::{EngineConnection, FkRef, TableMeta};
use crate::shared::error::AppError;

use super::domain::{
    ColumnPlan, GeneratePlan, GenerateSize, GenerateSummary, TablePlan, TableResult,
};
use super::generators::{self, Generator, Rng};
use super::planner;

/// Rows generated + written per `bulk_insert` chunk.
const CHUNK: u64 = 5_000;
/// Cap on how many parent keys are pulled into memory for FK sourcing.
const POOL_CAP: u64 = 100_000;

// ---------------------------------------------------------------------------
// Internal execution plan (richer than the public GeneratePlan: keeps FK
// targets, pk columns, and the concrete Generator per column).
// ---------------------------------------------------------------------------

struct ExecColumn {
    name: String,
    gen: Generator,
    fk: Option<FkRef>,
    omit: bool,
    deferred: bool,
    unique: bool,
    /// String length limit from the declared type (clamps generated text).
    max_len: Option<usize>,
    /// Binary column: values are `0x`-hex and must be bound as raw bytes.
    binary: bool,
}

struct ExecTable {
    table: String,
    role: super::domain::TableRole,
    row_count: u64,
    columns: Vec<ExecColumn>,
    pk_cols: Vec<String>,
}

struct ExecPlan {
    schema: String,
    tables: Vec<ExecTable>,
    warnings: Vec<String>,
}

fn looks_integer(ty: &str) -> bool {
    let t = ty.to_ascii_lowercase();
    t.contains("int") || t.contains("serial")
}

/// True when `col` is covered by a single-column UNIQUE index (or is the pk).
fn col_is_unique(meta: &TableMeta, col: &str, is_pk: bool) -> bool {
    is_pk
        || meta
            .indexes
            .iter()
            .any(|i| i.unique && i.columns.len() == 1 && i.columns[0] == col)
}

/// Introspect the schema and build the internal execution plan: topological FK
/// order, per-table role + row count, per-column generator + omit/defer flags.
async fn introspect_and_plan(
    sql: &dyn EngineConnection,
    schema: &str,
    size: GenerateSize,
) -> Result<ExecPlan, AppError> {
    let tables = sql.list_tables(schema).await?;
    let mut metas: Vec<(String, TableMeta)> = Vec::with_capacity(tables.len());
    for t in &tables {
        let meta = sql.table_meta(schema, &t.name).await?;
        metas.push((t.name.clone(), meta));
    }

    let deps = planner::build_deps(&metas);
    let order = planner::topo_order(&deps);

    let meta_by: HashMap<&str, &TableMeta> = metas.iter().map(|(n, m)| (n.as_str(), m)).collect();
    let deferred_by: HashMap<&str, &Vec<String>> = deps
        .iter()
        .map(|d| (d.table.as_str(), &d.deferred_fk_columns))
        .collect();

    let mut warnings = Vec::new();
    let mut exec_tables = Vec::with_capacity(order.len());

    for name in &order {
        let meta = meta_by[name.as_str()];
        let deferred_cols = deferred_by[name.as_str()];
        let role = planner::classify_role(name, meta);
        let row_count = planner::scale_rows(role, size);

        let pk_cols: Vec<String> = meta
            .columns
            .iter()
            .filter(|c| c.pk)
            .map(|c| c.name.clone())
            .collect();
        let single_int_pk = pk_cols.len() == 1
            && meta
                .columns
                .iter()
                .find(|c| c.pk)
                .map(|c| looks_integer(&c.data_type))
                .unwrap_or(false);

        let mut columns = Vec::with_capacity(meta.columns.len());
        for c in &meta.columns {
            let is_deferred = deferred_cols.iter().any(|d| d == &c.name);
            let is_autoinc = single_int_pk && c.pk;
            let unique = col_is_unique(meta, &c.name, c.pk);
            let parsed = generators::parse_type(&c.data_type);
            let gen = generators::classify_column(c, &parsed, unique, is_autoinc);

            let mut omit = matches!(gen, Generator::AutoPk);
            // Deferred FK columns are filled in a second UPDATE pass, so they are
            // not part of the INSERT. A NOT NULL deferred FK can't be NULL-then-
            // updated cleanly → warn.
            if is_deferred {
                omit = true;
                if !c.nullable {
                    warnings.push(format!(
                        "{name}.{} is a NOT NULL foreign key in a relationship cycle; \
                         it is filled in a second pass and may fail if the column \
                         rejects a temporary NULL.",
                        c.name
                    ));
                }
            }
            // A nullable column with a DEFAULT and no FK: let the DB default fire.
            if !omit && !c.pk && c.nullable && c.default_value.is_some() && c.fk.is_none() {
                omit = true;
            }

            columns.push(ExecColumn {
                name: c.name.clone(),
                gen,
                fk: c.fk.clone(),
                omit,
                deferred: is_deferred,
                unique,
                max_len: parsed.max_len,
                binary: parsed.family == generators::Family::Binary,
            });
        }

        exec_tables.push(ExecTable {
            table: name.clone(),
            role,
            row_count,
            columns,
            pk_cols,
        });
    }

    Ok(ExecPlan {
        schema: schema.to_string(),
        tables: exec_tables,
        warnings,
    })
}

/// Build the display plan for the preview (no writes).
pub async fn build_plan(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    size: GenerateSize,
) -> Result<GeneratePlan, AppError> {
    let sql = manager.get_sql(handle).await?;
    let exec = introspect_and_plan(&*sql, schema, size).await?;
    Ok(GeneratePlan {
        schema: exec.schema,
        order: exec
            .tables
            .iter()
            .map(|t| TablePlan {
                table: t.table.clone(),
                role: t.role,
                row_count: t.row_count,
                columns: t
                    .columns
                    .iter()
                    .map(|c| ColumnPlan {
                        name: c.name.clone(),
                        generator: column_label(c),
                        omit: c.omit,
                        deferred: c.deferred,
                        note: None,
                    })
                    .collect(),
            })
            .collect(),
        warnings: exec.warnings,
    })
}

fn column_label(c: &ExecColumn) -> String {
    if c.deferred {
        "foreign key (deferred)".to_string()
    } else {
        generators::label(&c.gen)
    }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/// A progress tick: `done` of `total` rows for one `table`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenProgress {
    pub table: String,
    pub done: u64,
    pub total: u64,
}

/// Per-run controls passed into [`run_generation`].
pub struct RunCtx<'a> {
    pub cancel: &'a AtomicBool,
    pub on_progress: &'a (dyn Fn(GenProgress) + Send + Sync),
    pub seed: u64,
}

/// Generate and append data for every table in `schema` at the chosen `size`.
/// Parents fill before children (topological FK order); FK columns draw from the
/// parent's key pool; self-ref / cycle FK columns are wired in a final UPDATE
/// pass. Commits per chunk, checks `ctx.cancel` between chunks (committed chunks
/// persist on cancel), and continues past a per-table failure (append semantics).
pub async fn run_generation(
    manager: &ConnectionManager,
    handle: &ConnectionHandleId,
    schema: &str,
    size: GenerateSize,
    ctx: RunCtx<'_>,
) -> Result<GenerateSummary, AppError> {
    let sql = manager.get_sql(handle).await?;
    let exec = introspect_and_plan(&*sql, schema, size).await?;

    let mut rng = Rng::new(ctx.seed);
    let mut fk_pools: HashMap<(String, String), Vec<Value>> = HashMap::new();
    let mut results: Vec<TableResult> = Vec::new();
    let mut total_inserted = 0u64;
    let mut cancelled = false;

    'tables: for t in &exec.tables {
        if ctx.cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }

        // Existing row count for this table → row-index offset so unique
        // generators don't collide with prior rows on a repeat run.
        let existing = sql
            .fetch_pk_pool(schema, &t.table, &t.pk_cols, POOL_CAP)
            .await
            .unwrap_or_default();
        let base = existing.len() as u64;

        // Preload FK pools for this table's non-deferred FK targets (parents are
        // fully inserted by now — topological order). `map_entry` lint can't
        // apply: the value is produced by an awaited call between check & insert.
        #[allow(clippy::map_entry)]
        for col in &t.columns {
            if col.deferred {
                continue;
            }
            if let Some(fk) = &col.fk {
                let key = (fk.table.clone(), fk.column.clone());
                if !fk_pools.contains_key(&key) {
                    let pool = sql
                        .fetch_pk_pool(
                            schema,
                            &fk.table,
                            std::slice::from_ref(&fk.column),
                            POOL_CAP,
                        )
                        .await
                        .unwrap_or_default();
                    let flat: Vec<Value> = pool
                        .into_iter()
                        .map(|mut r| r.pop().unwrap_or(Value::Null))
                        .collect();
                    fk_pools.insert(key, flat);
                }
            }
        }

        let insert_cols: Vec<&ExecColumn> = t.columns.iter().filter(|c| !c.omit).collect();
        let col_names: Vec<String> = insert_cols.iter().map(|c| c.name.clone()).collect();
        let col_binary: Vec<bool> = insert_cols.iter().map(|c| c.binary).collect();

        let mut inserted = 0u64;
        let mut table_error: Option<String> = None;
        let mut produced = 0u64;
        while produced < t.row_count {
            if ctx.cancel.load(Ordering::Relaxed) {
                cancelled = true;
            }
            let this_chunk = CHUNK.min(t.row_count - produced);
            let mut rows: Vec<Vec<Value>> = Vec::with_capacity(this_chunk as usize);
            for i in 0..this_chunk {
                let row_index = base + produced + i;
                let mut row = Vec::with_capacity(insert_cols.len());
                for col in &insert_cols {
                    let v = match &col.gen {
                        Generator::ForeignKey => col
                            .fk
                            .as_ref()
                            .and_then(|fk| {
                                let pool = fk_pools.get(&(fk.table.clone(), fk.column.clone()))?;
                                if pool.is_empty() {
                                    None
                                } else {
                                    Some(pool[rng.below(pool.len() as u64) as usize].clone())
                                }
                            })
                            .unwrap_or(Value::Null),
                        other => generators::generate(
                            other,
                            &mut rng,
                            row_index,
                            col.unique,
                            col.max_len,
                        ),
                    };
                    row.push(v);
                }
                rows.push(row);
            }

            match sql
                .bulk_insert(schema, &t.table, &col_names, &col_binary, &rows)
                .await
            {
                Ok(n) => {
                    inserted += n;
                    total_inserted += n;
                }
                Err(err) => {
                    table_error = Some(err.to_string());
                    break;
                }
            }
            produced += this_chunk;
            (ctx.on_progress)(GenProgress {
                table: t.table.clone(),
                done: produced,
                total: t.row_count,
            });
            if cancelled {
                results.push(TableResult {
                    table: t.table.clone(),
                    inserted,
                    error: table_error.clone(),
                });
                break 'tables;
            }
        }

        results.push(TableResult {
            table: t.table.clone(),
            inserted,
            error: table_error,
        });
    }

    // Deferred-FK pass: wire self-ref / cycle FK columns now that every table
    // has rows. Best-effort: a failure is recorded but does not abort the run.
    if !cancelled {
        if let Err(err) = wire_deferred(&*sql, schema, &exec, &mut rng).await {
            results.push(TableResult {
                table: "(deferred foreign keys)".to_string(),
                inserted: 0,
                error: Some(err.to_string()),
            });
        }
    }

    Ok(GenerateSummary {
        tables: results,
        total_inserted,
        cancelled,
    })
}

/// Second pass: for each table with deferred FK columns, point each row's
/// deferred column at a random key from the referenced table.
async fn wire_deferred(
    sql: &dyn EngineConnection,
    schema: &str,
    exec: &ExecPlan,
    rng: &mut Rng,
) -> Result<(), AppError> {
    for t in &exec.tables {
        let deferred: Vec<&ExecColumn> = t.columns.iter().filter(|c| c.deferred).collect();
        if deferred.is_empty() || t.pk_cols.is_empty() {
            continue;
        }
        let own = sql
            .fetch_pk_pool(schema, &t.table, &t.pk_cols, POOL_CAP)
            .await?;
        for col in deferred {
            let Some(fk) = &col.fk else { continue };
            let target = sql
                .fetch_pk_pool(
                    schema,
                    &fk.table,
                    std::slice::from_ref(&fk.column),
                    POOL_CAP,
                )
                .await
                .unwrap_or_default();
            let pool: Vec<Value> = target
                .into_iter()
                .map(|mut r| r.pop().unwrap_or(Value::Null))
                .collect();
            if pool.is_empty() {
                continue;
            }
            let qschema = sql.quote_identifier(schema);
            let qtable = sql.quote_identifier(&t.table);
            let qcol = sql.quote_identifier(&col.name);
            for row in &own {
                let val = &pool[rng.below(pool.len() as u64) as usize];
                let where_sql = t
                    .pk_cols
                    .iter()
                    .zip(row.iter())
                    .map(|(pk, v)| format!("{} = {}", sql.quote_identifier(pk), sql_literal(v)))
                    .collect::<Vec<_>>()
                    .join(" AND ");
                let stmt = format!(
                    "UPDATE {qschema}.{qtable} SET {qcol} = {} WHERE {where_sql}",
                    sql_literal(val)
                );
                sql.run_query(&stmt, Default::default()).await?;
            }
        }
    }
    Ok(())
}

/// Minimal SQL literal for a generated/db scalar (NULL/bool/number/string).
/// Strings single-quote with `'` doubled. Used only for the deferred-FK UPDATE
/// pass over the app's own generated values (typically integer keys).
fn sql_literal(v: &Value) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => {
            if *b {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::engine::{
        ColumnInfo, Engine, EngineInfo, FetchRowsRequest, ForeignKeyInfo, OpenConnection,
        QueryOptions, QueryResult, RowsPage, SchemaInfo, TableInfo, TableMeta,
    };
    use async_trait::async_trait;

    fn int_col(name: &str, pk: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            data_type: "INTEGER".into(),
            nullable: !pk,
            pk,
            default_value: None,
            fk: None,
        }
    }

    struct UsersOrdersFake;

    #[async_trait]
    impl EngineConnection for UsersOrdersFake {
        fn engine_info(&self) -> EngineInfo {
            EngineInfo {
                engine: Engine::Sqlite,
                server_version: "test".into(),
            }
        }
        async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, AppError> {
            Ok(vec![])
        }
        async fn list_tables(&self, _schema: &str) -> Result<Vec<TableInfo>, AppError> {
            Ok(vec![
                TableInfo {
                    name: "orders".into(),
                    approx_row_count: Some(0),
                },
                TableInfo {
                    name: "users".into(),
                    approx_row_count: Some(0),
                },
            ])
        }
        async fn table_meta(&self, _schema: &str, table: &str) -> Result<TableMeta, AppError> {
            Ok(match table {
                "users" => TableMeta {
                    columns: vec![
                        int_col("id", true),
                        ColumnInfo {
                            name: "email".into(),
                            data_type: "TEXT".into(),
                            nullable: false,
                            pk: false,
                            default_value: None,
                            fk: None,
                        },
                    ],
                    ..Default::default()
                },
                "orders" => TableMeta {
                    columns: vec![
                        int_col("id", true),
                        ColumnInfo {
                            name: "user_id".into(),
                            data_type: "INTEGER".into(),
                            nullable: false,
                            pk: false,
                            default_value: None,
                            fk: Some(FkRef {
                                table: "users".into(),
                                column: "id".into(),
                            }),
                        },
                    ],
                    foreign_keys: vec![ForeignKeyInfo {
                        name: None,
                        columns: vec!["user_id".into()],
                        ref_table: "users".into(),
                        ref_columns: vec!["id".into()],
                        on_delete: None,
                        on_update: None,
                    }],
                    ..Default::default()
                },
                _ => TableMeta::default(),
            })
        }
        async fn run_query(&self, _sql: &str, _o: QueryOptions) -> Result<QueryResult, AppError> {
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                row_count: 0,
                truncated: false,
                elapsed_ms: 0,
            })
        }
        async fn fetch_rows(&self, _r: FetchRowsRequest) -> Result<RowsPage, AppError> {
            Ok(RowsPage {
                columns: vec![],
                rows: vec![],
                offset: 0,
                limit: 0,
                total_rows: Some(0),
                elapsed_ms: 0,
            })
        }
        async fn close(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn build_plan_orders_parents_first_and_marks_fk() {
        let manager = ConnectionManager::new();
        let handle = manager.insert(OpenConnection::sql(UsersOrdersFake)).await;
        let plan = build_plan(&manager, &handle, "main", GenerateSize::OneK)
            .await
            .expect("plan");
        let names: Vec<_> = plan.order.iter().map(|t| t.table.clone()).collect();
        assert_eq!(names, vec!["users".to_string(), "orders".to_string()]);
        let orders = plan.order.iter().find(|t| t.table == "orders").unwrap();
        assert!(orders
            .columns
            .iter()
            .any(|c| c.name == "user_id" && c.generator == "foreign key"));
        // auto-increment id is omitted
        let users = plan.order.iter().find(|t| t.table == "users").unwrap();
        assert!(users.columns.iter().any(|c| c.name == "id" && c.omit));
        assert_eq!(users.row_count, 1_000);
    }
}
