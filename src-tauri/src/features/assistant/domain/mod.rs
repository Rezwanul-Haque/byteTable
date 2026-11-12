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

/// A Redis key name reduced to its shape: every segment (split on `:`, `/`,
/// `.`, `|`) that looks like an id or a value — any digit, an `@`, a long or
/// hex-ish token — becomes `*`. `user:1042:session` → `user:*:session`,
/// `email:ann@x.io` → `email:*`. What the prompt shows of Redis is these
/// patterns, never key names as they are.
pub fn key_pattern(key: &str) -> String {
    let mut out = String::new();
    let mut seg = String::new();
    let flush = |seg: &mut String, out: &mut String| {
        let idish = seg.chars().any(|c| c.is_ascii_digit() || c == '@')
            || seg.chars().count() > 24
            || (seg.len() >= 12 && seg.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        out.push_str(if idish && !seg.is_empty() { "*" } else { seg });
        seg.clear();
    };
    for c in key.chars() {
        if matches!(c, ':' | '/' | '.' | '|') {
            flush(&mut seg, &mut out);
            out.push(c);
        } else {
            seg.push(c);
        }
    }
    flush(&mut seg, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_patterns_hide_ids_and_values() {
        assert_eq!(key_pattern("user:1042:session"), "user:*:session");
        assert_eq!(key_pattern("email:ann@x.io"), "email:*.io");
        assert_eq!(
            key_pattern("cache/products/featured"),
            "cache/products/featured"
        );
        assert_eq!(key_pattern("job:6f1c2a9e-77b0-4c1e"), "job:*");
        assert_eq!(key_pattern("rate|login|deadbeefcafe0123"), "rate|login|*");
        assert_eq!(key_pattern("counter"), "counter");
    }

    #[test]
    fn masks_keep_only_prefix_and_tail() {
        assert_eq!(mask_key("sk-ant-api03-abcdefgh3f9a"), "sk-ant-••••3f9a");
        assert_eq!(mask_key("sk-proj1234567881c2"), "sk-••••81c2");
        assert_eq!(mask_key("abcdefgh7d2e"), "••••7d2e");
        assert_eq!(mask_key("abc"), "••••");
    }
}
