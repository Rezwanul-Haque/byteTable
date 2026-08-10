//! Search-engine port family (M30, Typesense).
//!
//! Typesense is an HTTP **search API**, not a table store: collections replace
//! databases, documents are JSON, and every read is a search call. There is no
//! SQL, no transactions and no row cursor, so forcing it into the relational
//! [`crate::shared::engine::EngineConnection`] surface — or into any of the
//! NoSQL families ([`crate::shared::document`], [`crate::shared::mongo`],
//! [`crate::shared::widecolumn`]) — would be a lie. It gets its own family per
//! MILESTONE_30 §0: a reader (cluster/schema metadata + search + the empty-state
//! diagnosis + a raw HTTP passthrough) and a deliberately small writer
//! (document upsert + delete only; schema changes, reindex and delete-by-filter
//! are the milestone's explicit "Deferred" list).
//!
//! The [`crate::shared::engine::OpenConnection`] kind enum is the single seam
//! that lets one `ConnectionManager` store a search connection alongside every
//! other family; `get_search` enforces the kind.
//!
//! # Wire shapes
//!
//! All DTOs are camelCase on the wire (matching `src/features/browse/typesense`).
//! Documents are free-form JSON (`serde_json::Value`) — Typesense collections
//! are schema'd but the renderer renders values generically.
//!
//! # Key scope is a first-class concern
//!
//! A Typesense API key is scoped. A **search-only** key cannot call
//! `GET /collections`, `GET /keys`, or the curation endpoints — it gets a 401.
//! Worse, a scoped key's allowed collections are baked *into the key* and there
//! is no self-introspection endpoint, so with a search-only key the client
//! genuinely cannot discover collection names: the user's configured
//! `defaultCollection` is the only one the workspace can show. [`ServerCapabilities`]
//! carries that verdict (probed once at connect) so the renderer renders an
//! "admin key required" empty state up front instead of erroring per view.
//!
//! # Version drift (v30)
//!
//! Typesense v30 moved synonyms and curation off collections and onto top-level
//! resources: `/collections/{c}/synonyms` → `/synonym_sets`,
//! `/collections/{c}/overrides` → `/curation_sets`, and the search parameter
//! `enable_overrides` → `enable_curations`. The adapter detects the server major
//! version from `GET /debug` and speaks whichever dialect applies; this port
//! exposes only the version-neutral shapes.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::shared::engine::EngineInfo;
use crate::shared::error::AppError;

// ---------------------------------------------------------------------------
// Cluster + schema metadata
// ---------------------------------------------------------------------------

/// What the connect-time probe learned about the server and the API key it was
/// given (MILESTONE_30 Task 1 "Key scope matters" / Task 5b test-connection).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    /// Full version string as reported by `GET /debug` (e.g. `"30.1"`).
    pub version: String,
    /// Parsed major version — drives the v30 synonym/curation dialect switch.
    pub major_version: u32,
    /// True when the key can call the admin endpoints (`GET /collections`
    /// succeeded). False for a search-only key: the sidebar falls back to the
    /// configured default collection and the keys/curation views degrade.
    pub admin_key: bool,
    /// The collection the workspace opens on, from the saved connection's
    /// `defaultCollection`. For a search-only key this is the *only* reachable
    /// collection name (see the module note).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_collection: Option<String>,
    /// True when the server speaks the v30+ top-level `synonym_sets` /
    /// `curation_sets` API rather than the per-collection legacy endpoints.
    pub curation_sets_api: bool,
}

/// One node in the Typesense cluster (`GET /debug` + `/health` + `/metrics.json`).
///
/// # Only ever one node
///
/// Typesense has **no cluster-membership endpoint**: peers are configured out of
/// band (the `--nodes` file) and every API call answers for the node you dialled.
/// So this reports the node this connection is talking to, and nothing else. A
/// multi-node cluster still renders one row — the prototype's three-row table
/// was mock data, not something the API can produce.
///
/// # No uptime
///
/// `GET /debug` returns `{state, version}` and nothing more; no Typesense
/// endpoint exposes process uptime. The prototype's "19d 4h" column was
/// invented, so there is deliberately no field for it here — a column that can
/// never be filled reads as a bug.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    /// `host:port` of the node.
    pub host: String,
    /// Raft state — `"LEADER"` / `"FOLLOWER"`, or `"SINGLE"` for a lone node.
    pub state: String,
    /// Whether the node answered `/health` with `{ok: true}`.
    pub healthy: bool,
    /// Typesense's own resident memory (`typesense_memory_resident_bytes`).
    ///
    /// Deliberately the PROCESS figure, not `system_memory_used_bytes`: under
    /// Docker the latter reports the host's usage, which can exceed the
    /// container's `system_memory_total_bytes` and render as "5.5 GB / 4.1 GB".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    /// Total memory visible to the node (`system_memory_total_bytes`), for the
    /// "used / total" reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_total_bytes: Option<u64>,
    /// **Host-wide** CPU percentage (`system_cpu_active_percentage`).
    ///
    /// This is the whole machine's CPU, NOT Typesense's own: `/metrics.json`
    /// has no `typesense_cpu_*` counterpart to its `typesense_memory_*` series,
    /// so no per-process figure exists to report. Two consequences the UI has to
    /// state rather than imply:
    ///
    /// - Nodes co-located on one machine (or one Docker VM) all report the SAME
    ///   value, because it is the same machine.
    /// - The number tracks everything else on that machine. An idle Typesense on
    ///   a busy host reads ~100% — measured: three nodes reporting 93–100% while
    ///   actually using 0.1% CPU each, the rest being other containers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    /// Raft log position (`GET /status` → `committed_index`).
    ///
    /// The one genuine cross-node signal Typesense does expose: every node in a
    /// healthy cluster reports the SAME index, so a node whose index trails the
    /// others is lagging replication. Admin-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed_index: Option<u64>,
    /// Writes queued but not yet applied (`GET /status` → `queued_writes`).
    /// Non-zero means the node is behind on applying its log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_writes: Option<u64>,
    /// Requests per second served by THIS node (`/stats.json` →
    /// `total_requests_per_second`).
    ///
    /// The per-process workload signal Typesense actually provides. Unlike
    /// [`Self::cpu_percent`], which is the whole machine's, this describes what
    /// this Typesense is doing — so co-located nodes report genuinely different
    /// values and a busy neighbour does not distort it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requests_per_second: Option<f64>,
    /// Mean search latency in ms on this node (`/stats.json` → `search_latency_ms`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_latency_ms: Option<f64>,
}

/// Aggregate cluster health for the sidebar's cluster pill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterHealth {
    pub ok: bool,
    pub version: String,
    pub node_count: u32,
}

/// The dashboard's stat cards (MILESTONE_30 Task 6).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterStats {
    pub collections: u32,
    pub documents: u64,
    pub fields: u32,
    pub nodes: u32,
    /// True when every node reported healthy.
    pub healthy: bool,
    /// Typesense's resident memory on the connected node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    /// Total memory visible to that node, for the "used / total" reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_total_bytes: Option<u64>,
}

/// One field in a collection schema (`fields[]` on `GET /collections/{c}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub name: String,
    /// Typesense field type (`string`, `string[]`, `int32`, `int64`, `float`,
    /// `bool`, `geopoint`, `object`, `auto`, …).
    #[serde(rename = "type")]
    pub ty: String,
    pub facet: bool,
    pub optional: bool,
    pub index: bool,
    pub sort: bool,
}

impl FieldInfo {
    /// Whether this is a text field searchable via `query_by`.
    pub fn is_text(&self) -> bool {
        self.ty.starts_with("string")
    }

    /// Whether this is a single-valued scalar (not an array, object or geopoint)
    /// — the shape that reads well in a hit's meta line.
    pub fn is_scalar(&self) -> bool {
        !self.ty.ends_with("[]") && self.ty != "object" && self.ty != "geopoint"
    }
}

/// A collection: its schema plus the presentation metadata the hit rows need.
///
/// `title_field` / `sub_fields` are NOT server concepts — the prototype hard-codes
/// them per collection. They are derived at runtime from the schema per
/// MILESTONE_30 Task 1: the title is the first `string` field that is not
/// `description`/`body`; the sub-fields are up to three facetable/sortable
/// scalars.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDescriptor {
    pub name: String,
    pub num_documents: u64,
    pub fields: Vec<FieldInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_sorting_field: Option<String>,
    /// Always `None` against a real server: `GET /collections/{name}` returns
    /// `{name, num_documents, fields, default_sorting_field, created_at,
    /// symbols_to_index, token_separators, enable_nested_fields}` and no size of
    /// any kind. Typesense reports memory per PROCESS, never per collection, so
    /// the prototype's per-row "61 MB" was mock data. Kept as an `Option` so a
    /// future API that does report it needs no wire change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    /// Which field renders as the hit title (derived — see the type note).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_field: Option<String>,
    /// Up to three fields rendered in the hit meta line (derived).
    #[serde(default)]
    pub sub_fields: Vec<String>,
}

impl CollectionDescriptor {
    /// Derive [`Self::title_field`] and [`Self::sub_fields`] from the schema,
    /// replacing the prototype's hand-authored presentation metadata (Task 1).
    ///
    /// Title: the first text field whose name is not `description` / `body` /
    /// `content` (those are snippet fields, never titles). Sub-fields: up to
    /// three facetable-or-sortable scalars, excluding the title itself.
    pub fn derive_presentation(&mut self) {
        const SNIPPET_NAMES: [&str; 3] = ["description", "body", "content"];

        self.title_field = self
            .fields
            .iter()
            .find(|f| f.is_text() && f.is_scalar() && !SNIPPET_NAMES.contains(&f.name.as_str()))
            .or_else(|| self.fields.iter().find(|f| f.is_text() && f.is_scalar()))
            .map(|f| f.name.clone());

        let title = self.title_field.clone().unwrap_or_default();
        self.sub_fields = self
            .fields
            .iter()
            .filter(|f| {
                f.name != title
                    && f.name != "id"
                    && f.is_scalar()
                    && (f.facet || f.sort)
                    && !SNIPPET_NAMES.contains(&f.name.as_str())
            })
            .take(3)
            .map(|f| f.name.clone())
            .collect();
    }

    /// The default `query_by` field set: every indexed text field, most
    /// selective first (title before the snippet fields).
    pub fn default_query_by(&self) -> Vec<String> {
        let mut fields: Vec<&FieldInfo> = self
            .fields
            .iter()
            .filter(|f| f.is_text() && f.index)
            .collect();
        fields.sort_by_key(|f| match self.title_field.as_deref() {
            Some(t) if t == f.name => 0,
            _ => 1,
        });
        fields.into_iter().map(|f| f.name.clone()).collect()
    }
}

/// An alias pointing at a collection (`GET /aliases`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasInfo {
    pub name: String,
    pub collection_name: String,
}

/// One API key's **metadata** (`GET /keys`).
///
/// Security: Typesense returns only a `value_prefix` — the full key is
/// unretrievable after creation by design. This DTO has no field for one, so a
/// full key can never be displayed or stored (MILESTONE_30 Task 7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyInfo {
    pub id: i64,
    pub description: String,
    /// Permitted actions (`documents:search`, `*`, …).
    pub actions: Vec<String>,
    /// Collection scope patterns (`*`, `products`, …).
    pub collections: Vec<String>,
    /// The first few characters of the key — all the server will ever return.
    pub value_prefix: String,
    /// Unix expiry, or `None` for a key that never expires.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// A synonym rule. One-way when `root` is set (`root` → `synonyms`), otherwise
/// multi-way (every term interchangeable). Version-neutral: read from the
/// per-collection endpoint pre-v30 and from `/synonym_sets` on v30+.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynonymInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    pub synonyms: Vec<String>,
}

/// One pinned document in a curation rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurationPin {
    pub id: String,
    pub position: u32,
}

/// A curation rule (pre-v30 "override", v30+ "curation"): a query trigger plus
/// the documents it pins and hides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurationInfo {
    pub id: String,
    /// The query the rule triggers on (`*` = every query).
    pub rule_query: String,
    /// How `rule_query` is compared — `"exact"` or `"contains"`.
    pub rule_match: String,
    /// Documents pinned to fixed positions.
    #[serde(default)]
    pub includes: Vec<CurationPin>,
    /// Document ids removed from results entirely.
    #[serde(default)]
    pub excludes: Vec<String>,
}

/// One configured analytics rule (`GET /analytics/rules`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsRule {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

/// One row of the popular-queries panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopularQuery {
    pub query: String,
    pub count: u64,
    /// True when the query returned no hits (rendered in the danger tint).
    pub no_hits: bool,
}

/// The dashboard's analytics panel payload.
///
/// Analytics is **optional server configuration**: rules must be created and
/// popular queries land in a destination collection the operator sets up. On a
/// default install this is simply not configured, which is not an error — the
/// renderer shows an explicit "analytics not configured" empty state rather
/// than a blank panel (deviating from the prototype, whose mock data always has
/// analytics).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsOverview {
    /// False when the server has no analytics rules configured at all.
    pub configured: bool,
    #[serde(default)]
    pub rules: Vec<AnalyticsRule>,
    #[serde(default)]
    pub popular_queries: Vec<PopularQuery>,
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// One `query_by` field and its `query_by_weights` weight (1–5 in the UI;
/// Typesense accepts 0–127).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryByField {
    pub field: String,
    pub weight: u32,
}

/// A search request — the playground's controls, one-to-one with the Typesense
/// search parameters (MILESTONE_30 Task 2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub collection: String,
    /// The raw query text. Empty is sent as `*` (match-all).
    #[serde(default)]
    pub q: String,
    pub query_by: Vec<QueryByField>,
    /// 0, 1 or 2 — Typesense caps typo tolerance at 2.
    #[serde(default)]
    pub num_typos: u8,
    #[serde(default = "default_true")]
    pub prefix: bool,
    /// Raw `filter_by` expression, already composed by the renderer's chips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter_by: Option<String>,
    #[serde(default)]
    pub facet_by: Vec<String>,
    /// `sort_by` expression; `None` = relevance (`_text_match:desc`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_by: Option<String>,
    #[serde(default = "default_per_page")]
    pub per_page: u32,
    #[serde(default = "default_page")]
    pub page: u32,
    /// The **relax min_len** toggle (ON by default in the playground). Sends
    /// `min_len_1typo=1&min_len_2typo=1` so short tokens get the full typo
    /// budget — this is why `Kstrl` finds `Kestrel`. Off, the server's default
    /// gating (1 typo needs ≥4 chars, 2 need ≥7) applies.
    #[serde(default = "default_true")]
    pub relax_min_len: bool,
    #[serde(default = "default_true")]
    pub enable_synonyms: bool,
    /// Maps to `enable_curations` (v30+) / `enable_overrides` (pre-v30).
    #[serde(default = "default_true")]
    pub enable_curation: bool,
    /// When true and the collection has curation rules, the adapter issues a
    /// second curation-off search and reports the difference as
    /// [`SearchResponse::hidden_by_curation`]. Off by default — it doubles the
    /// request, so the renderer only asks when a rule could actually apply.
    #[serde(default)]
    pub count_hidden: bool,
}

fn default_true() -> bool {
    true
}
fn default_per_page() -> u32 {
    12
}
fn default_page() -> u32 {
    1
}

/// Typesense's per-hit ranking breakdown (`text_match_info`).
///
/// Note what this is *not*: it is **aggregate per hit**, with no per-token
/// detail. The relevance x-ray's per-token rows (matched field, match kind,
/// position) are therefore derived in the renderer from
/// [`Highlight::matched_tokens`], with these numbers shown as the authoritative
/// head. See MILESTONE_30 Task 2.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMatchInfo {
    /// Server-side these are 64-bit values serialized as strings (they exceed
    /// JSON's safe integer range), so they stay strings all the way to the UI.
    #[serde(default)]
    pub best_field_score: String,
    #[serde(default)]
    pub score: String,
    #[serde(default)]
    pub best_field_weight: u32,
    #[serde(default)]
    pub fields_matched: u32,
    #[serde(default)]
    pub tokens_matched: u32,
    #[serde(default)]
    pub num_tokens_dropped: u32,
    #[serde(default)]
    pub typo_prefix_score: u32,
}

/// One field's highlight for a hit. Typesense returns `snippet` +
/// `matched_tokens` for a scalar string field and `snippets` + `indices` +
/// nested `matched_tokens` for a `string[]`; both shapes are flattened here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub field: String,
    /// The `<mark>`-wrapped snippet (first element for an array field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// Every token of the query that matched in this field, flattened across
    /// array elements. The x-ray's per-token attribution is built from this.
    #[serde(default)]
    pub matched_tokens: Vec<String>,
}

/// One search hit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub document: Value,
    /// The raw `text_match` ranking score (64-bit, kept as a string).
    #[serde(default)]
    pub text_match: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_match_info: Option<TextMatchInfo>,
    #[serde(default)]
    pub highlights: Vec<Highlight>,
    /// True when a curation rule pinned this document into place.
    #[serde(default)]
    pub curated: bool,
}

/// One value bucket of a facet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetValue {
    pub value: String,
    pub count: u64,
}

/// One field's facet counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetCount {
    pub field_name: String,
    pub counts: Vec<FacetValue>,
}

/// A search response — the server's own numbers, never recomputed locally.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub found: u64,
    pub out_of: u64,
    pub page: u32,
    pub per_page: u32,
    pub search_time_ms: f64,
    pub hits: Vec<SearchHit>,
    #[serde(default)]
    pub facet_counts: Vec<FacetCount>,
    /// How many matching documents curation rules removed, when
    /// [`SearchRequest::count_hidden`] asked for it and a rule could apply.
    /// `None` means "not computed" — the UI shows no chip rather than a zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_by_curation: Option<u64>,
    /// Tokens the server dropped to find results (`drop_tokens_threshold`),
    /// read off the first hit's `text_match_info.num_tokens_dropped`.
    #[serde(default)]
    pub dropped_tokens: u32,
    /// The exact parameters sent, for the request panel + the `curl` builder.
    pub request_params: BTreeMap<String, String>,
    /// The URL the search was issued against (no API key in it).
    pub request_url: String,
}

/// A page of raw documents for the Documents tab (`/documents/export` with
/// paging applied client-side by the adapter, or a match-all search).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPage {
    pub documents: Vec<Value>,
    pub total: u64,
    pub page: u32,
    pub per_page: u32,
}

// ---------------------------------------------------------------------------
// Empty-state diagnosis
// ---------------------------------------------------------------------------

/// One indexed term near a query token that found nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearTerm {
    pub term: String,
    /// The field the term was found in.
    pub field: String,
    /// Levenshtein distance from the query token.
    pub distance: u32,
}

/// The per-token verdict behind the "why did this find nothing?" panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenDiagnosis {
    pub token: String,
    /// Token length in characters — the number the min_len rule gates on.
    pub length: u32,
    /// Typos actually allowed for this token under the current settings.
    pub allowed_typos: u32,
    /// Up to three nearest indexed terms within 4 edits, closest first.
    pub nearest: Vec<NearTerm>,
    /// True when a term WAS within the selected `num_typos` but the min_len
    /// rule cut the budget below it — i.e. "relax min_len" would fix this.
    pub blocked_by_min_len: bool,
}

/// The whole empty-state diagnosis.
///
/// Typesense has no "nearest indexed term" endpoint, and probe searches cannot
/// help (`num_typos` caps at 2 while the panel reaches 4 edits). The adapter
/// therefore samples documents and builds a local term dictionary, cached per
/// collection. [`Self::sampled_documents`] and [`Self::complete`] carry that
/// caveat to the UI so it can say "in a sample of N documents" rather than
/// implying it scanned the whole index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyStateDiagnosis {
    pub tokens: Vec<TokenDiagnosis>,
    /// How many documents the term dictionary was built from.
    pub sampled_documents: u64,
    /// True when the sample covered the entire collection (so "nearest term" is
    /// exact rather than best-effort).
    pub complete: bool,
}

// ---------------------------------------------------------------------------
// HTTP console
// ---------------------------------------------------------------------------

/// A parsed console command: a method, a path (with query string) and an
/// optional JSON body. The forgiving *parsing* of what the user typed (bare
/// paths, full URLs, pasted `curl` with `-H`/`-X`/`-d`) is the renderer's job;
/// this is the already-normalized shape the backend proxies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpConsoleRequest {
    /// `GET` / `POST` / `PATCH` / `PUT` / `DELETE`.
    pub method: String,
    /// Path plus query string, always leading-slashed (`/collections/products`).
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// The raw response, printed verbatim by the console.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpConsoleResponse {
    pub status: u16,
    /// Parsed JSON when the body was JSON, else a string — the console's
    /// syntax highlighter renders either.
    pub body: Value,
}

// ---------------------------------------------------------------------------
// Port traits
// ---------------------------------------------------------------------------

/// Read side of a search connection (MILESTONE_30 Tasks 1/2/4/6/7/8).
///
/// Admin-only reads ([`Self::api_keys`], [`Self::collections`],
/// [`Self::synonyms`], [`Self::curations`]) return
/// [`AppError::Unsupported`] — not a driver error — when the connection's key
/// lacks the scope, so the renderer can render the documented empty state.
#[async_trait]
pub trait SearchIndexReader: Send + Sync {
    /// `GET /health` + `GET /debug` — the sidebar cluster pill.
    async fn health(&self) -> Result<ClusterHealth, AppError>;

    /// Per-node host / raft state / health / uptime / memory. A single-node
    /// server yields one row.
    async fn nodes(&self) -> Result<Vec<NodeInfo>, AppError>;

    /// Aggregate counts for the dashboard stat cards.
    async fn cluster_stats(&self) -> Result<ClusterStats, AppError>;

    /// `GET /collections` with presentation metadata derived. **Admin only.**
    async fn collections(&self) -> Result<Vec<CollectionDescriptor>, AppError>;

    /// `GET /collections/{name}` — reachable with a search-only key scoped to
    /// that collection, which is why it is separate from [`Self::collections`].
    async fn collection(&self, name: &str) -> Result<CollectionDescriptor, AppError>;

    /// `GET /aliases`. **Admin only.**
    async fn aliases(&self) -> Result<Vec<AliasInfo>, AppError>;

    /// `GET /keys` — metadata only; full keys are never retrievable. **Admin only.**
    async fn api_keys(&self) -> Result<Vec<ApiKeyInfo>, AppError>;

    /// Synonyms applying to a collection (per-collection pre-v30,
    /// `/synonym_sets` on v30+). **Admin only.**
    async fn synonyms(&self, collection: &str) -> Result<Vec<SynonymInfo>, AppError>;

    /// Curation rules applying to a collection (`overrides` pre-v30,
    /// `/curation_sets` on v30+). **Admin only.**
    async fn curations(&self, collection: &str) -> Result<Vec<CurationInfo>, AppError>;

    /// Analytics rules + popular queries; `configured: false` when the server
    /// has no analytics set up (the common case — not an error).
    async fn analytics(&self) -> Result<AnalyticsOverview, AppError>;

    /// Run a search and return the server's own numbers.
    async fn search(&self, request: SearchRequest) -> Result<SearchResponse, AppError>;

    /// A page of raw documents for the Documents tab.
    async fn documents(
        &self,
        collection: &str,
        page: u32,
        per_page: u32,
    ) -> Result<DocumentPage, AppError>;

    /// Diagnose an empty result set against a sampled term dictionary (Task 4).
    async fn diagnose(
        &self,
        collection: &str,
        fields: Vec<String>,
        query: &str,
        num_typos: u8,
        relax_min_len: bool,
    ) -> Result<EmptyStateDiagnosis, AppError>;

    /// Proxy an arbitrary request to the server, for the HTTP console. The API
    /// key header is added here so it never reaches the renderer.
    async fn raw_http(&self, request: HttpConsoleRequest) -> Result<HttpConsoleResponse, AppError>;
}

/// Write side of a search connection — deliberately just two operations
/// (MILESTONE_30 §0: schema changes, reindex and delete-by-filter are Deferred).
#[async_trait]
pub trait SearchIndexWriter: Send + Sync {
    /// `POST /collections/{c}/documents?action=upsert` — create or replace one
    /// document. Returns the stored document as the server echoed it.
    async fn upsert_document(&self, collection: &str, document: Value) -> Result<Value, AppError>;

    /// `DELETE /collections/{c}/documents/{id}`.
    async fn delete_document(&self, collection: &str, id: &str) -> Result<(), AppError>;
}

/// A live Typesense connection: the read + write ports bundled, plus the shared
/// [`EngineInfo`] accessor, the connect-time [`ServerCapabilities`] verdict and
/// an orderly `close`. The `engines::typesense` adapter implements all three;
/// the [`crate::shared::engine::OpenConnection`] `Search` arm holds an
/// `Arc<dyn SearchConnection>`.
#[async_trait]
pub trait SearchConnection: SearchIndexReader + SearchIndexWriter {
    /// Engine + version of this connection (`Typesense 30.1`).
    fn engine_info(&self) -> EngineInfo;

    /// What the connect-time probe learned about the server and the key scope.
    fn capabilities(&self) -> ServerCapabilities;

    /// Release transport resources. `reqwest::Client` is `Arc`/`Drop`-managed,
    /// so this is a no-op, but the manager calls it for symmetry.
    async fn close(&self) -> Result<(), AppError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(name: &str, ty: &str, facet: bool, sort: bool) -> FieldInfo {
        FieldInfo {
            name: name.into(),
            ty: ty.into(),
            facet,
            optional: false,
            index: true,
            sort,
        }
    }

    fn products() -> CollectionDescriptor {
        CollectionDescriptor {
            name: "products".into(),
            num_documents: 28,
            fields: vec![
                field("name", "string", false, false),
                field("brand", "string", true, false),
                field("categories", "string[]", true, false),
                field("description", "string", false, false),
                field("price", "float", false, true),
                field("rating", "float", true, true),
                field("in_stock", "bool", true, false),
            ],
            default_sorting_field: Some("popularity".into()),
            memory_bytes: Some(1_048_576),
            title_field: None,
            sub_fields: Vec::new(),
        }
    }

    #[test]
    fn title_field_skips_the_snippet_fields() {
        let mut c = products();
        c.derive_presentation();
        assert_eq!(c.title_field.as_deref(), Some("name"));
    }

    #[test]
    fn sub_fields_are_up_to_three_facetable_or_sortable_scalars() {
        let mut c = products();
        c.derive_presentation();
        // `categories` is an array (not scalar) and `description` is a snippet
        // field, so neither qualifies.
        assert_eq!(c.sub_fields, vec!["brand", "price", "rating"]);
    }

    #[test]
    fn default_query_by_puts_the_title_first_and_keeps_only_text_fields() {
        let mut c = products();
        c.derive_presentation();
        assert_eq!(
            c.default_query_by(),
            vec!["name", "brand", "categories", "description"]
        );
    }

    #[test]
    fn a_collection_of_only_snippet_fields_still_gets_a_title() {
        let mut c = CollectionDescriptor {
            name: "notes".into(),
            num_documents: 1,
            fields: vec![field("body", "string", false, false)],
            default_sorting_field: None,
            memory_bytes: None,
            title_field: None,
            sub_fields: Vec::new(),
        };
        c.derive_presentation();
        assert_eq!(c.title_field.as_deref(), Some("body"));
    }

    #[test]
    fn search_request_defaults_match_the_playground_defaults() {
        let request: SearchRequest = serde_json::from_str(
            r#"{"collection":"products","queryBy":[{"field":"name","weight":3}]}"#,
        )
        .expect("deserialize");
        assert!(request.prefix);
        assert!(request.relax_min_len, "relax min_len is ON by default");
        assert!(request.enable_synonyms);
        assert!(request.enable_curation);
        assert!(!request.count_hidden, "the shadow query is opt-in");
        assert_eq!(request.per_page, 12);
        assert_eq!(request.page, 1);
    }

    #[test]
    fn api_key_info_has_no_field_for_a_full_key() {
        let json = serde_json::to_value(ApiKeyInfo {
            id: 1,
            description: "search-only".into(),
            actions: vec!["documents:search".into()],
            collections: vec!["products".into()],
            value_prefix: "xyz1".into(),
            expires_at: None,
        })
        .expect("serialize");
        let object = json.as_object().expect("object");
        assert!(object.contains_key("valuePrefix"));
        assert!(!object.contains_key("value"));
        // `expiresAt: None` is skipped entirely rather than serialized as null.
        assert!(!object.contains_key("expiresAt"));
    }

    #[test]
    fn text_match_scores_stay_strings_so_64_bit_precision_survives() {
        // This DTO is the *renderer-facing* shape (camelCase). Typesense's own
        // snake_case payload is read by `engines::typesense::reader`'s tolerant
        // parser, not by this derive — the two are deliberately separate, since
        // the server sends the 64-bit members as strings and the counters as
        // numbers, which no single derive would capture.
        let json = serde_json::to_value(TextMatchInfo {
            best_field_score: "1108091339008".into(),
            score: "578730123365711872".into(),
            best_field_weight: 15,
            fields_matched: 1,
            tokens_matched: 1,
            num_tokens_dropped: 0,
            typo_prefix_score: 1,
        })
        .expect("serialize");
        // The scores cross the wire as strings: as JSON numbers they would
        // exceed the renderer's safe integer range and silently lose precision.
        assert_eq!(json["score"], "578730123365711872");
        assert_eq!(json["bestFieldScore"], "1108091339008");
        assert_eq!(json["bestFieldWeight"], 15);
    }
}
