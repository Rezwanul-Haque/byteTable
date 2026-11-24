//! The change history on disk (M48 A1): one SQLite file in the app's data
//! folder, one row per entry, keyed by connection and time, the entry itself
//! stored as JSON. It holds real row values and never leaves this machine —
//! nothing here syncs, uploads or is read by a bug report.
//!
//! Not encrypted yet (the brief's A1 asks for it; deferred by decision).
//! Clearing deletes the rows and VACUUMs, so nothing cleared stays in the file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::shared::error::AppError;

use super::domain::{Cant, Entry, Kind, Source};

fn db(e: rusqlite::Error) -> AppError {
    AppError::Io(format!("Change history store: {e}"))
}

/// An entry without its row values — what the list draws.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub at: i64,
    pub source: Source,
    pub schema_name: String,
    pub sql: String,
    pub verb: String,
    pub rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cant: Option<Cant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    pub tables: Vec<String>,
    pub inserted: usize,
    pub updated: usize,
    pub deleted: usize,
    pub changes: usize,
    pub undone: usize,
}

impl From<&Entry> for Summary {
    fn from(e: &Entry) -> Self {
        let count = |k: Kind| e.changes.iter().filter(|c| c.kind == k).count();
        let mut tables: Vec<String> = e.changes.iter().map(|c| c.table.clone()).collect();
        tables.extend(e.tables.iter().cloned());
        tables.dedup();
        let mut seen = std::collections::HashSet::new();
        tables.retain(|t| seen.insert(t.clone()));
        Summary {
            id: e.id.clone(),
            at: e.at,
            source: e.source,
            schema_name: e.schema_name.clone(),
            sql: e.sql.clone(),
            verb: e.verb.clone(),
            rows: e.rows,
            cant: e.cant,
            limit: e.limit,
            tables,
            inserted: count(Kind::Insert),
            updated: count(Kind::Update),
            deleted: count(Kind::Delete),
            changes: e.changes.len(),
            undone: e.undone.len(),
        }
    }
}

/// What is stored, across every connection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub entries: u64,
    pub connections: u64,
    pub bytes: u64,
}

pub struct HistoryStore {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_by_conn ON entries (connection_id, at DESC);
CREATE TABLE IF NOT EXISTS paused (connection_id TEXT PRIMARY KEY);
";

impl HistoryStore {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| AppError::Io(e.to_string()))?;
        }
        let conn = Connection::open(path).map_err(db)?;
        conn.execute_batch(SCHEMA).map_err(db)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: Some(path.to_path_buf()),
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory store");
        conn.execute_batch(SCHEMA).expect("schema");
        Self {
            conn: Mutex::new(conn),
            path: None,
        }
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, AppError> {
        let guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&guard).map_err(db)
    }

    pub fn put(&self, entry: &Entry) -> Result<(), AppError> {
        let body =
            serde_json::to_string(entry).map_err(|e| AppError::Serialization(e.to_string()))?;
        self.with(|c| {
            c.execute(
                "INSERT INTO entries (id, connection_id, at, body) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET body = excluded.body",
                params![entry.id, entry.connection_id, entry.at, body],
            )
            .map(|_| ())
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<Entry>, AppError> {
        let body: Option<String> = self.with(|c| {
            c.query_row("SELECT body FROM entries WHERE id = ?1", params![id], |r| {
                r.get(0)
            })
            .optional()
        })?;
        Ok(body.and_then(|b| serde_json::from_str(&b).ok()))
    }

    /// A connection's entries, newest first.
    pub fn list(&self, connection_id: &str) -> Result<Vec<Entry>, AppError> {
        let bodies: Vec<String> = self.with(|c| {
            let mut stmt =
                c.prepare("SELECT body FROM entries WHERE connection_id = ?1 ORDER BY at DESC")?;
            let rows = stmt.query_map(params![connection_id], |r| r.get::<_, String>(0))?;
            rows.collect()
        })?;
        Ok(bodies
            .iter()
            .filter_map(|b| serde_json::from_str(b).ok())
            .collect())
    }

    /// Retention (A6): drop entries older than `keep_days`, then keep the
    /// newest `keep_entries` per connection.
    pub fn prune(&self, keep_days: u32, keep_entries: usize, now_ms: i64) -> Result<(), AppError> {
        let cutoff = now_ms - i64::from(keep_days) * 86_400_000;
        self.with(|c| {
            c.execute("DELETE FROM entries WHERE at < ?1", params![cutoff])?;
            c.execute(
                "DELETE FROM entries WHERE id IN (
                   SELECT id FROM (
                     SELECT id, ROW_NUMBER() OVER (PARTITION BY connection_id ORDER BY at DESC) AS n
                     FROM entries
                   ) WHERE n > ?1
                 )",
                params![keep_entries as i64],
            )
            .map(|_| ())
        })
    }

    /// Clear one connection's history, or everyone's. VACUUM afterwards so the
    /// cleared rows do not linger in the file's free pages.
    pub fn clear(&self, connection_id: Option<&str>) -> Result<(), AppError> {
        self.with(|c| {
            match connection_id {
                Some(id) => {
                    c.execute("DELETE FROM entries WHERE connection_id = ?1", params![id])?
                }
                None => c.execute("DELETE FROM entries", [])?,
            };
            c.execute_batch("VACUUM")
        })
    }

    pub fn totals(&self) -> Result<Totals, AppError> {
        let (entries, connections): (i64, i64) = self.with(|c| {
            c.query_row(
                "SELECT COUNT(*), COUNT(DISTINCT connection_id) FROM entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })?;
        let bytes = self
            .path
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map_or(0, |m| m.len());
        Ok(Totals {
            entries: entries as u64,
            connections: connections as u64,
            bytes,
        })
    }

    /// The per-connection "Record on this connection" switch (off = paused).
    pub fn set_recording(&self, connection_id: &str, on: bool) -> Result<(), AppError> {
        self.with(|c| {
            if on {
                c.execute(
                    "DELETE FROM paused WHERE connection_id = ?1",
                    params![connection_id],
                )
            } else {
                c.execute(
                    "INSERT OR IGNORE INTO paused (connection_id) VALUES (?1)",
                    params![connection_id],
                )
            }
            .map(|_| ())
        })
    }

    pub fn is_recording(&self, connection_id: &str) -> Result<bool, AppError> {
        self.with(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM paused WHERE connection_id = ?1",
                params![connection_id],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n == 0)
        })
    }
}
