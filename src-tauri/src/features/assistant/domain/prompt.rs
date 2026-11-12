//! The prompt contract (M44 §4, Task A9) — a port of the prototype's
//! `BT_AI.buildPrompt`, section for section.
//!
//! One builder for every action. It is fed an introspected
//! [`SchemaSnapshot`] (base tables only), never a live connection, so the
//! exact text is reproducible in tests. The text it returns is the text that
//! is shown in review, sent, logged and kept on the receipt: it is built once
//! and never rebuilt.

use serde::{Deserialize, Serialize};

/// What the prompt is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptKind {
    /// Write SQL from plain language (the prototype's `nl`).
    Ask,
    Explain,
    Plan,
    Index,
    Fix,
}

impl PromptKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Explain => "explain",
            Self::Plan => "plan",
            Self::Index => "index",
            Self::Fix => "fix",
        }
    }
}

/// The query language a workspace speaks — what the assistant writes, the
/// fence it writes it in, and what a schema "object" is called. SQL is the
/// prototype's contract, byte for byte; the others reuse its sections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Language {
    #[default]
    Sql,
    /// Cassandra.
    Cql,
    /// DynamoDB.
    PartiQl,
    /// MongoDB's shell.
    Mongo,
    /// Typesense's HTTP API, as ByteTable's HTTP console takes it.
    Typesense,
    /// Redis commands, as redis-cli takes them.
    Redis,
}

impl Language {
    /// What one entry under `[schema]` is called (plural).
    fn noun(self) -> &'static str {
        match self {
            Self::Mongo | Self::Typesense => "collections",
            Self::Redis => "key patterns",
            _ => "tables",
        }
    }
    /// The same, singular — "5 per table".
    fn noun_one(self) -> &'static str {
        match self {
            Self::Mongo | Self::Typesense => "collection",
            Self::Redis => "key pattern",
            _ => "table",
        }
    }
    /// Plan and index questions are about a SQL engine's optimizer.
    pub fn supports(self, kind: PromptKind) -> bool {
        self == Self::Sql || !matches!(kind, PromptKind::Plan | PromptKind::Index)
    }
}

/// One column, as the schema line prints it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSnap {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    #[serde(default)]
    pub pk: bool,
    /// Covered by a single-column unique index that is not the primary key.
    #[serde(default)]
    pub unique: bool,
    /// `table.column` this column references.
    #[serde(default)]
    pub fk: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    /// An engine's role for the column, printed after the type — "partition
    /// key", "clustering desc", "facet sort". None for SQL.
    #[serde(default)]
    pub tag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSnap {
    pub name: String,
    #[serde(default)]
    pub primary: bool,
}

/// One base table's structure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSnap {
    pub name: String,
    #[serde(default)]
    pub comment: Option<String>,
    pub columns: Vec<ColumnSnap>,
    #[serde(default)]
    pub indexes: Vec<IndexSnap>,
    /// A fact the engine adapter supplies, printed after the entry whatever the
    /// comments switch says — a Redis pattern's "hash · 120 keys". Never a
    /// value.
    #[serde(default)]
    pub note: Option<String>,
}

/// The introspected structure of one schema: every base table, in the order
/// the engine listed them. Views and matviews are out of scope (M44 §1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    pub name: String,
    pub tables: Vec<TableSnap>,
}

/// Sample rows for one table, already fetched.
#[derive(Debug, Clone, PartialEq)]
pub struct RowSample {
    pub table: String,
    /// The table's total row count, when known.
    pub total: Option<u64>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// Each row is one document (a JSON object) rather than column values —
    /// printed as compact JSON with long strings cut.
    pub docs: bool,
}

/// The plan section: the engine's text EXPLAIN, or why there is none.
#[derive(Debug, Clone, PartialEq)]
pub enum PlanText {
    Lines { label: String, lines: Vec<String> },
    Unavailable(String),
}

/// Everything one prompt is built from.
#[derive(Debug, Clone, Default)]
pub struct PromptInput<'a> {
    /// What the assistant writes (SQL unless the workspace speaks something else).
    pub lang: Language,
    /// The dialect named in `[system]`, e.g. `PostgreSQL 16.4`.
    pub engine: &'a str,
    /// The tables the user left ticked; empty = all.
    pub scope: &'a [String],
    pub request: &'a str,
    pub sql: &'a str,
    /// The thread's latest draft, for a follow-up.
    pub prev_sql: Option<&'a str>,
    pub error: &'a str,
    pub comments: bool,
    pub sample_n: u32,
    /// Present only when the user flipped the Rows switch (and the backend
    /// allowed it).
    pub rows: Option<&'a [RowSample]>,
    pub plan: Option<&'a PlanText>,
}

/// One line of the prompt and how the review view styles it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromptPart {
    /// `sec` | `sec-rows` | `rows` | `req` | `` (plain).
    pub k: &'static str,
    pub t: String,
}

/// The built prompt plus the figures the review line needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub parts: Vec<PromptPart>,
    pub text: String,
    /// `chars / 3.7`, shown with "≈" (no provider tokenizer is assumed).
    pub tokens: u32,
    pub tables: usize,
    pub cols: usize,
    pub row_tables: Vec<String>,
}

fn system(kind: PromptKind, lang: Language, engine: &str) -> String {
    if lang != Language::Sql {
        return system_other(kind, lang, engine);
    }
    match kind {
        PromptKind::Ask => format!(
            "You write {engine} for ByteTable. Reply with exactly one statement in a ```sql block.\n\
             Use only the tables and columns listed under [schema]. Begin with \"-- assume:\" lines\n\
             for every interpretation you made. Never write data-modifying statements unless asked."
        ),
        PromptKind::Explain => format!(
            "You explain {engine} queries to a developer in plain English, clause by clause.\n\
             Be concise. Do not rewrite the query unless asked."
        ),
        PromptKind::Plan => format!(
            "You read {engine} EXPLAIN (ANALYZE) output. Name the node that dominates time and\n\
             say why, in two or three sentences. Do not use numbers that are not in the plan."
        ),
        PromptKind::Index => "Suggest at most one index for the query and plan below. Reply with the DDL in a ```sql\n\
             block and one line of rationale. If an existing index already covers it, say so instead."
            .to_string(),
        PromptKind::Fix => "A statement failed. Return the smallest corrected statement in a ```sql block and one\n\
             sentence on what was wrong. Only reference columns that exist in [schema]."
            .to_string(),
    }
}

/// `[system]` for the non-SQL languages: the same jobs, in each engine's terms.
fn system_other(kind: PromptKind, lang: Language, engine: &str) -> String {
    let (what, fence, unit, names) = match lang {
        Language::Cql => (
            format!("CQL for {engine}"),
            "sql",
            "statement",
            "tables and columns",
        ),
        Language::PartiQl => (
            "PartiQL for Amazon DynamoDB".to_string(),
            "sql",
            "statement",
            "tables and attributes",
        ),
        Language::Mongo => (
            "MongoDB shell (mongosh) commands".to_string(),
            "javascript",
            "command",
            "collections and fields",
        ),
        Language::Typesense => (
            "Typesense HTTP requests".to_string(),
            "http",
            "request",
            "collections and fields",
        ),
        Language::Redis => (
            "Redis commands".to_string(),
            "redis",
            "command",
            "key patterns",
        ),
        Language::Sql => unreachable!("SQL has its own [system] text"),
    };
    let assume = match lang {
        Language::Mongo => "//",
        Language::Typesense | Language::Redis => "#",
        _ => "--",
    };
    match kind {
        PromptKind::Ask => {
            let shape = match lang {
                Language::Cql => "Restrict the full partition key (and clustering columns in order) — CQL has\nno joins, and filtering on anything else needs ALLOW FILTERING.",
                Language::PartiQl => "Double-quote table names. String values take single quotes — PK = 'USER#1';\ndouble quotes name an attribute, so PK = \"USER#1\" matches nothing. Filter on the\npartition key (and sort key) where you can — a WHERE on anything else scans the whole table.",
                Language::Mongo => "Write it as db.<collection>.find(...), .countDocuments(...) or .aggregate([...]).\n[schema] has field names and types, never values: when the question needs one you\nweren't given, put a placeholder like ObjectId(\"<userId>\") and say so in an assume line.",
                Language::Typesense => "Write it as: GET /collections/<name>/documents/search?q=...&query_by=...\nquery_by takes string fields; filter_by and sort_by take facet / sortable fields.",
                Language::Redis => "One command per line. [schema] lists key patterns and their types, never values.\nPrefer SCAN with MATCH over KEYS.",
                Language::Sql => unreachable!(),
            };
            format!(
                "You write {what} for ByteTable. Reply with exactly one {unit} in a ```{fence} block.\n\
                 Use only the {names} listed under [schema]. {shape}\n\
                 Begin with \"{assume} assume:\" lines for every interpretation you made. Never write\n\
                 data-modifying {unit}s unless asked."
            )
        }
        PromptKind::Explain => format!(
            "You explain {what} to a developer in plain English, step by step.\n\
             Be concise. Do not rewrite the {unit} unless asked."
        ),
        PromptKind::Fix => format!(
            "A {unit} in {what} failed. Return the smallest corrected {unit} in a ```{fence} block and one\n\
             sentence on what was wrong. Only reference {names} that exist in [schema]."
        ),
        // Refused before a prompt is built (`Language::supports`).
        PromptKind::Plan | PromptKind::Index => String::new(),
    }
}

/// The scoped tables, in schema order. An empty or entirely-unknown scope is
/// the whole schema — a prompt never goes out with no structure at all.
pub fn scoped<'s>(schema: &'s SchemaSnapshot, scope: &[String]) -> Vec<&'s TableSnap> {
    let picked: Vec<&TableSnap> = schema
        .tables
        .iter()
        .filter(|t| scope.iter().any(|s| s == &t.name))
        .collect();
    if picked.is_empty() {
        schema.tables.iter().collect()
    } else {
        picked
    }
}

/// The scope of a message that @-mentions tables: those tables plus the ones
/// they reference by foreign key (so a mention of `orders` can still join to
/// `users`), in schema order. Names match case-insensitively; unknown names
/// are ignored. Empty when nothing mentioned is a table — the caller then
/// keeps the user's ticked scope.
pub fn focus_scope(schema: &SchemaSnapshot, focus: &[String]) -> Vec<String> {
    let wanted: Vec<String> = focus.iter().map(|f| f.to_lowercase()).collect();
    let mentioned: Vec<&TableSnap> = schema
        .tables
        .iter()
        .filter(|t| wanted.contains(&t.name.to_lowercase()))
        .collect();
    let mut keep: Vec<String> = mentioned.iter().map(|t| t.name.to_lowercase()).collect();
    for t in &mentioned {
        for c in &t.columns {
            if let Some(target) =
                c.fk.as_deref()
                    .and_then(|f| f.rsplit_once('.'))
                    .map(|(t, _)| t)
            {
                keep.push(target.to_lowercase());
            }
        }
    }
    schema
        .tables
        .iter()
        .filter(|t| keep.contains(&t.name.to_lowercase()))
        .map(|t| t.name.clone())
        .collect()
}

/// The tables whose rows a Rows-on message sends: those the message names
/// (as whole words), else the first two in scope.
pub fn row_tables_for(scope: &[&TableSnap], texts: &[&str]) -> Vec<String> {
    let hay = texts.join(" ").to_lowercase();
    let hit: Vec<String> = scope
        .iter()
        .filter(|t| contains_word(&hay, &t.name.to_lowercase()))
        .map(|t| t.name.clone())
        .collect();
    if hit.is_empty() {
        scope.iter().take(2).map(|t| t.name.clone()).collect()
    } else {
        hit
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn contains_word(hay: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let mut from = 0;
    while let Some(at) = hay[from..].find(word) {
        let start = from + at;
        let end = start + word.len();
        let before = hay[..start].chars().next_back().is_none_or(|c| !is_word(c));
        let after = hay[end..].chars().next().is_none_or(|c| !is_word(c));
        if before && after {
            return true;
        }
        from = start + word.chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// `table(col type [pk] [unique] [-> ref], …)  -- comment`, the way the
/// prototype prints it. Column comments (an addition: the prototype's sample
/// schema has none) follow as `  -- col: comment` lines.
fn schema_lines(t: &TableSnap, comments: bool) -> Vec<String> {
    // A Redis key pattern has no columns: the pattern and its note are the line.
    if t.columns.is_empty() && t.note.is_some() {
        return vec![format!(
            "{}  -- {}",
            t.name,
            t.note.as_deref().unwrap_or("")
        )];
    }
    let cols: Vec<String> = t
        .columns
        .iter()
        .map(|c| {
            let mut s = format!("{} {}", c.name, c.data_type.to_lowercase());
            if c.pk {
                s.push_str(" pk");
            }
            if c.unique {
                s.push_str(" unique");
            }
            if let Some(fk) = &c.fk {
                s.push_str(" -> ");
                s.push_str(fk);
            }
            if let Some(tag) = c.tag.as_deref().filter(|t| !t.is_empty()) {
                s.push(' ');
                s.push_str(tag);
            }
            s
        })
        .collect();
    let mut line = format!("{}({})", t.name, cols.join(", "));
    if let Some(note) = t.note.as_deref().filter(|n| !n.is_empty()) {
        line.push_str("  -- ");
        line.push_str(note);
    }
    if comments {
        if let Some(c) = t.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            line.push_str("  -- ");
            line.push_str(&one_line(c));
        }
    }
    let mut out = vec![line];
    if comments {
        for c in &t.columns {
            if let Some(cc) = c.comment.as_deref().filter(|c| !c.trim().is_empty()) {
                out.push(format!("  -- {}: {}", c.name, one_line(cc)));
            }
        }
    }
    out
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A sample value as the prototype prints it: strings quoted and cut at 22
/// characters, `null` spelled out.
fn sample_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::String(s) => quote_cut(s),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        other => quote_cut(&other.to_string()),
    }
}

fn quote_cut(s: &str) -> String {
    let n = s.chars().count();
    if n > 22 {
        let head: String = s.chars().take(21).collect();
        format!("'{head}…'")
    } else {
        format!("'{s}'")
    }
}

/// A sample document as one line of compact JSON: every string cut like a
/// column value (22 characters), arrays to their first five items, the whole
/// line capped so one wide document can't flood the prompt.
fn sample_doc(v: &serde_json::Value) -> String {
    fn cut(v: &serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::String(s) if s.chars().count() > 22 => {
                serde_json::Value::String(format!("{}…", s.chars().take(21).collect::<String>()))
            }
            serde_json::Value::Array(a) => {
                serde_json::Value::Array(a.iter().take(5).map(cut).collect())
            }
            serde_json::Value::Object(o) => {
                serde_json::Value::Object(o.iter().map(|(k, v)| (k.clone(), cut(v))).collect())
            }
            other => other.clone(),
        }
    }
    let line = cut(v).to_string();
    if line.chars().count() > 400 {
        format!("{}…", line.chars().take(399).collect::<String>())
    } else {
        line
    }
}

/// `48` → `48`, `12345` → `12,345` (the prototype's `toLocaleString()`).
pub fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Build the prompt for `kind` over `schema`.
pub fn build_prompt(kind: PromptKind, schema: &SchemaSnapshot, c: &PromptInput<'_>) -> Prompt {
    let mut parts: Vec<PromptPart> = Vec::new();
    let mut push = |k: &'static str, t: String| parts.push(PromptPart { k, t });

    let scope = scoped(schema, c.scope);
    let all = schema.tables.len();
    let engine = if c.engine.trim().is_empty() {
        "SQL"
    } else {
        c.engine
    };

    push("sec", "[system]".into());
    for line in system(kind, c.lang, engine).split('\n') {
        push("", line.into());
    }
    push("", String::new());

    let noun = c.lang.noun();
    let counted = if scope.len() == all {
        format!("{} {noun}", scope.len())
    } else {
        format!("{} of {} {noun}", scope.len(), all)
    };
    push(
        "sec",
        format!("[schema] {} · {} · metadata only", schema.name, counted),
    );
    let mut cols = 0;
    for t in &scope {
        cols += t.columns.len();
        for line in schema_lines(t, c.comments) {
            push("", line);
        }
    }
    let idx: Vec<&str> = scope
        .iter()
        .flat_map(|t| t.indexes.iter())
        .filter(|i| !i.primary)
        .map(|i| i.name.as_str())
        .collect();
    if !idx.is_empty() {
        push("", format!("indexes: {}", idx.join(", ")));
    }

    let mut row_tables = Vec::new();
    if let (PromptKind::Ask, Some(samples)) = (kind, c.rows) {
        let n = if c.sample_n == 0 { 5 } else { c.sample_n };
        push("", String::new());
        push(
            "sec-rows",
            format!(
                "[sample rows] {n} per {} · you turned on row data for this request",
                c.lang.noun_one()
            ),
        );
        for s in samples {
            row_tables.push(s.table.clone());
            let take: Vec<&Vec<serde_json::Value>> = s.rows.iter().take(n as usize).collect();
            let head = match s.total {
                Some(total) => format!("{} ({} of {}):", s.table, take.len(), thousands(total)),
                None => format!("{} ({} sampled):", s.table, take.len()),
            };
            push("rows", head);
            for r in take {
                if s.docs {
                    for d in r {
                        push("rows", format!("  {}", sample_doc(d)));
                    }
                } else {
                    let vals: Vec<String> = r.iter().map(sample_value).collect();
                    push("rows", format!("  ({})", vals.join(", ")));
                }
            }
        }
    }

    if let Some(prev) = c.prev_sql.filter(|p| !p.trim().is_empty()) {
        push("", String::new());
        push("sec", "[current draft]".into());
        for l in prev.split('\n') {
            push("req", l.into());
        }
    }
    if kind != PromptKind::Ask {
        push("", String::new());
        push(
            "sec",
            if kind == PromptKind::Fix {
                "[failed statement]"
            } else {
                "[query]"
            }
            .into(),
        );
        for l in c.sql.trim().split('\n') {
            push("req", l.into());
        }
    }
    if matches!(kind, PromptKind::Plan | PromptKind::Index) {
        push("", String::new());
        match c.plan {
            Some(PlanText::Lines { label, lines }) => {
                push("sec", format!("[plan] {label}"));
                for l in lines {
                    push("", l.clone());
                }
            }
            Some(PlanText::Unavailable(why)) => {
                push("sec", "[plan] unavailable".into());
                push("", why.clone());
            }
            None => {
                push("sec", "[plan] unavailable".into());
                push("", "no plan".into());
            }
        }
    }
    if kind == PromptKind::Fix {
        push("", String::new());
        push("sec", "[error]".into());
        let e = c.error.trim();
        let line = if e.to_ascii_lowercase().starts_with("error") {
            e.to_string()
        } else {
            format!("ERROR: {e}")
        };
        for l in line.split('\n') {
            push("req", l.into());
        }
    }
    if kind == PromptKind::Ask {
        push("", String::new());
        push(
            "sec",
            if c.prev_sql.is_some_and(|p| !p.trim().is_empty()) {
                "[change requested]"
            } else {
                "[request]"
            }
            .into(),
        );
        push("req", c.request.into());
    }

    let text = parts
        .iter()
        .map(|p| p.t.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    // UTF-16 units, as the prototype's `text.length` counts them.
    let tokens = (text.encode_utf16().count() as f64 / 3.7).round() as u32;
    Prompt {
        parts,
        text,
        tokens,
        tables: scope.len(),
        cols,
        row_tables,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The prototype's `byteshop` schema (base tables), dumped from
    /// `data.js`; `rows` holds the first sample rows of `orders`.
    #[derive(Deserialize)]
    struct FixtureTable {
        #[serde(flatten)]
        table: TableSnap,
        total: u64,
        rows: Vec<Vec<serde_json::Value>>,
    }
    #[derive(Deserialize)]
    struct Fixture {
        tables: Vec<FixtureTable>,
    }

    fn byteshop() -> (SchemaSnapshot, Vec<FixtureTable>) {
        let f: Fixture = serde_json::from_str(include_str!("fixtures/byteshop.json")).unwrap();
        let schema = SchemaSnapshot {
            name: "byteshop_dev".into(),
            tables: f.tables.iter().map(|t| t.table.clone()).collect(),
        };
        (schema, f.tables)
    }

    const PG: &str = "PostgreSQL 16.4";
    const DRAFT: &str = "SELECT u.full_name, SUM(o.total) AS revenue\nFROM orders o\nJOIN users u ON o.user_id = u.id\nGROUP BY u.full_name\nORDER BY revenue DESC\nLIMIT 10;";

    fn input<'a>() -> PromptInput<'a> {
        PromptInput {
            engine: PG,
            comments: true,
            sample_n: 5,
            ..PromptInput::default()
        }
    }

    #[test]
    fn ask_matches_the_prototype() {
        let (s, _) = byteshop();
        let p = build_prompt(
            PromptKind::Ask,
            &s,
            &PromptInput {
                request: "top 10 customers by revenue last month",
                ..input()
            },
        );
        assert_eq!(p.text, include_str!("fixtures/ask.txt"));
        assert_eq!((p.tokens, p.tables, p.cols), (720, 6, 94));
        assert!(p.row_tables.is_empty());
    }

    #[test]
    fn follow_up_matches_the_prototype() {
        let (s, _) = byteshop();
        let p = build_prompt(
            PromptKind::Ask,
            &s,
            &PromptInput {
                request: "only Germany",
                prev_sql: Some(DRAFT),
                ..input()
            },
        );
        assert_eq!(p.text, include_str!("fixtures/followup.txt"));
        assert_eq!(p.tokens, 759);
    }

    #[test]
    fn explain_matches_the_prototype() {
        let (s, _) = byteshop();
        let p = build_prompt(
            PromptKind::Explain,
            &s,
            &PromptInput {
                sql: "SELECT * FROM orders WHERE status = 'paid' LIMIT 20;",
                ..input()
            },
        );
        assert_eq!(p.text, include_str!("fixtures/explain.txt"));
    }

    #[test]
    fn fix_matches_the_prototype() {
        let (s, _) = byteshop();
        let p = build_prompt(
            PromptKind::Fix,
            &s,
            &PromptInput {
                sql: "SELECT full_nam FROM users;",
                error: "column \"full_nam\" does not exist",
                ..input()
            },
        );
        assert_eq!(p.text, include_str!("fixtures/fix.txt"));
    }

    #[test]
    fn narrowed_scope_reads_n_of_m() {
        let (s, _) = byteshop();
        let scope = vec!["users".to_string(), "orders".to_string()];
        let p = build_prompt(
            PromptKind::Ask,
            &s,
            &PromptInput {
                scope: &scope,
                request: "how many pending orders",
                ..input()
            },
        );
        assert_eq!(p.text, include_str!("fixtures/scoped.txt"));
        assert!(p.text.contains("· 2 of 6 tables ·"));
        assert_eq!((p.tables, p.cols), (2, 13));
    }

    #[test]
    fn rows_match_the_prototype_and_pick_named_tables() {
        let (s, f) = byteshop();
        let scope = vec!["users".to_string(), "orders".to_string()];
        let scoped_tables = scoped(&s, &scope);
        let picked = row_tables_for(&scoped_tables, &["how many pending orders", ""]);
        assert_eq!(picked, vec!["orders".to_string()]);
        let orders = f.iter().find(|t| t.table.name == "orders").unwrap();
        let samples = vec![RowSample {
            table: "orders".into(),
            total: Some(orders.total),
            rows: orders.rows.clone(),
            docs: false,
        }];
        let p = build_prompt(
            PromptKind::Ask,
            &s,
            &PromptInput {
                scope: &scope,
                request: "how many pending orders",
                rows: Some(&samples),
                ..input()
            },
        );
        assert_eq!(p.text, include_str!("fixtures/rows.txt"));
        assert_eq!(p.row_tables, vec!["orders".to_string()]);
    }

    #[test]
    fn rows_fall_back_to_the_first_two_tables() {
        let (s, _) = byteshop();
        let all = scoped(&s, &[]);
        assert_eq!(
            row_tables_for(&all, &["something vague"]),
            vec!["users", "products"]
        );
        // A table name inside another word is not a mention.
        assert_eq!(
            row_tables_for(&all, &["the reorders list"]),
            vec!["users", "products"]
        );
    }

    #[test]
    fn plan_and_index_carry_the_plan_section() {
        let (s, _) = byteshop();
        let plan = PlanText::Lines {
            label: "EXPLAIN · plan only".into(),
            lines: vec!["Seq Scan on orders  (cost=0.00..1.48 rows=48 width=72)".into()],
        };
        for kind in [PromptKind::Plan, PromptKind::Index] {
            let p = build_prompt(
                kind,
                &s,
                &PromptInput {
                    sql: "SELECT * FROM orders",
                    plan: Some(&plan),
                    ..input()
                },
            );
            assert!(p.text.contains("\n[query]\nSELECT * FROM orders\n\n[plan] EXPLAIN · plan only\nSeq Scan on orders"), "{}", p.text);
        }
        let none = PlanText::Unavailable("relation \"nope\" does not exist".into());
        let p = build_prompt(
            PromptKind::Plan,
            &s,
            &PromptInput {
                sql: "SELECT * FROM nope",
                plan: Some(&none),
                ..input()
            },
        );
        assert!(p
            .text
            .ends_with("[plan] unavailable\nrelation \"nope\" does not exist"));
        assert!(p
            .text
            .contains("Do not use numbers that are not in the plan."));
    }

    #[test]
    fn comments_switch_drops_table_and_column_comments() {
        let (mut s, _) = byteshop();
        s.tables[0].columns[1].comment = Some("display name".into());
        let on = build_prompt(
            PromptKind::Ask,
            &s,
            &PromptInput {
                request: "x",
                ..input()
            },
        );
        assert!(on.text.contains("-- Denormalized nightly export"));
        assert!(on.text.contains("\n  -- full_name: display name\n"));
        let off = build_prompt(
            PromptKind::Ask,
            &s,
            &PromptInput {
                request: "x",
                comments: false,
                ..input()
            },
        );
        assert!(!off.text.contains("--  "));
        assert!(!off.text.contains("Denormalized"));
        assert!(!off.text.contains("display name"));
    }

    #[test]
    fn the_text_is_the_parts_joined() {
        let (s, _) = byteshop();
        let p = build_prompt(
            PromptKind::Explain,
            &s,
            &PromptInput {
                sql: "SELECT 1",
                ..input()
            },
        );
        let joined: Vec<&str> = p.parts.iter().map(|x| x.t.as_str()).collect();
        assert_eq!(joined.join("\n"), p.text);
    }

    #[test]
    fn a_mention_focuses_the_scope_and_pulls_in_fk_targets() {
        let (s, _) = byteshop();
        let scope = focus_scope(&s, &["ORDERS".into()]);
        assert_eq!(scope, vec!["users", "orders"], "orders -> users by user_id");
        let scope = focus_scope(&s, &["order_items".into(), "nope".into()]);
        assert_eq!(scope, vec!["products", "orders", "order_items"]);
        assert!(focus_scope(&s, &["nope".into()]).is_empty());
        let p = build_prompt(
            PromptKind::Ask,
            &s,
            &PromptInput {
                scope: &focus_scope(&s, &["orders".into()]),
                request: "@orders from last week",
                ..input()
            },
        );
        assert!(p.text.contains("· 2 of 6 tables ·"), "{}", p.text);
    }

    fn snap(tables: Vec<TableSnap>) -> SchemaSnapshot {
        SchemaSnapshot {
            name: "app".into(),
            tables,
        }
    }

    fn tcol(name: &str, ty: &str, tag: Option<&str>) -> ColumnSnap {
        ColumnSnap {
            name: name.into(),
            data_type: ty.into(),
            pk: false,
            unique: false,
            fk: None,
            comment: None,
            tag: tag.map(str::to_string),
        }
    }

    #[test]
    fn cql_prompts_tag_key_roles_and_name_cql() {
        let s = snap(vec![TableSnap {
            name: "events".into(),
            comment: None,
            columns: vec![
                tcol("user_id", "uuid", Some("partition key")),
                tcol("ts", "timestamp", Some("clustering desc")),
                tcol("kind", "text", None),
            ],
            indexes: vec![],
            note: None,
        }]);
        let p = build_prompt(
            PromptKind::Ask,
            &s,
            &PromptInput {
                lang: Language::Cql,
                engine: "Apache Cassandra 4.1",
                request: "latest events",
                ..PromptInput::default()
            },
        );
        assert!(
            p.text
                .contains("You write CQL for Apache Cassandra 4.1 for ByteTable."),
            "{}",
            p.text
        );
        assert!(p.text.contains("ALLOW FILTERING"));
        assert!(p.text.contains(
            "events(user_id uuid partition key, ts timestamp clustering desc, kind text)"
        ));
        assert!(p.text.contains("[schema] app · 1 tables · metadata only"));
    }

    #[test]
    fn mongo_and_redis_prompts_use_their_own_words() {
        let mongo = snap(vec![TableSnap {
            name: "orders".into(),
            comment: None,
            columns: vec![
                tcol("_id", "objectId", None),
                tcol("status", "string", None),
            ],
            indexes: vec![],
            note: None,
        }]);
        let docs = vec![RowSample {
            table: "orders".into(),
            total: None,
            rows: vec![vec![serde_json::json!({
                "_id": "65f0", "status": "shipped", "note": "a very long note that keeps on going"
            })]],
            docs: true,
        }];
        let p = build_prompt(
            PromptKind::Ask,
            &mongo,
            &PromptInput {
                lang: Language::Mongo,
                engine: "MongoDB 7.0",
                request: "shipped orders",
                rows: Some(&docs),
                sample_n: 5,
                ..PromptInput::default()
            },
        );
        assert!(p.text.contains("```javascript block"));
        assert!(p.text.contains("\"// assume:\""));
        assert!(p.text.contains(r#"placeholder like ObjectId("<userId>")"#));
        assert!(p
            .text
            .contains("[schema] app · 1 collections · metadata only"));
        assert!(p.text.contains("[sample rows] 5 per collection"));
        assert!(p.text.contains("orders (1 sampled):"));
        assert!(
            p.text
                .contains(r#"  {"_id":"65f0","status":"shipped","note":"a very long note that…"}"#),
            "{}",
            p.text
        );

        let redis = snap(vec![TableSnap {
            name: "user:*:session".into(),
            comment: None,
            columns: vec![],
            indexes: vec![],
            note: Some("hash · 120 keys in the sample".into()),
        }]);
        let p = build_prompt(
            PromptKind::Ask,
            &redis,
            &PromptInput {
                lang: Language::Redis,
                engine: "Redis 7.2",
                request: "active sessions",
                ..PromptInput::default()
            },
        );
        assert!(p
            .text
            .contains("[schema] app · 1 key patterns · metadata only"));
        assert!(
            p.text
                .contains("\nuser:*:session  -- hash · 120 keys in the sample\n"),
            "{}",
            p.text
        );
        assert!(p.text.contains("Prefer SCAN with MATCH over KEYS."));
    }

    #[test]
    fn partiql_prompt_says_strings_take_single_quotes() {
        let p = build_prompt(
            PromptKind::Ask,
            &snap(vec![]),
            &PromptInput {
                lang: Language::PartiQl,
                engine: "DynamoDB",
                request: "user U-1006",
                ..PromptInput::default()
            },
        );
        assert!(p
            .text
            .contains("String values take single quotes — PK = 'USER#1'"));
    }

    #[test]
    fn plan_and_index_are_sql_only() {
        for lang in [
            Language::Cql,
            Language::PartiQl,
            Language::Mongo,
            Language::Typesense,
            Language::Redis,
        ] {
            assert!(!lang.supports(PromptKind::Plan));
            assert!(!lang.supports(PromptKind::Index));
            assert!(lang.supports(PromptKind::Ask) && lang.supports(PromptKind::Explain));
        }
        assert!(Language::Sql.supports(PromptKind::Plan));
    }

    #[test]
    fn thousands_groups_like_to_locale_string() {
        assert_eq!(thousands(48), "48");
        assert_eq!(thousands(1234), "1,234");
        assert_eq!(thousands(1234567), "1,234,567");
    }
}
