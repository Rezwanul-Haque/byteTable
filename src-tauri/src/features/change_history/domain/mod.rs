//! The change history's model (M48 §3): what a recorded change is, how two
//! versions of a table differ, and — the heart of the feature — whether each
//! row can still be put back (`check`). Pure; no IO.
//!
//! A recorded row is a column list plus a value array, not a JSON object, so
//! the column order the database returned survives storage (and the row
//! previews read in the table's own order).

pub mod capture;
pub mod sql;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How a write reached the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// A grid save (staged edits and new rows), or a grid's bulk delete.
    Grid,
    /// One write statement in auto-commit (SQL tab, notebook cell).
    Statement,
    /// An explicit `BEGIN` … `COMMIT` run from a SQL tab: one entry.
    Transaction,
    /// A table action (Truncate).
    Action,
}

/// Why an entry is listed but cannot be undone (rule 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cant {
    /// CREATE / ALTER / DROP and other structure changes.
    Structure,
    /// More rows than the limit in force: logged without values.
    Large,
    /// The table has no primary or unique key to tell its rows apart.
    Nokey,
    /// An UPDATE / DELETE across several tables.
    Multitable,
    /// A statement the recorder cannot capture: a procedure call, an upsert,
    /// an INSERT whose new rows cannot be identified, an engine without
    /// transactions, or anything not recognised as a single-table write.
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Insert,
    Update,
    Delete,
}

/// One row a change touched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub schema: String,
    pub table: String,
    /// The key columns that identify the row (primary key, else a unique key).
    pub pk: Vec<String>,
    /// The key values, in `pk` order.
    pub key: Vec<Value>,
    pub kind: Kind,
    /// The columns `before` / `after` hold values for, in order.
    pub columns: Vec<String>,
    /// The row before the change; `None` for an insert.
    pub before: Option<Vec<Value>>,
    /// The row after the change; `None` for a delete.
    pub after: Option<Vec<Value>>,
    /// For an update: the columns whose values differ.
    #[serde(default)]
    pub cols: Vec<String>,
}

impl Change {
    /// A value of the before (or after) row by column name.
    pub fn get<'a>(&'a self, row: &'a Option<Vec<Value>>, col: &str) -> Option<&'a Value> {
        let i = self.columns.iter().position(|c| c == col)?;
        row.as_ref()?.get(i)
    }
}

/// One undo or redo, for the entry's Activity list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLine {
    pub what: String,
    pub at: i64,
    pub rows: usize,
    pub skipped: usize,
}

/// One recorded change (§3 "An entry").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub connection_id: String,
    /// Epoch milliseconds.
    pub at: i64,
    pub source: Source,
    pub schema_name: String,
    /// The statement text; empty for grid edits.
    #[serde(default)]
    pub sql: String,
    /// The statement's first word, upper-cased; empty for grid edits.
    #[serde(default)]
    pub verb: String,
    #[serde(default)]
    pub changes: Vec<Change>,
    /// Rows touched, when known (a large change past the limit may not say).
    pub rows: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cant: Option<Cant>,
    /// For `large`: the row limit in force when it was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// Tables touched, for a `cant` entry (which has no changes to read them
    /// from) and for filtering.
    #[serde(default)]
    pub tables: Vec<String>,
    /// The tables have triggers or cascading keys whose effects are not
    /// captured (A4): the detail view says so.
    #[serde(default)]
    pub side_effects: bool,
    /// Indexes of `changes` that have been put back.
    #[serde(default)]
    pub undone: Vec<usize>,
    #[serde(default)]
    pub history: Vec<HistoryLine>,
}

/// Loose equality (§3): null equals null, numbers equal their text form,
/// objects compare by their JSON.
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Null, _) | (_, Value::Null) => false,
        (Value::String(x), Value::String(y)) => x == y,
        // Objects by their JSON — which is also how a JSON column's text form
        // compares to an object read back as one.
        _ => text(a) == text(b),
    }
}

/// A scalar as text, for loose comparison: `1` and `"1"` are the same value,
/// as are `true` and `"true"`.
fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A key as one comparable string.
pub fn key_string(key: &[Value]) -> String {
    key.iter().map(text).collect::<Vec<_>>().join("\u{1f}")
}

/// The rows of one table, with their columns: what a capture or a check reads.
#[derive(Debug, Clone, Default)]
pub struct Rows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

impl Rows {
    fn key_of(&self, row: &[Value], pk: &[String]) -> Option<Vec<Value>> {
        pk.iter()
            .map(|k| {
                let i = self.columns.iter().position(|c| c == k)?;
                row.get(i).cloned()
            })
            .collect()
    }

    /// The rows by key string.
    pub fn by_key(&self, pk: &[String]) -> HashMap<String, Vec<Value>> {
        self.rows
            .iter()
            .filter_map(|r| self.key_of(r, pk).map(|k| (key_string(&k), r.clone())))
            .collect()
    }
}

/// What changed between two versions of a table's rows, matched by key.
pub fn diff(schema: &str, table: &str, pk: &[String], before: &Rows, after: &Rows) -> Vec<Change> {
    let mut out = Vec::new();
    let b = before.by_key(pk);
    let a = after.by_key(pk);
    let change = |kind: Kind, key: Vec<Value>| Change {
        schema: schema.into(),
        table: table.into(),
        pk: pk.to_vec(),
        key,
        kind,
        columns: Vec::new(),
        before: None,
        after: None,
        cols: Vec::new(),
    };
    // In the order the rows were read: before rows first, then new ones.
    for row in &before.rows {
        let Some(key) = before.key_of(row, pk) else {
            continue;
        };
        let k = key_string(&key);
        match a.get(&k) {
            None => out.push(Change {
                columns: before.columns.clone(),
                before: Some(row.clone()),
                ..change(Kind::Delete, key)
            }),
            Some(now) => {
                // Compare by column name: the two reads may order columns alike
                // (they come from one table), but never assume it.
                let cols: Vec<String> = before
                    .columns
                    .iter()
                    .enumerate()
                    .filter(|(i, c)| {
                        let then = &row[*i];
                        let now_v = after
                            .columns
                            .iter()
                            .position(|x| x == *c)
                            .and_then(|j| now.get(j))
                            .unwrap_or(&Value::Null);
                        !same(then, now_v)
                    })
                    .map(|(_, c)| c.clone())
                    .collect();
                if !cols.is_empty() {
                    let after_aligned: Vec<Value> = before
                        .columns
                        .iter()
                        .map(|c| {
                            after
                                .columns
                                .iter()
                                .position(|x| x == c)
                                .and_then(|j| now.get(j).cloned())
                                .unwrap_or(Value::Null)
                        })
                        .collect();
                    out.push(Change {
                        columns: before.columns.clone(),
                        before: Some(row.clone()),
                        after: Some(after_aligned),
                        cols,
                        ..change(Kind::Update, key)
                    });
                }
            }
        }
    }
    for row in &after.rows {
        let Some(key) = after.key_of(row, pk) else {
            continue;
        };
        if !b.contains_key(&key_string(&key)) {
            out.push(Change {
                columns: after.columns.clone(),
                after: Some(row.clone()),
                ..change(Kind::Insert, key)
            });
        }
    }
    out
}

/// Turn a change into its opposite, for redo.
pub fn flip(c: &Change) -> Change {
    let mut f = c.clone();
    match c.kind {
        Kind::Insert => {
            f.kind = Kind::Delete;
            f.before = c.after.clone();
            f.after = None;
        }
        Kind::Delete => {
            f.kind = Kind::Insert;
            f.after = c.before.clone();
            f.before = None;
        }
        Kind::Update => {
            f.before = c.after.clone();
            f.after = c.before.clone();
        }
    }
    f
}

/// The per-row verdict (§3 "The check").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Ok,
    Conflict,
    Noop,
    /// Already undone (or, for redo, not undone): nothing to do here.
    Done,
}

/// Why a row is skipped, as a code the renderer words (and translates).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Why {
    TableGone,
    AlreadyGone,
    ChangedAfterAdded,
    KeyExistsAgain,
    RowGone,
    AlreadyEarlier,
    ChangedAgain,
}

/// A column that changed again since: its value now, and what this change
/// left it as.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Drift {
    pub col: String,
    pub now: Value,
    pub was: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub i: usize,
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<Why>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub now: Vec<Drift>,
}

/// The rows as they are now, per table: `None` when the table is gone.
pub type Current = HashMap<(String, String), Option<Rows>>;

/// Which rows can still be put back. With `redo`, the same check on the
/// flipped change, for undone rows only.
pub fn check(entry: &Entry, current: &Current, redo: bool) -> Vec<Verdict> {
    entry
        .changes
        .iter()
        .enumerate()
        .map(|(i, orig)| {
            let undone = entry.undone.contains(&i);
            let verdict = |state, why: Option<Why>, now: Vec<Drift>| Verdict { i, state, why, now };
            if redo != undone {
                return verdict(State::Done, None, Vec::new());
            }
            let c = if redo { flip(orig) } else { orig.clone() };
            let Some(Some(table)) = current.get(&(c.schema.clone(), c.table.clone())) else {
                return verdict(State::Conflict, Some(Why::TableGone), Vec::new());
            };
            let rows = table.by_key(&c.pk);
            let cur = rows.get(&key_string(&c.key));
            let value_now = |col: &str| -> Value {
                cur.and_then(|r| {
                    let j = table.columns.iter().position(|x| x == col)?;
                    r.get(j).cloned()
                })
                .unwrap_or(Value::Null)
            };
            match c.kind {
                Kind::Insert => {
                    if cur.is_none() {
                        return verdict(State::Noop, Some(Why::AlreadyGone), Vec::new());
                    }
                    let drift: Vec<Drift> = c
                        .columns
                        .iter()
                        .filter_map(|col| {
                            let was = c.get(&c.after, col)?.clone();
                            let now = value_now(col);
                            (!same(&now, &was)).then(|| Drift {
                                col: col.clone(),
                                now,
                                was,
                            })
                        })
                        .collect();
                    if drift.is_empty() {
                        verdict(State::Ok, None, Vec::new())
                    } else {
                        verdict(State::Conflict, Some(Why::ChangedAfterAdded), drift)
                    }
                }
                Kind::Delete => {
                    if cur.is_some() {
                        verdict(State::Conflict, Some(Why::KeyExistsAgain), Vec::new())
                    } else {
                        verdict(State::Ok, None, Vec::new())
                    }
                }
                Kind::Update => {
                    if cur.is_none() {
                        return verdict(State::Conflict, Some(Why::RowGone), Vec::new());
                    }
                    // Only the columns this change touched are compared: a later
                    // edit to another column of the row does not block undo.
                    let at = |row: &Option<Vec<Value>>, col: &str| {
                        c.get(row, col).cloned().unwrap_or(Value::Null)
                    };
                    if c.cols
                        .iter()
                        .all(|col| same(&value_now(col), &at(&c.before, col)))
                    {
                        return verdict(State::Noop, Some(Why::AlreadyEarlier), Vec::new());
                    }
                    let drift: Vec<Drift> = c
                        .cols
                        .iter()
                        .filter_map(|col| {
                            let was = at(&c.after, col);
                            let now = value_now(col);
                            (!same(&now, &was)).then(|| Drift {
                                col: col.clone(),
                                now,
                                was,
                            })
                        })
                        .collect();
                    if drift.is_empty() {
                        verdict(State::Ok, None, Vec::new())
                    } else {
                        verdict(State::Conflict, Some(Why::ChangedAgain), drift)
                    }
                }
            }
        })
        .collect()
}

/// Apply an undo (or redo) outcome to the entry: rows that were put back or
/// already had the earlier values join `undone` (leave it, for redo);
/// conflicts stay as they are; one line goes to the Activity list.
pub fn settle(entry: &mut Entry, verdicts: &[Verdict], redo: bool, at: i64) {
    let settled: Vec<usize> = verdicts
        .iter()
        .filter(|v| matches!(v.state, State::Ok | State::Noop))
        .map(|v| v.i)
        .collect();
    if redo {
        entry.undone.retain(|i| !settled.contains(i));
    } else {
        for i in settled {
            if !entry.undone.contains(&i) {
                entry.undone.push(i);
            }
        }
        entry.undone.sort_unstable();
    }
    entry.history.push(HistoryLine {
        what: if redo { "redo" } else { "undo" }.into(),
        at,
        rows: verdicts.iter().filter(|v| v.state == State::Ok).count(),
        skipped: verdicts
            .iter()
            .filter(|v| v.state == State::Conflict)
            .count(),
    });
}

#[cfg(test)]
mod tests;
