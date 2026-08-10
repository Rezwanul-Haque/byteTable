//! The term dictionary behind the empty-state diagnosis (MILESTONE_30 Task 4).
//!
//! # Why this exists at all
//!
//! The playground answers "why did this find nothing?" by naming the *nearest
//! indexed terms* to each query token. Typesense has no endpoint for that, and
//! probe searches cannot substitute: `num_typos` caps at 2 while the panel
//! reaches 4 edits, so a token 3 edits from every indexed term would look
//! identical to one that is 40 edits away. The only way to answer honestly is
//! to hold a term dictionary locally.
//!
//! # The sampling caveat
//!
//! The dictionary is built from a **sample** of the collection (capped at
//! [`SAMPLE_CAP`] documents), so on a large index "nearest term" is best-effort,
//! not exhaustive. That is surfaced to the UI as
//! `EmptyStateDiagnosis::{sampled_documents, complete}` rather than hidden —
//! the panel says "in a sample of N documents" unless the sample covered
//! everything.
//!
//! Everything here is pure: the caller supplies the documents.

use std::collections::HashMap;

use serde_json::Value;

use crate::shared::search::{NearTerm, TokenDiagnosis};

/// Most documents sampled to build a dictionary. Typesense's export streams
/// JSONL, so this is one bounded request, not a scan of the whole index.
pub(super) const SAMPLE_CAP: u32 = 2_000;

/// Widest edit distance the panel will report a term at.
const MAX_EDITS: u32 = 4;

/// Typesense's default `min_len_1typo` — 1 typo needs a token this long.
const MIN_LEN_1_TYPO: usize = 4;
/// Typesense's default `min_len_2typo` — 2 typos need a token this long.
const MIN_LEN_2_TYPO: usize = 7;

/// Tokenize like the search index does: lowercase runs of `[a-z0-9]`.
pub(super) fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        } else if ch.is_alphanumeric() {
            // Non-ASCII letters/digits are indexed too; lowercase them as-is.
            current.extend(ch.to_lowercase());
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Banded Levenshtein distance with early exit. Returns `cap + 1` as soon as
/// the distance is known to exceed `cap`, so scanning a large dictionary stays
/// cheap.
pub(super) fn levenshtein(a: &str, b: &str, cap: u32) -> u32 {
    if a == b {
        return 0;
    }
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if u32::try_from((a.len() as i64 - b.len() as i64).unsigned_abs()).unwrap_or(u32::MAX) > cap {
        return cap + 1;
    }

    let mut prev: Vec<u32> = (0..=b.len() as u32).collect();
    let mut cur = vec![0u32; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i as u32;
        let mut best = cur[0];
        for j in 1..=b.len() {
            let substitution = prev[j - 1] + u32::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(substitution);
            best = best.min(cur[j]);
        }
        if best > cap {
            return cap + 1;
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// How many typos a token of `length` characters actually gets.
///
/// With **relax min_len** on (the playground default) the selected budget
/// applies in full — that is what `min_len_1typo=1&min_len_2typo=1` buys, and
/// why `Kstrl` can reach `Kestrel`. With it off, Typesense's own gating applies:
/// 1 typo needs ≥4 characters, 2 typos need ≥7.
pub(super) fn allowed_typos(num_typos: u8, length: usize, relax_min_len: bool) -> u32 {
    let selected = u32::from(num_typos.min(2));
    if relax_min_len {
        return selected;
    }
    let gated = if length >= MIN_LEN_2_TYPO {
        2
    } else if length >= MIN_LEN_1_TYPO {
        1
    } else {
        0
    };
    selected.min(gated)
}

/// A field-attributed term dictionary built from sampled documents. `Clone` so
/// the connection can hand out a copy of a cached dictionary without holding
/// the cache lock across the diagnosis.
#[derive(Clone)]
pub(super) struct TermDictionary {
    /// term → the first field it was seen in (the field the chip labels).
    terms: HashMap<String, String>,
    /// Documents the dictionary was built from.
    pub sampled: u64,
    /// True when the sample covered the whole collection.
    pub complete: bool,
}

impl TermDictionary {
    /// Build from sampled documents, indexing only `fields`.
    pub fn build(documents: &[Value], fields: &[String], total: u64) -> Self {
        let mut terms: HashMap<String, String> = HashMap::new();
        for doc in documents {
            for field in fields {
                let Some(value) = doc.get(field) else {
                    continue;
                };
                for text in flatten_strings(value) {
                    for term in tokenize(&text) {
                        terms.entry(term).or_insert_with(|| field.clone());
                    }
                }
            }
        }
        let sampled = documents.len() as u64;
        Self {
            terms,
            sampled,
            complete: sampled >= total,
        }
    }

    /// The up-to-three nearest terms to `token`, closest first. Ties break on
    /// the shorter term (the likelier intended word).
    pub fn nearest(&self, token: &str) -> Vec<NearTerm> {
        let mut found: Vec<NearTerm> = Vec::new();
        for (term, field) in &self.terms {
            let distance = levenshtein(token, term, MAX_EDITS);
            if distance > MAX_EDITS {
                continue;
            }
            found.push(NearTerm {
                term: term.clone(),
                field: field.clone(),
                distance,
            });
        }
        found.sort_by(|a, b| {
            a.distance
                .cmp(&b.distance)
                .then_with(|| a.term.len().cmp(&b.term.len()))
                .then_with(|| a.term.cmp(&b.term))
        });
        found.truncate(3);
        found
    }

    /// Diagnose every token of `query` against the dictionary.
    pub fn diagnose(&self, query: &str, num_typos: u8, relax_min_len: bool) -> Vec<TokenDiagnosis> {
        tokenize(query)
            .into_iter()
            .map(|token| {
                let length = token.chars().count();
                let allowed = allowed_typos(num_typos, length, relax_min_len);
                let nearest = self.nearest(&token);
                // "Relaxing min_len would fix this": a term sits within the
                // *selected* budget but outside the *gated* one.
                let selected = u32::from(num_typos.min(2));
                let blocked_by_min_len = !relax_min_len
                    && nearest
                        .first()
                        .is_some_and(|n| n.distance > allowed && n.distance <= selected);
                TokenDiagnosis {
                    token,
                    length: length as u32,
                    allowed_typos: allowed,
                    nearest,
                    blocked_by_min_len,
                }
            })
            .collect()
    }
}

/// Every string reachable in a JSON value — a scalar string, the elements of a
/// `string[]`, or the string leaves of a nested object.
fn flatten_strings(value: &Value) -> Vec<String> {
    match value {
        Value::String(s) => vec![s.clone()],
        Value::Array(items) => items.iter().flat_map(flatten_strings).collect(),
        Value::Object(map) => map.values().flat_map(flatten_strings).collect(),
        // Numbers and booleans are indexed as values, not searchable text.
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tokenize_lowercases_and_splits_on_punctuation() {
        assert_eq!(
            tokenize("Kestrel Pulse 75 TKL — hot-swappable!"),
            vec!["kestrel", "pulse", "75", "tkl", "hot", "swappable"]
        );
    }

    #[test]
    fn tokenize_keeps_non_ascii_letters() {
        assert_eq!(tokenize("Café Größe"), vec!["café", "größe"]);
    }

    #[test]
    fn levenshtein_measures_edits_and_bails_past_the_cap() {
        assert_eq!(levenshtein("kestrel", "kestrel", 4), 0);
        assert_eq!(levenshtein("kstrl", "kestrel", 4), 2);
        assert_eq!(levenshtein("keybord", "keyboard", 4), 1);
        // Beyond the cap the exact number is not computed, only "> cap".
        assert_eq!(levenshtein("aaaa", "zzzzzzzzzz", 2), 3);
    }

    #[test]
    fn min_len_gating_matches_typesense_defaults() {
        // Relaxed: the selected budget applies whatever the length.
        assert_eq!(allowed_typos(2, 3, true), 2);
        // Gated: <4 chars gets nothing, 4–6 gets one, 7+ gets two.
        assert_eq!(allowed_typos(2, 3, false), 0);
        assert_eq!(allowed_typos(2, 4, false), 1);
        assert_eq!(allowed_typos(2, 7, false), 2);
        // The gate can only ever lower the selected budget, never raise it.
        assert_eq!(allowed_typos(1, 12, false), 1);
        // Typesense caps typo tolerance at 2 regardless of what is asked for.
        assert_eq!(allowed_typos(5, 12, true), 2);
    }

    fn dictionary() -> TermDictionary {
        let docs = vec![
            json!({"name": "Kestrel Pulse 75 TKL", "brand": "Kestrel", "price": 249.0}),
            json!({"name": "Nordkey Aero Pro", "brand": "Nordkey", "price": 129.0}),
            json!({"name": "Lumen Halo", "categories": ["lighting", "desks"]}),
        ];
        TermDictionary::build(&docs, &["name".to_string(), "categories".to_string()], 3)
    }

    #[test]
    fn the_dictionary_indexes_only_the_requested_fields() {
        let dict = dictionary();
        assert!(dict.terms.contains_key("kestrel"));
        assert!(dict.terms.contains_key("lighting"), "string[] is flattened");
        assert!(
            !dict.terms.contains_key("nordkey") || dict.terms["nordkey"] == "name",
            "`brand` was not requested, so its terms only appear via `name`"
        );
    }

    #[test]
    fn a_full_sample_is_marked_complete() {
        assert!(dictionary().complete);
        let partial = TermDictionary::build(&[json!({"name": "a"})], &["name".to_string()], 500);
        assert!(!partial.complete);
        assert_eq!(partial.sampled, 1);
    }

    #[test]
    fn kstrl_is_diagnosed_as_two_edits_from_kestrel() {
        // The milestone's acceptance case (Task 4).
        let rows = dictionary().diagnose("Kstrl", 2, true);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.token, "kstrl");
        assert_eq!(row.length, 5);
        assert_eq!(row.allowed_typos, 2, "relaxed, so the full budget applies");
        assert_eq!(row.nearest[0].term, "kestrel");
        assert_eq!(row.nearest[0].distance, 2);
        assert_eq!(row.nearest[0].field, "name");
    }

    #[test]
    fn the_same_token_is_blocked_by_min_len_when_relax_is_off() {
        // 5 characters gates the budget down to 1, but `kestrel` is 2 edits
        // away — exactly the case the "relax min_len" one-click fix solves.
        let rows = dictionary().diagnose("Kstrl", 2, false);
        assert_eq!(rows[0].allowed_typos, 1);
        assert!(rows[0].blocked_by_min_len);
    }

    #[test]
    fn a_token_nothing_is_near_reports_no_terms_and_no_min_len_blame() {
        let rows = dictionary().diagnose("zzzzzzzzzzzz", 2, false);
        assert!(rows[0].nearest.is_empty());
        assert!(!rows[0].blocked_by_min_len);
    }

    #[test]
    fn nearest_prefers_the_closer_then_the_shorter_term() {
        let docs = vec![json!({"name": "halo halos halogen"})];
        let dict = TermDictionary::build(&docs, &["name".to_string()], 1);
        let nearest = dict.nearest("halo");
        assert_eq!(nearest[0].term, "halo");
        assert_eq!(nearest[0].distance, 0);
        assert_eq!(nearest[1].term, "halos");
    }
}
