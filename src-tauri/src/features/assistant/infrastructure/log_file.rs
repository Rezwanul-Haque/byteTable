//! The local prompt log (Task A11): one JSON object per line in
//! `assistant-log.jsonl` under the app's data directory. Prompts only — no
//! responses, no keys.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::shared::error::AppError;

use super::super::domain::LogEntry;
use super::super::ports::PromptLog;

/// Keep the file bounded: past this many lines the oldest are dropped.
const MAX_ENTRIES: usize = 500;

pub struct JsonlPromptLog {
    path: PathBuf,
    lock: Mutex<()>,
}

impl JsonlPromptLog {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn read_all(&self) -> Result<Vec<LogEntry>, AppError> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        // A torn or hand-edited line is skipped, not fatal.
        Ok(text
            .lines()
            .filter_map(|l| serde_json::from_str::<LogEntry>(l).ok())
            .collect())
    }
}

impl PromptLog for JsonlPromptLog {
    fn append(&self, entry: &LogEntry) -> Result<(), AppError> {
        let _g = self.lock.lock().unwrap();
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut all = self.read_all()?;
        if all.len() >= MAX_ENTRIES {
            all.drain(..=all.len() - MAX_ENTRIES);
            all.push(entry.clone());
            let mut out = String::new();
            for e in &all {
                out.push_str(&serde_json::to_string(e)?);
                out.push('\n');
            }
            std::fs::write(&self.path, out)?;
            return Ok(());
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(f, "{}", serde_json::to_string(entry)?)?;
        Ok(())
    }

    fn read_last(&self, limit: usize) -> Result<(Vec<LogEntry>, usize), AppError> {
        let _g = self.lock.lock().unwrap();
        let all = self.read_all()?;
        let total = all.len();
        Ok((all.into_iter().rev().take(limit).collect(), total))
    }

    fn clear(&self) -> Result<(), AppError> {
        let _g = self.lock.lock().unwrap();
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(i: u32) -> LogEntry {
        LogEntry {
            time: format!("t{i}"),
            kind: "ask".into(),
            tokens: i,
            host: "localhost:11434".into(),
            rows: false,
            text: format!("[system]\nprompt {i}\nwith \"quotes\" and ünïcode"),
        }
    }

    #[test]
    fn round_trips_text_byte_for_byte_and_reads_newest_first() {
        let dir = std::env::temp_dir().join(format!("bt-ailog-{}", uuid::Uuid::new_v4()));
        let log = JsonlPromptLog::new(dir.join("assistant-log.jsonl"));
        assert_eq!(log.read_last(10).unwrap().1, 0);
        log.append(&entry(1)).unwrap();
        log.append(&entry(2)).unwrap();
        let (got, total) = log.read_last(10).unwrap();
        assert_eq!(total, 2);
        assert_eq!(got[0], entry(2));
        assert_eq!(got[1].text, entry(1).text);
        log.clear().unwrap();
        assert_eq!(log.read_last(10).unwrap().1, 0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
