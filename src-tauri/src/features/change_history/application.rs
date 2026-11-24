//! Use-cases for the change history (M48): record writes as they run, check
//! what an undo would do, and undo / redo inside one locked transaction.
//!
//! RECORDING runs the user's statements on one pinned session. A write in
//! auto-commit gets its own transaction around it: read the rows it will touch
//! (locked), run it, read the same keys again, commit — so the captured rows
//! are exactly what it changed, even with another session writing the same
//! table. An explicit `BEGIN` … `COMMIT` becomes one entry; `ROLLBACK` none.
//!
//! UNDO re-reads the rows locked inside its own transaction and runs the check
//! again. If any row's verdict differs from what the user reviewed, it rolls
//! back and says so (B2); otherwise it runs exactly the statements shown.
//!
//! Every table's metadata is read BEFORE a session is pinned: SQL Server's
//! session holds the connection's only client, so a lookup during it would
//! wait on itself.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::features::connections::application::{ConnectionHandleId, ConnectionManager};
use crate::shared::engine::{
    EngineConnection, PinnedSession, QueryOptions, QueryResult, StatementOutcome, TableMeta,
};
use crate::shared::error::AppError;

use super::domain::capture::{analyze, with_returning, InsertHow, Plan};
use super::domain::sql::{
    col_types, lit, reverse, select_by_keys, table_ref, wrap, ColTypes, Dialect,
};
use super::domain::{
    check, diff, flip, settle, Cant, Change, Current, Entry, Kind, Rows, Source, State, Verdict,
};
use super::store::HistoryStore;

/// The retention and size limits in force (Settings → Change history).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_rows: usize,
    pub keep_days: u32,
    pub keep_entries: usize,
}

/// Rows a statement's own result returns to the editor.
const RESULT_ROWS: usize = 500;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn new_id() -> String {
    use rand::Rng;
    let n: u64 = rand::thread_rng().gen();
    format!("h{}{:x}", now_ms(), n & 0xffff_ffff)
}

fn rows_of(r: &QueryResult) -> Rows {
    Rows {
        columns: r.columns.iter().map(|c| c.name.clone()).collect(),
        rows: r.rows.clone(),
    }
}

/// A DML statement's result as the editor shows it: no columns, the count.
fn dml_result(rows: usize, elapsed_ms: u64) -> QueryResult {
    QueryResult {
        columns: Vec::new(),
        rows: Vec::new(),
        row_count: rows,
        truncated: false,
        elapsed_ms,
    }
}

/// One table's facts for recording and undo.
struct TableFacts {
    /// Key columns: the primary key, else a unique index of non-null columns.
    key: Option<Vec<String>>,
    types: ColTypes,
    /// Deleting cascades into other tables, whose rows are not captured.
    cascades: bool,
}

fn facts(meta: &TableMeta) -> TableFacts {
    let pk: Vec<String> = meta
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| c.name.clone())
        .collect();
    let key = if !pk.is_empty() {
        Some(pk)
    } else {
        meta.indexes
            .iter()
            .find(|ix| {
                ix.unique
                    && !ix.columns.is_empty()
                    && ix
                        .columns
                        .iter()
                        .all(|col| meta.columns.iter().any(|c| &c.name == col && !c.nullable))
            })
            .map(|ix| ix.columns.clone())
    };
    let cascades = meta.referenced_by.iter().any(|fk| {
        fk.on_delete.as_deref().is_some_and(|a| {
            a.eq_ignore_ascii_case("cascade") || a.to_ascii_lowercase().contains("set ")
        })
    });
    TableFacts {
        key,
        types: col_types(&meta.columns),
        cascades,
    }
}

type Facts = HashMap<(String, String), Option<TableFacts>>;

async fn load_facts(
    conn: &dyn EngineConnection,
    tables: impl IntoIterator<Item = (String, String)>,
) -> Facts {
    let mut out = Facts::new();
    for (schema, table) in tables {
        if out.contains_key(&(schema.clone(), table.clone())) {
            continue;
        }
        let f = conn
            .table_meta(&schema, &table)
            .await
            .ok()
            .map(|m| facts(&m));
        out.insert((schema, table), f);
    }
    out
}

/// What one captured statement found.
enum Captured {
    Changes {
        changes: Vec<Change>,
        side_effects: bool,
        table: String,
    },
    Cant {
        reason: Cant,
        rows: Option<u64>,
        tables: Vec<String>,
    },
    Nothing,
}

/// Run one write on the session (already inside a transaction) and capture
/// the rows it changed.
async fn capture(
    s: &mut (dyn PinnedSession + '_),
    plan: &Plan,
    sql: &str,
    schema: &str,
    facts: &Facts,
    d: Dialect,
    max_rows: usize,
) -> Result<(QueryResult, Captured), AppError> {
    let fact = |sch: &Option<String>, table: &str| {
        let key = (
            sch.clone().unwrap_or_else(|| schema.to_string()),
            table.to_string(),
        );
        facts.get(&key).and_then(|f| f.as_ref()).map(|f| (key, f))
    };
    match plan {
        Plan::Rows {
            kind,
            schema: sch,
            table,
            target_sql,
            ..
        } => {
            let Some(((schema, table), f)) = fact(sch, table) else {
                let r = s.query(sql, RESULT_ROWS).await?;
                return Ok((
                    r,
                    Captured::Cant {
                        reason: Cant::Unsupported,
                        rows: None,
                        tables: vec![table.clone()],
                    },
                ));
            };
            let Some(pk) = f.key.clone() else {
                let r = s.query(sql, RESULT_ROWS).await?;
                return Ok((
                    r,
                    Captured::Cant {
                        reason: Cant::Nokey,
                        rows: None,
                        tables: vec![table],
                    },
                ));
            };
            // The rows it will touch, locked until the transaction ends.
            let lock = match d {
                Dialect::Postgres | Dialect::Mysql => " FOR UPDATE",
                _ => "",
            };
            // `truncated` = more rows than asked for: past the limit (A2).
            let before = s.query(&format!("{target_sql}{lock}"), max_rows).await?;
            if before.truncated {
                let r = s.query(sql, RESULT_ROWS).await?;
                return Ok((
                    r,
                    Captured::Cant {
                        reason: Cant::Large,
                        rows: None,
                        tables: vec![table],
                    },
                ));
            }
            let started = std::time::Instant::now();
            let r = s.query(sql, RESULT_ROWS).await?;
            let before = rows_of(&before);
            let keys: Vec<Vec<Value>> = before
                .by_key(&pk)
                .into_values()
                .map(|row| {
                    pk.iter()
                        .map(|k| {
                            before
                                .columns
                                .iter()
                                .position(|c| c == k)
                                .and_then(|i| row.get(i).cloned())
                                .unwrap_or(Value::Null)
                        })
                        .collect()
                })
                .collect();
            let after = if keys.is_empty() {
                Rows {
                    columns: before.columns.clone(),
                    rows: Vec::new(),
                }
            } else {
                rows_of(
                    &s.query(
                        &select_by_keys(d, &schema, &table, &pk, &keys, &f.types, false),
                        max_rows + 1,
                    )
                    .await?,
                )
            };
            let changes = diff(&schema, &table, &pk, &before, &after);
            let side_effects = *kind == Kind::Delete && f.cascades;
            let shown = if r.columns.is_empty() {
                dml_result(changes.len(), started.elapsed().as_millis() as u64)
            } else {
                r
            };
            Ok((
                shown,
                Captured::Changes {
                    changes,
                    side_effects,
                    table,
                },
            ))
        }
        Plan::Insert {
            schema: sch,
            table,
            how,
            ..
        } => {
            let found = fact(sch, table);
            let Some(((schema, table), f)) = found else {
                let r = s.query(sql, RESULT_ROWS).await?;
                return Ok((
                    r,
                    Captured::Cant {
                        reason: Cant::Unsupported,
                        rows: None,
                        tables: vec![table.clone()],
                    },
                ));
            };
            let Some(pk) = f.key.clone() else {
                let r = s.query(sql, RESULT_ROWS).await?;
                return Ok((
                    r,
                    Captured::Cant {
                        reason: Cant::Nokey,
                        rows: None,
                        tables: vec![table],
                    },
                ));
            };
            let started = std::time::Instant::now();
            let after = match how {
                InsertHow::Returning | InsertHow::Output { .. } => {
                    let r = s.query(&with_returning(sql, how), max_rows).await?;
                    if r.truncated {
                        return Ok((
                            dml_result(r.row_count, 0),
                            Captured::Cant {
                                reason: Cant::Large,
                                rows: None,
                                tables: vec![table],
                            },
                        ));
                    }
                    rows_of(&r)
                }
                InsertHow::MysqlSingle { columns, values } => {
                    s.query(sql, RESULT_ROWS).await?;
                    // The new row's key: the auto-increment id, or the key
                    // values written in the statement as plain literals.
                    let auto = pk.len() == 1
                        && f.types.get(&pk[0]).is_some_and(|t| t.identity)
                        && columns.as_ref().is_none_or(|cs| !cs.contains(&pk[0]));
                    let cond = if auto {
                        let id = s.query("SELECT LAST_INSERT_ID()", 1).await?;
                        let v = id
                            .rows
                            .first()
                            .and_then(|r| r.first())
                            .cloned()
                            .unwrap_or(Value::Null);
                        Some(format!(
                            "{} = {}",
                            super::domain::sql::ident(d, &pk[0]),
                            lit(d, &v, None)
                        ))
                    } else {
                        columns.as_ref().and_then(|cs| {
                            pk.iter()
                                .map(|k| {
                                    let i = cs.iter().position(|c| c == k)?;
                                    let raw = values.get(i)?;
                                    // A function call (UUID()) is not the value it wrote.
                                    (!raw.contains('(')).then(|| {
                                        format!("{} = {raw}", super::domain::sql::ident(d, k))
                                    })
                                })
                                .collect::<Option<Vec<_>>>()
                                .map(|parts| parts.join(" AND "))
                        })
                    };
                    let Some(cond) = cond else {
                        return Ok((
                            dml_result(1, 0),
                            Captured::Cant {
                                reason: Cant::Unsupported,
                                rows: Some(1),
                                tables: vec![table],
                            },
                        ));
                    };
                    rows_of(
                        &s.query(
                            &format!(
                                "SELECT * FROM {} WHERE {cond}",
                                table_ref(d, &schema, &table)
                            ),
                            2,
                        )
                        .await?,
                    )
                }
            };
            let before = Rows {
                columns: after.columns.clone(),
                rows: Vec::new(),
            };
            let changes = diff(&schema, &table, &pk, &before, &after);
            Ok((
                dml_result(changes.len(), started.elapsed().as_millis() as u64),
                Captured::Changes {
                    changes,
                    side_effects: false,
                    table,
                },
            ))
        }
        Plan::Cant { reason, tables, .. } => {
            let r = s.query(sql, RESULT_ROWS).await?;
            Ok((
                r,
                Captured::Cant {
                    reason: *reason,
                    rows: None,
                    tables: tables.clone(),
                },
            ))
        }
        _ => Ok((s.query(sql, RESULT_ROWS).await?, Captured::Nothing)),
    }
}

/// An entry being put together from one or more captured statements.
struct Pending {
    sql: Vec<String>,
    verb: String,
    changes: Vec<Change>,
    cant: Option<(Cant, Option<u64>)>,
    tables: Vec<String>,
    side_effects: bool,
}

impl Pending {
    fn new() -> Self {
        Self {
            sql: Vec::new(),
            verb: String::new(),
            changes: Vec::new(),
            cant: None,
            tables: Vec::new(),
            side_effects: false,
        }
    }

    fn add(&mut self, sql: &str, verb: &str, captured: Captured) {
        self.sql.push(sql.trim().trim_end_matches(';').to_string());
        if self.verb.is_empty() {
            self.verb = verb.to_string();
        } else if self.verb != verb {
            self.verb = "COMMIT".into();
        }
        match captured {
            Captured::Changes {
                changes,
                side_effects,
                table,
            } => {
                self.changes.extend(changes);
                self.side_effects |= side_effects;
                if !self.tables.contains(&table) {
                    self.tables.push(table);
                }
            }
            Captured::Cant {
                reason,
                rows,
                tables,
            } => {
                // One uncapturable statement makes the whole entry "can't undo":
                // a part-undo of a transaction would not be what ran.
                if self.cant.is_none() {
                    self.cant = Some((reason, rows));
                }
                for t in tables {
                    if !self.tables.contains(&t) {
                        self.tables.push(t);
                    }
                }
            }
            Captured::Nothing => {}
        }
    }

    /// The entry, or none when nothing changed (a write that changed no rows
    /// records nothing — but a structure change is always listed).
    fn finish(
        self,
        connection_id: &str,
        schema: &str,
        source: Source,
        limits: &Limits,
    ) -> Option<Entry> {
        let (cant, rows) = match self.cant {
            Some((c, rows)) => (Some(c), rows),
            None if self.changes.is_empty() => return None,
            None => (None, Some(self.changes.len() as u64)),
        };
        let changes = if cant.is_some() {
            Vec::new()
        } else {
            self.changes
        };
        let large = cant == Some(Cant::Large);
        Some(Entry {
            id: new_id(),
            connection_id: connection_id.into(),
            at: now_ms(),
            source,
            schema_name: schema.into(),
            sql: if source == Source::Grid {
                String::new()
            } else {
                self.sql.join(";\n")
            },
            verb: self.verb,
            changes,
            rows,
            cant,
            limit: large.then_some(limits.max_rows as u64),
            tables: self.tables,
            side_effects: self.side_effects,
            undone: Vec::new(),
            history: Vec::new(),
        })
    }
}

fn verb_of(sql: &str) -> String {
    sql.trim_start()
        .split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or("")
        .to_ascii_uppercase()
}

/// What recording a run produced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recorded {
    pub outcomes: Vec<StatementOutcome>,
    /// Ids of the entries written, newest last.
    pub entries: Vec<String>,
}

/// Run `statements` and record what they change.
///
/// `Source::Grid` runs them all as ONE transaction (a grid save is all or
/// nothing) and records one entry. Otherwise each statement runs in order on
/// one session, continue-on-error like the editor's batches; a write in
/// auto-commit gets its own transaction, and an explicit `BEGIN` … `COMMIT`
/// is one `transaction` entry.
#[allow(clippy::too_many_arguments)]
pub async fn record(
    manager: &ConnectionManager,
    store: &HistoryStore,
    handle: &ConnectionHandleId,
    connection_id: &str,
    statements: &[String],
    schema: &str,
    source: Source,
    limits: Limits,
) -> Result<Recorded, AppError> {
    let conn: Arc<dyn EngineConnection> = manager.get_sql(handle).await?;
    let engine = conn.engine_info().engine;
    let Some(d) = Dialect::of(engine) else {
        return record_unsupported(
            conn.as_ref(),
            store,
            connection_id,
            statements,
            schema,
            source,
            limits,
        )
        .await;
    };
    let plans: Vec<Plan> = statements.iter().map(|s| analyze(s, engine)).collect();
    let tables = plans.iter().filter_map(|p| match p {
        Plan::Rows {
            schema: sch, table, ..
        }
        | Plan::Insert {
            schema: sch, table, ..
        } => Some((
            sch.clone().unwrap_or_else(|| schema.to_string()),
            table.clone(),
        )),
        _ => None,
    });
    let facts = load_facts(conn.as_ref(), tables.collect::<Vec<_>>()).await;

    let mut session = conn.pin(Some(schema.to_string())).await?;
    let s = session.as_mut();
    let mut outcomes = Vec::with_capacity(statements.len());
    let mut entries: Vec<Entry> = Vec::new();
    let ok = |sql: &str, r: QueryResult| StatementOutcome {
        sql: sql.into(),
        result: Some(r),
        error: None,
    };
    let err = |sql: &str, e: AppError| StatementOutcome {
        sql: sql.into(),
        result: None,
        error: Some(e.to_string()),
    };

    if source == Source::Grid {
        s.query(d.begin(), 1).await?;
        let mut pending = Pending::new();
        for (sql, plan) in statements.iter().zip(&plans) {
            match capture(s, plan, sql, schema, &facts, d, limits.max_rows).await {
                Ok((r, c)) => {
                    pending.add(sql, &verb_of(sql), c);
                    outcomes.push(ok(sql, r));
                }
                Err(e) => {
                    let _ = s.query("ROLLBACK", 1).await;
                    return Err(e);
                }
            }
        }
        s.query("COMMIT", 1).await?;
        entries.extend(pending.finish(connection_id, schema, Source::Grid, &limits));
    } else {
        let mut txn: Option<Pending> = None;
        for (sql, plan) in statements.iter().zip(&plans) {
            match plan {
                Plan::Begin => match s.query(sql, RESULT_ROWS).await {
                    Ok(r) => {
                        txn = Some(Pending::new());
                        outcomes.push(ok(sql, r));
                    }
                    Err(e) => outcomes.push(err(sql, e)),
                },
                Plan::Commit => match s.query(sql, RESULT_ROWS).await {
                    Ok(r) => {
                        if let Some(p) = txn.take() {
                            entries.extend(p.finish(
                                connection_id,
                                schema,
                                Source::Transaction,
                                &limits,
                            ));
                        }
                        outcomes.push(ok(sql, r));
                    }
                    Err(e) => outcomes.push(err(sql, e)),
                },
                Plan::Rollback => {
                    txn = None;
                    match s.query(sql, RESULT_ROWS).await {
                        Ok(r) => outcomes.push(ok(sql, r)),
                        Err(e) => outcomes.push(err(sql, e)),
                    }
                }
                Plan::Plain => match s.query(sql, RESULT_ROWS).await {
                    Ok(r) => outcomes.push(ok(sql, r)),
                    Err(e) => outcomes.push(err(sql, e)),
                },
                _ if txn.is_some() => {
                    match capture(s, plan, sql, schema, &facts, d, limits.max_rows).await {
                        Ok((r, c)) => {
                            if let Some(p) = txn.as_mut() {
                                p.add(sql, &verb_of(sql), c);
                            }
                            outcomes.push(ok(sql, r));
                        }
                        Err(e) => outcomes.push(err(sql, e)),
                    }
                }
                _ => {
                    // Auto-commit: the write gets a transaction of its own.
                    if let Err(e) = s.query(d.begin(), 1).await {
                        outcomes.push(err(sql, e));
                        continue;
                    }
                    match capture(s, plan, sql, schema, &facts, d, limits.max_rows).await {
                        Ok((r, c)) => match s.query("COMMIT", 1).await {
                            Ok(_) => {
                                let mut p = Pending::new();
                                p.add(sql, &verb_of(sql), c);
                                entries.extend(p.finish(
                                    connection_id,
                                    schema,
                                    Source::Statement,
                                    &limits,
                                ));
                                outcomes.push(ok(sql, r));
                            }
                            Err(e) => outcomes.push(err(sql, e)),
                        },
                        Err(e) => {
                            let _ = s.query("ROLLBACK", 1).await;
                            outcomes.push(err(sql, e));
                        }
                    }
                }
            }
        }
        // A batch that ends inside its own transaction would hand an open
        // transaction back to the pool: roll it back, and say so.
        if txn.is_some() {
            let _ = s.query("ROLLBACK", 1).await;
            outcomes.push(StatementOutcome {
                sql: "-- end of batch".into(),
                result: None,
                error: Some("The batch ended inside a transaction, so it was rolled back. End it with COMMIT to keep its changes.".into()),
            });
        }
    }
    drop(session);

    let ids = entries.iter().map(|e| e.id.clone()).collect();
    for e in &entries {
        store.put(e)?;
    }
    if !entries.is_empty() {
        store.prune(limits.keep_days, limits.keep_entries, now_ms())?;
    }
    Ok(Recorded {
        outcomes,
        entries: ids,
    })
}

/// An engine that cannot hold a transaction (ClickHouse): run as usual, and
/// list each write as "can't undo".
async fn record_unsupported(
    conn: &dyn EngineConnection,
    store: &HistoryStore,
    connection_id: &str,
    statements: &[String],
    schema: &str,
    source: Source,
    limits: Limits,
) -> Result<Recorded, AppError> {
    let options = QueryOptions {
        row_limit: RESULT_ROWS,
        schema: Some(schema.into()),
    };
    let outcomes = conn.run_batch(statements, options).await?;
    let mut ids = Vec::new();
    for o in outcomes.iter().filter(|o| o.error.is_none()) {
        if crate::shared::readonly::sql_is_read_only(&o.sql) {
            continue;
        }
        let mut p = Pending::new();
        p.add(
            &o.sql,
            &verb_of(&o.sql),
            Captured::Cant {
                reason: Cant::Unsupported,
                rows: None,
                tables: Vec::new(),
            },
        );
        if let Some(e) = p.finish(connection_id, schema, source, &limits) {
            store.put(&e)?;
            ids.push(e.id);
        }
    }
    Ok(Recorded {
        outcomes,
        entries: ids,
    })
}

/// Truncate a table and record its rows first (source `action`).
#[allow(clippy::too_many_arguments)]
pub async fn record_truncate(
    manager: &ConnectionManager,
    store: &HistoryStore,
    handle: &ConnectionHandleId,
    connection_id: &str,
    schema: &str,
    table: &str,
    force: bool,
    limits: Limits,
) -> Result<(u64, Option<String>), AppError> {
    let conn = manager.get_sql(handle).await?;
    let d = Dialect::of(conn.engine_info().engine);
    let meta = conn.table_meta(schema, table).await.ok();
    let f = meta.as_ref().map(facts);
    // The rows as they are, read just before (Truncate is not transactional on
    // every engine, so this cannot share its transaction).
    let before = match d {
        Some(d) => conn
            .run_query(
                &format!("SELECT * FROM {}", table_ref(d, schema, table)),
                QueryOptions {
                    row_limit: limits.max_rows,
                    schema: Some(schema.into()),
                },
            )
            .await
            .ok(),
        None => None,
    };
    let affected = conn.truncate_table(schema, table, force).await?;
    if affected == 0 && before.as_ref().is_none_or(|b| b.rows.is_empty()) {
        return Ok((affected, None));
    }
    let mut p = Pending::new();
    let sql = format!("TRUNCATE TABLE {table}");
    let captured = match (before, f.and_then(|f| f.key.map(|k| (k, f.cascades)))) {
        (Some(b), _) if b.truncated => Captured::Cant {
            reason: Cant::Large,
            rows: Some(affected),
            tables: vec![table.into()],
        },
        (Some(b), Some((key, cascades))) => Captured::Changes {
            changes: diff(schema, table, &key, &rows_of(&b), &Rows::default()),
            side_effects: cascades || force,
            table: table.into(),
        },
        (Some(_), None) => Captured::Cant {
            reason: Cant::Nokey,
            rows: Some(affected),
            tables: vec![table.into()],
        },
        (None, _) => Captured::Cant {
            reason: Cant::Unsupported,
            rows: Some(affected),
            tables: vec![table.into()],
        },
    };
    p.add(&sql, "TRUNCATE", captured);
    let entry = p.finish(connection_id, schema, Source::Action, &limits);
    let id = entry.as_ref().map(|e| e.id.clone());
    if let Some(e) = &entry {
        store.put(e)?;
        store.prune(limits.keep_days, limits.keep_entries, now_ms())?;
    }
    Ok((affected, id))
}

// ---- the check, undo and redo -----------------------------------------------

/// What undo (or redo) would do, for the detail view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckView {
    pub redo: bool,
    pub verdicts: Vec<Verdict>,
    /// The exact statements that would run (only rows whose verdict is ok).
    pub statements: Vec<String>,
    /// The same, wrapped in BEGIN / COMMIT, for display and Copy.
    pub sql: String,
}

/// An entry is redone when every row has been put back.
fn is_redo(entry: &Entry) -> bool {
    !entry.changes.is_empty() && entry.undone.len() >= entry.changes.len()
}

fn tables_of(entry: &Entry) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    entry
        .changes
        .iter()
        .map(|c| (c.schema.clone(), c.table.clone()))
        .filter(|k| seen.insert(k.clone()))
        .collect()
}

/// Per (schema, table): the key columns, and the keys of the rows touched.
type KeysByTable = HashMap<(String, String), (Vec<String>, Vec<Vec<Value>>)>;

fn keys_by_table(entry: &Entry) -> KeysByTable {
    let mut out = KeysByTable::new();
    for c in &entry.changes {
        let slot = out
            .entry((c.schema.clone(), c.table.clone()))
            .or_insert_with(|| (c.pk.clone(), Vec::new()));
        slot.1.push(c.key.clone());
    }
    out
}

fn statements_for(
    entry: &Entry,
    verdicts: &[Verdict],
    redo: bool,
    d: Dialect,
    facts: &Facts,
) -> Vec<String> {
    verdicts
        .iter()
        .filter(|v| v.state == State::Ok)
        .flat_map(|v| {
            let orig = &entry.changes[v.i];
            let c = if redo { flip(orig) } else { orig.clone() };
            let types = facts
                .get(&(c.schema.clone(), c.table.clone()))
                .and_then(|f| f.as_ref())
                .map(|f| f.types.clone())
                .unwrap_or_default();
            reverse(d, &c, &types)
        })
        .collect()
}

pub async fn check_entry(
    manager: &ConnectionManager,
    store: &HistoryStore,
    handle: &ConnectionHandleId,
    entry_id: &str,
) -> Result<CheckView, AppError> {
    let entry = store
        .get(entry_id)?
        .ok_or_else(|| AppError::NotFound("That change is no longer in the history.".into()))?;
    let conn = manager.get_sql(handle).await?;
    let Some(d) = Dialect::of(conn.engine_info().engine) else {
        return Ok(CheckView {
            redo: false,
            verdicts: Vec::new(),
            statements: Vec::new(),
            sql: String::new(),
        });
    };
    if entry.cant.is_some() {
        return Ok(CheckView {
            redo: false,
            verdicts: Vec::new(),
            statements: Vec::new(),
            sql: String::new(),
        });
    }
    let facts = load_facts(conn.as_ref(), tables_of(&entry)).await;
    // The rows as they are now, one query per table (B1). Not locked: this is
    // the review; the undo itself re-reads them locked.
    let mut current = Current::new();
    for ((schema, table), (pk, keys)) in keys_by_table(&entry) {
        let rows = match facts.get(&(schema.clone(), table.clone())) {
            Some(Some(f)) => {
                let sql = select_by_keys(d, &schema, &table, &pk, &keys, &f.types, false);
                let options = QueryOptions {
                    row_limit: 100_000,
                    schema: Some(schema.clone()),
                };
                conn.run_query(&sql, options)
                    .await
                    .ok()
                    .map(|r| rows_of(&r))
            }
            _ => None,
        };
        current.insert((schema, table), rows);
    }
    let redo = is_redo(&entry);
    let verdicts = check(&entry, &current, redo);
    let statements = statements_for(&entry, &verdicts, redo, d, &facts);
    let sql = if statements.is_empty() {
        String::new()
    } else {
        wrap(d, &statements)
    };
    Ok(CheckView {
        redo,
        verdicts,
        statements,
        sql,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    /// Rows put back (or changed again, for redo).
    pub applied: usize,
    pub skipped: usize,
    /// A row's verdict changed while the user was reviewing: nothing ran.
    pub changed: bool,
}

/// Undo (or redo) an entry: one transaction that locks the rows, checks them
/// again, and — only if every verdict still matches what was reviewed — runs
/// the statements. Any error rolls back and leaves the entry unchanged.
pub async fn apply_entry(
    manager: &ConnectionManager,
    store: &HistoryStore,
    handle: &ConnectionHandleId,
    entry_id: &str,
    reviewed: &[State],
) -> Result<ApplyOutcome, AppError> {
    if manager.is_read_only(handle).await {
        return Err(crate::shared::readonly::read_only_error("undo a change"));
    }
    let mut entry = store
        .get(entry_id)?
        .ok_or_else(|| AppError::NotFound("That change is no longer in the history.".into()))?;
    if entry.cant.is_some() {
        return Err(AppError::Invalid("This change cannot be undone.".into()));
    }
    let conn = manager.get_sql(handle).await?;
    let d = Dialect::of(conn.engine_info().engine)
        .ok_or_else(|| AppError::Unsupported("Undo is not available for this engine.".into()))?;
    let facts = load_facts(conn.as_ref(), tables_of(&entry)).await;
    let redo = is_redo(&entry);

    let mut session = conn.pin(Some(entry.schema_name.clone())).await?;
    session.query(d.begin(), 1).await?;
    // B2: the check again, with the rows locked, inside the transaction.
    let mut current = Current::new();
    for ((schema, table), (pk, keys)) in keys_by_table(&entry) {
        let rows = match facts.get(&(schema.clone(), table.clone())) {
            Some(Some(f)) => {
                let sql = select_by_keys(d, &schema, &table, &pk, &keys, &f.types, true);
                session.query(&sql, 100_000).await.ok().map(|r| rows_of(&r))
            }
            _ => None,
        };
        current.insert((schema, table), rows);
    }
    let verdicts = check(&entry, &current, redo);
    let now: Vec<State> = verdicts.iter().map(|v| v.state).collect();
    if now != reviewed {
        let _ = session.query("ROLLBACK", 1).await;
        return Ok(ApplyOutcome {
            applied: 0,
            skipped: 0,
            changed: true,
        });
    }
    for stmt in statements_for(&entry, &verdicts, redo, d, &facts) {
        if let Err(e) = session.query(&stmt, 1).await {
            let _ = session.query("ROLLBACK", 1).await;
            return Err(e);
        }
    }
    session.query("COMMIT", 1).await?;
    drop(session);

    settle(&mut entry, &verdicts, redo, now_ms());
    store.put(&entry)?;
    Ok(ApplyOutcome {
        applied: verdicts.iter().filter(|v| v.state == State::Ok).count(),
        skipped: verdicts
            .iter()
            .filter(|v| v.state == State::Conflict)
            .count(),
        changed: false,
    })
}

#[cfg(test)]
mod sqlite_integration {
    use super::*;
    use crate::engines::sqlite::SqliteConnector;
    use crate::shared::engine::{ConnectionParams, Connector};

    const LIMITS: Limits = Limits {
        max_rows: 1000,
        keep_days: 7,
        keep_entries: 500,
    };

    async fn fixture(dir: &tempfile::TempDir) -> (ConnectionManager, ConnectionHandleId) {
        let path = dir.path().join("h.db");
        {
            let c = rusqlite::Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL);
                 INSERT INTO products VALUES (1, 'mug', 10), (2, 'tee', 20), (3, 'pen', 2);
                 CREATE TABLE notes (body TEXT);",
            )
            .unwrap();
        }
        let open = SqliteConnector
            .open(&ConnectionParams::Sqlite {
                path: path.to_string_lossy().into_owned(),
            })
            .await
            .unwrap();
        let manager = ConnectionManager::new();
        let handle = manager.insert(open).await;
        (manager, handle)
    }

    async fn run(
        m: &ConnectionManager,
        st: &HistoryStore,
        h: &ConnectionHandleId,
        sql: &[&str],
        source: Source,
    ) -> Recorded {
        let statements: Vec<String> = sql.iter().map(|s| s.to_string()).collect();
        record(m, st, h, "conn", &statements, "main", source, LIMITS)
            .await
            .unwrap()
    }

    async fn price(m: &ConnectionManager, h: &ConnectionHandleId, id: i64) -> Value {
        let c = m.get_sql(h).await.unwrap();
        let r = c
            .run_query(
                &format!("SELECT price FROM products WHERE id = {id}"),
                QueryOptions::default(),
            )
            .await
            .unwrap();
        r.rows
            .first()
            .and_then(|r| r.first())
            .cloned()
            .unwrap_or(Value::Null)
    }

    /// The milestone's acceptance scenario.
    #[tokio::test]
    async fn a_grid_edit_is_undone_except_the_row_changed_since() {
        let dir = tempfile::tempdir().unwrap();
        let (m, h) = fixture(&dir).await;
        let st = HistoryStore::in_memory();
        let grid = run(
            &m,
            &st,
            &h,
            &[
                "UPDATE products SET price = 11 WHERE id = 1",
                "UPDATE products SET price = 21 WHERE id = 2",
            ],
            Source::Grid,
        )
        .await;
        assert_eq!(grid.entries.len(), 1);
        let id = grid.entries[0].clone();

        let view = check_entry(&m, &st, &h, &id).await.unwrap();
        assert!(view.verdicts.iter().all(|v| v.state == State::Ok));
        assert_eq!(view.statements.len(), 2);
        assert!(
            view.sql.starts_with("BEGIN IMMEDIATE;\nUPDATE"),
            "{}",
            view.sql
        );
        assert!(view.sql.ends_with("\nCOMMIT;"));

        // Another change to one of the rows, from a SQL tab.
        run(
            &m,
            &st,
            &h,
            &["UPDATE products SET price = 99 WHERE id = 2"],
            Source::Statement,
        )
        .await;
        let view = check_entry(&m, &st, &h, &id).await.unwrap();
        let states: Vec<_> = view.verdicts.iter().map(|v| v.state).collect();
        assert_eq!(states, [State::Ok, State::Conflict]);
        assert_eq!(view.verdicts[1].now[0].now, json!(99.0));

        let out = apply_entry(&m, &st, &h, &id, &states).await.unwrap();
        assert_eq!((out.applied, out.skipped, out.changed), (1, 1, false));
        assert_eq!(price(&m, &h, 1).await, json!(10.0), "put back");
        assert_eq!(price(&m, &h, 2).await, json!(99.0), "left alone");
        assert_eq!(st.get(&id).unwrap().unwrap().undone, [0]);
    }

    #[tokio::test]
    async fn one_entry_per_commit_none_on_rollback_none_for_no_rows() {
        let dir = tempfile::tempdir().unwrap();
        let (m, h) = fixture(&dir).await;
        let st = HistoryStore::in_memory();
        let r = run(
            &m,
            &st,
            &h,
            &[
                "BEGIN",
                "UPDATE products SET price = 1 WHERE id = 1",
                "DELETE FROM products WHERE id = 3",
                "INSERT INTO products (name, price) VALUES ('cup', 5)",
                "COMMIT",
            ],
            Source::Statement,
        )
        .await;
        assert_eq!(r.entries.len(), 1);
        let e = st.get(&r.entries[0]).unwrap().unwrap();
        assert_eq!(e.source, Source::Transaction);
        let kinds: Vec<_> = e.changes.iter().map(|c| c.kind).collect();
        assert_eq!(kinds, [Kind::Update, Kind::Delete, Kind::Insert]);

        let r = run(
            &m,
            &st,
            &h,
            &[
                "BEGIN",
                "UPDATE products SET price = 7 WHERE id = 1",
                "ROLLBACK",
            ],
            Source::Statement,
        )
        .await;
        assert!(r.entries.is_empty());
        let r = run(
            &m,
            &st,
            &h,
            &["UPDATE products SET price = 7 WHERE id = 999"],
            Source::Statement,
        )
        .await;
        assert!(
            r.entries.is_empty(),
            "a write that changed no rows records nothing"
        );
        assert_eq!(st.list("conn").unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_deleted_row_comes_back_with_its_key_and_redo_removes_it_again() {
        let dir = tempfile::tempdir().unwrap();
        let (m, h) = fixture(&dir).await;
        let st = HistoryStore::in_memory();
        let r = run(
            &m,
            &st,
            &h,
            &["DELETE FROM products WHERE id = 2"],
            Source::Statement,
        )
        .await;
        let id = r.entries[0].clone();
        let v = check_entry(&m, &st, &h, &id).await.unwrap();
        apply_entry(&m, &st, &h, &id, &[State::Ok]).await.unwrap();
        assert_eq!(price(&m, &h, 2).await, json!(20.0));
        // Fully undone: the next apply is a redo.
        let v2 = check_entry(&m, &st, &h, &id).await.unwrap();
        assert!(v2.redo && !v.redo);
        apply_entry(&m, &st, &h, &id, &[State::Ok]).await.unwrap();
        assert_eq!(price(&m, &h, 2).await, Value::Null);
    }

    #[tokio::test]
    async fn a_row_changed_during_review_aborts_the_undo() {
        let dir = tempfile::tempdir().unwrap();
        let (m, h) = fixture(&dir).await;
        let st = HistoryStore::in_memory();
        let r = run(
            &m,
            &st,
            &h,
            &["UPDATE products SET price = 50 WHERE id = 1"],
            Source::Statement,
        )
        .await;
        let id = r.entries[0].clone();
        let reviewed: Vec<_> = check_entry(&m, &st, &h, &id)
            .await
            .unwrap()
            .verdicts
            .iter()
            .map(|v| v.state)
            .collect();
        // Someone else edits it before Undo is pressed.
        let c = m.get_sql(&h).await.unwrap();
        c.run_query(
            "UPDATE products SET price = 51 WHERE id = 1",
            QueryOptions::default(),
        )
        .await
        .unwrap();
        let out = apply_entry(&m, &st, &h, &id, &reviewed).await.unwrap();
        assert!(out.changed);
        assert_eq!(
            price(&m, &h, 1).await,
            json!(51.0),
            "nothing was overwritten"
        );
        assert!(st.get(&id).unwrap().unwrap().undone.is_empty());
    }

    #[tokio::test]
    async fn over_the_limit_no_key_and_structure_are_listed_as_cant() {
        let dir = tempfile::tempdir().unwrap();
        let (m, h) = fixture(&dir).await;
        let st = HistoryStore::in_memory();
        let tight = Limits {
            max_rows: 2,
            ..LIMITS
        };
        let s: Vec<String> = vec!["UPDATE products SET price = price + 1".into()];
        let r = record(&m, &st, &h, "conn", &s, "main", Source::Statement, tight)
            .await
            .unwrap();
        let e = st.get(&r.entries[0]).unwrap().unwrap();
        assert_eq!(
            (e.cant, e.limit, e.changes.len()),
            (Some(Cant::Large), Some(2), 0)
        );
        let r = run(
            &m,
            &st,
            &h,
            &["INSERT INTO notes VALUES ('x')"],
            Source::Statement,
        )
        .await;
        assert_eq!(
            st.get(&r.entries[0]).unwrap().unwrap().cant,
            Some(Cant::Nokey)
        );
        let r = run(
            &m,
            &st,
            &h,
            &["ALTER TABLE notes ADD COLUMN n INT"],
            Source::Statement,
        )
        .await;
        assert_eq!(
            st.get(&r.entries[0]).unwrap().unwrap().cant,
            Some(Cant::Structure)
        );
    }

    /// The grid writes quoted, schema-qualified names.
    #[tokio::test]
    async fn quoted_qualified_names_from_the_grid_are_captured() {
        let dir = tempfile::tempdir().unwrap();
        let (m, h) = fixture(&dir).await;
        let st = HistoryStore::in_memory();
        let r = run(
            &m,
            &st,
            &h,
            &[
                r#"UPDATE "main"."products" SET "price" = 12 WHERE "id" = 1;"#,
                r#"INSERT INTO "main"."products" ("name", "price") VALUES ('cap', 3);"#,
                r#"DELETE FROM "main"."products" WHERE "id" = 3"#,
            ],
            Source::Grid,
        )
        .await;
        let e = st.get(&r.entries[0]).unwrap().unwrap();
        assert_eq!(e.cant, None);
        let kinds: Vec<_> = e
            .changes
            .iter()
            .map(|c| (c.kind, c.table.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                (Kind::Update, "products"),
                (Kind::Insert, "products"),
                (Kind::Delete, "products")
            ]
        );
    }

    use serde_json::json;
}
