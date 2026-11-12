//! Domain model for the assistant slice (M44): where prompts go, who may send
//! one, and the prompt contract itself. Pure — no I/O, no Tauri.

pub mod dest;
pub mod prompt;

use serde::{Deserialize, Serialize};

/// One prompt-log line (`assistant-log.jsonl`, Task A11). Prompts only: never a
/// response, never a key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// RFC 3339, local time.
    pub time: String,
    pub kind: String,
    pub tokens: u32,
    pub host: String,
    /// Row values were part of this prompt.
    pub rows: bool,
    /// The exact text that was sent.
    pub text: String,
}

/// Mask a key down to its vendor prefix and last four characters
/// (`sk-ant-••••3f9a`) — the only form of a key that ever reaches the renderer.
pub fn mask_key(key: &str) -> String {
    let key = key.trim();
    let mut prefix_end = 0;
    for (i, seg) in key.split_inclusive('-').enumerate() {
        let body = seg.trim_end_matches('-');
        // A prefix segment is a short lowercase word ending in '-': `sk-`, `ant-`.
        if i < 2
            && seg.ends_with('-')
            && body.len() <= 4
            && body.chars().all(|c| c.is_ascii_lowercase())
        {
            prefix_end += seg.len();
        } else {
            break;
        }
    }
    let chars: Vec<char> = key.chars().collect();
    let tail: String = if chars.len() > prefix_end + 4 {
        chars[chars.len() - 4..].iter().collect()
    } else {
        String::new()
    };
    format!("{}••••{}", &key[..prefix_end], tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_keep_only_prefix_and_tail() {
        assert_eq!(mask_key("sk-ant-api03-abcdefgh3f9a"), "sk-ant-••••3f9a");
        assert_eq!(mask_key("sk-proj1234567881c2"), "sk-••••81c2");
        assert_eq!(mask_key("abcdefgh7d2e"), "••••7d2e");
        assert_eq!(mask_key("abc"), "••••");
    }
}
