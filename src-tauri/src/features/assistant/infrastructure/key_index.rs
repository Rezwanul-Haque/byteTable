//! The key index (`assistant-keys.json` in app data): which keychain accounts
//! hold a key, and its masked label. Not a secret — the label is the vendor
//! prefix and last four characters the UI already shows — and it lets Settings
//! and the drawer show key status without reading the keychain.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::shared::error::AppError;

use super::super::ports::KeyIndex;

pub struct JsonKeyIndex {
    path: PathBuf,
    lock: Mutex<()>,
}

impl JsonKeyIndex {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> BTreeMap<String, Option<String>> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }
}

impl KeyIndex for JsonKeyIndex {
    fn get(&self, account: &str) -> Result<Option<Option<String>>, AppError> {
        let _g = self.lock.lock().unwrap();
        Ok(self.read().get(account).cloned())
    }

    fn set(&self, account: &str, masked: Option<String>) -> Result<(), AppError> {
        let _g = self.lock.lock().unwrap();
        let mut all = self.read();
        all.insert(account.to_string(), masked);
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&all)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// Test fake.
#[derive(Default)]
pub struct InMemoryKeyIndex(Mutex<BTreeMap<String, Option<String>>>);

impl KeyIndex for InMemoryKeyIndex {
    fn get(&self, account: &str) -> Result<Option<Option<String>>, AppError> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, masked: Option<String>) -> Result<(), AppError> {
        self.0.lock().unwrap().insert(account.to_string(), masked);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_labels_and_absence_on_disk() {
        let dir = std::env::temp_dir().join(format!("bt-keyidx-{}", uuid::Uuid::new_v4()));
        let idx = JsonKeyIndex::new(dir.join("assistant-keys.json"));
        assert_eq!(idx.get("openai").unwrap(), None, "never recorded");
        idx.set("openai", Some("sk-••••81c2".into())).unwrap();
        idx.set("anthropic", None).unwrap();
        let again = JsonKeyIndex::new(dir.join("assistant-keys.json"));
        assert_eq!(
            again.get("openai").unwrap(),
            Some(Some("sk-••••81c2".into()))
        );
        assert_eq!(again.get("anthropic").unwrap(), Some(None));
        let _ = std::fs::remove_dir_all(dir);
    }
}
