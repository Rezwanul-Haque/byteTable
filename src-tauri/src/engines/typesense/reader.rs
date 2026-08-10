//! The [`SearchIndexReader`] implementation: cluster/schema metadata, search,
//! the empty-state diagnosis and the HTTP-console passthrough.
//!
//! # Version dialects
//!
//! Typesense v30 moved synonyms and curation off collections onto top-level
//! resources and renamed the search parameter that disables curation. Both
//! dialects are spoken, chosen by the major version probed at connect:
//!
//! | concept          | ≤ v29                              | v30+             |
//! | ---------------- | ---------------------------------- | ---------------- |
//! | synonyms         | `/collections/{c}/synonyms`        | `/synonym_sets`  |
//! | curation rules   | `/collections/{c}/overrides`       | `/curation_sets` |
//! | disable curation | `enable_overrides=false`           | `enable_curations=false` |
//!
//! # Numbers come from the server
//!
//! `found` / `out_of` / `search_time_ms` / `facet_counts` / `text_match` are
//! read straight off the response and never recomputed — the playground's whole
//! value is that its numbers are the server's. The one figure Typesense does
//! not report is how many documents curation *hid*: there is no such response
//! field, so [`search`] optionally derives it by re-running the search with
//! curation off and differencing `found` (opt-in via
//! `SearchRequest::count_hidden`, because it doubles the request).

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;

use crate::shared::error::AppError;
use crate::shared::search::{
    AliasInfo, AnalyticsOverview, AnalyticsRule, ApiKeyInfo, ClusterHealth, ClusterStats,
    CollectionDescriptor, CurationInfo, CurationPin, DocumentPage, EmptyStateDiagnosis, FacetCount,
    FacetValue, FieldInfo, Highlight, HttpConsoleRequest, HttpConsoleResponse, NodeInfo,
    PopularQuery, SearchHit, SearchIndexReader, SearchRequest, SearchResponse, SynonymInfo,
    TextMatchInfo,
};

use super::http::TypesenseHttp;
use super::terms::{TermDictionary, SAMPLE_CAP};
use super::TypesenseConnection;

// ---------------------------------------------------------------------------
// Wire shapes (only the fields we read)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct WireField {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    facet: bool,
    #[serde(default)]
    optional: bool,
    #[serde(default = "yes")]
    index: bool,
    #[serde(default)]
    sort: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct WireCollection {
    name: String,
    #[serde(default)]
    num_documents: u64,
    #[serde(default)]
    fields: Vec<WireField>,
    #[serde(default)]
    default_sorting_field: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireAlias {
    name: String,
    collection_name: String,
}

#[derive(Debug, Deserialize)]
struct WireAliases {
    #[serde(default)]
    aliases: Vec<WireAlias>,
}

#[derive(Debug, Deserialize)]
struct WireKey {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    description: String,
    #[serde(default)]
    actions: Vec<String>,
    #[serde(default)]
    collections: Vec<String>,
    #[serde(default)]
    value_prefix: String,
    #[serde(default)]
    expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct WireKeys {
    #[serde(default)]
    keys: Vec<WireKey>,
}

#[derive(Debug, Deserialize)]
struct WireSynonym {
    id: String,
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    synonyms: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct WireCurationRule {
    #[serde(default)]
    query: String,
    #[serde(rename = "match", default)]
    match_kind: String,
}

#[derive(Debug, Deserialize)]
struct WireCurationInclude {
    id: String,
    #[serde(default)]
    position: u32,
}

#[derive(Debug, Deserialize)]
struct WireCurationExclude {
    id: String,
}

#[derive(Debug, Deserialize)]
struct WireCuration {
    id: String,
    #[serde(default)]
    rule: Option<WireCurationRule>,
    #[serde(default)]
    includes: Vec<WireCurationInclude>,
    #[serde(default)]
    excludes: Vec<WireCurationExclude>,
}

#[derive(Debug, Deserialize)]
struct WireHighlight {
    #[serde(default)]
    field: String,
    #[serde(default)]
    snippet: Option<String>,
    #[serde(default)]
    snippets: Vec<String>,
    /// Scalar fields give `["kestrel"]`; `string[]` fields give
    /// `[["kestrel"],["pulse"]]`. Untyped so both parse.
    #[serde(default)]
    matched_tokens: Value,
}

#[derive(Debug, Deserialize)]
struct WireHit {
    #[serde(default)]
    document: Value,
    /// 64-bit; Typesense may send it as a number or a string depending on the
    /// route, so it is read untyped and stringified.
    #[serde(default)]
    text_match: Value,
    #[serde(default)]
    text_match_info: Option<Value>,
    #[serde(default)]
    highlights: Vec<WireHighlight>,
    #[serde(default)]
    curated: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct WireFacetCount {
    #[serde(default)]
    value: String,
    #[serde(default)]
    count: u64,
}

#[derive(Debug, Deserialize)]
struct WireFacet {
    #[serde(default)]
    field_name: String,
    #[serde(default)]
    counts: Vec<WireFacetCount>,
}

#[derive(Debug, Deserialize)]
struct WireSearch {
    #[serde(default)]
    found: u64,
    #[serde(default)]
    out_of: u64,
    #[serde(default = "one")]
    page: u32,
    #[serde(default)]
    search_time_ms: f64,
    #[serde(default)]
    hits: Vec<WireHit>,
    #[serde(default)]
    facet_counts: Vec<WireFacet>,
}

fn one() -> u32 {
    1
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

impl From<WireField> for FieldInfo {
    fn from(f: WireField) -> Self {
        Self {
            name: f.name,
            ty: f.ty,
            facet: f.facet,
            optional: f.optional,
            index: f.index,
            sort: f.sort,
        }
    }
}

impl From<WireCollection> for CollectionDescriptor {
    fn from(c: WireCollection) -> Self {
        let mut descriptor = Self {
            name: c.name,
            num_documents: c.num_documents,
            fields: c.fields.into_iter().map(FieldInfo::from).collect(),
            default_sorting_field: c.default_sorting_field.filter(|s| !s.is_empty()),
            memory_bytes: None,
            title_field: None,
            sub_fields: Vec::new(),
        };
        descriptor.derive_presentation();
        descriptor
    }
}

/// Stringify a 64-bit score that may arrive as a JSON number or string.
fn score_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// Flatten `matched_tokens`, which is `["a"]` for a scalar field and
/// `[["a"],["b"]]` for a `string[]`.
fn flatten_matched(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .flat_map(|item| match item {
                Value::String(s) => vec![s.clone()],
                nested @ Value::Array(_) => flatten_matched(nested),
                _ => Vec::new(),
            })
            .collect(),
        Value::String(s) => vec![s.clone()],
        _ => Vec::new(),
    }
}

impl From<WireHighlight> for Highlight {
    fn from(h: WireHighlight) -> Self {
        Self {
            field: h.field,
            snippet: h.snippet.or_else(|| h.snippets.into_iter().next()),
            matched_tokens: flatten_matched(&h.matched_tokens),
        }
    }
}

impl From<WireHit> for SearchHit {
    fn from(h: WireHit) -> Self {
        Self {
            document: h.document,
            text_match: score_string(&h.text_match),
            text_match_info: h.text_match_info.and_then(parse_text_match_info),
            highlights: h.highlights.into_iter().map(Highlight::from).collect(),
            curated: h.curated.unwrap_or(false),
        }
    }
}

/// `text_match_info`'s 64-bit members arrive as strings and its small counters
/// as numbers; read each tolerantly so a server that changes representation
/// does not blank the panel.
fn parse_text_match_info(value: Value) -> Option<TextMatchInfo> {
    let object = value.as_object()?;
    let string_of = |k: &str| object.get(k).map(score_string).unwrap_or_default();
    let number_of = |k: &str| {
        object
            .get(k)
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(0) as u32
    };
    Some(TextMatchInfo {
        best_field_score: string_of("best_field_score"),
        score: string_of("score"),
        best_field_weight: number_of("best_field_weight"),
        fields_matched: number_of("fields_matched"),
        tokens_matched: number_of("tokens_matched"),
        num_tokens_dropped: number_of("num_tokens_dropped"),
        typo_prefix_score: number_of("typo_prefix_score"),
    })
}

// ---------------------------------------------------------------------------
// Search parameter building
// ---------------------------------------------------------------------------

/// Compose the search query string from a [`SearchRequest`].
///
/// `curation_sets_api` selects `enable_curations` (v30+) over the legacy
/// `enable_overrides`. Returned as an ordered map so the request panel shows a
/// stable, readable parameter list.
pub(super) fn search_params(
    request: &SearchRequest,
    curation_sets_api: bool,
) -> BTreeMap<String, String> {
    let mut params = BTreeMap::new();

    // An empty box means "match everything" — Typesense spells that `*`.
    let q = if request.q.trim().is_empty() {
        "*".to_string()
    } else {
        request.q.clone()
    };
    params.insert("q".into(), q);

    let active: Vec<&_> = request.query_by.iter().collect();
    params.insert(
        "query_by".into(),
        active
            .iter()
            .map(|f| f.field.as_str())
            .collect::<Vec<_>>()
            .join(","),
    );
    params.insert(
        "query_by_weights".into(),
        active
            .iter()
            .map(|f| f.weight.to_string())
            .collect::<Vec<_>>()
            .join(","),
    );
    params.insert("num_typos".into(), request.num_typos.min(2).to_string());
    params.insert("prefix".into(), request.prefix.to_string());
    params.insert("per_page".into(), request.per_page.to_string());
    params.insert("page".into(), request.page.to_string());

    // The relax-min_len toggle: send 1/1 so short tokens get the full typo
    // budget. Off, the server's own defaults (4 / 7) apply, so we send nothing.
    if request.relax_min_len {
        params.insert("min_len_1typo".into(), "1".into());
        params.insert("min_len_2typo".into(), "1".into());
    }

    if !request.enable_synonyms {
        params.insert("enable_synonyms".into(), "false".into());
    }
    if !request.enable_curation {
        let key = if curation_sets_api {
            "enable_curations"
        } else {
            "enable_overrides"
        };
        params.insert(key.into(), "false".into());
    }

    if let Some(filter) = request
        .filter_by
        .as_deref()
        .filter(|f| !f.trim().is_empty())
    {
        params.insert("filter_by".into(), filter.to_string());
    }
    if !request.facet_by.is_empty() {
        params.insert("facet_by".into(), request.facet_by.join(","));
    }
    if let Some(sort) = request.sort_by.as_deref().filter(|s| !s.trim().is_empty()) {
        params.insert("sort_by".into(), sort.to_string());
    }
    // Highlight whole fields (not just snippets) for the title-ish fields, so
    // the hit row can mark the full value rather than an ellipsized fragment.
    params.insert(
        "highlight_full_fields".into(),
        active
            .iter()
            .map(|f| f.field.as_str())
            .collect::<Vec<_>>()
            .join(","),
    );

    params
}

/// Percent-encode a query-parameter value. Typesense filter expressions carry
/// `&`, `=`, spaces and `:` freely, so this cannot be skipped.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Build a `?a=b&c=d` query string from ordered params.
pub(super) fn query_string(params: &BTreeMap<String, String>) -> String {
    params
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

#[async_trait]
impl SearchIndexReader for TypesenseConnection {
    async fn health(&self) -> Result<ClusterHealth, AppError> {
        let health = self.http.get_value("/health", None).await?;
        Ok(ClusterHealth {
            ok: health.get("ok").and_then(Value::as_bool).unwrap_or(false),
            version: self.capabilities.version.clone(),
            node_count: self.nodes().await.map(|n| n.len() as u32).unwrap_or(1),
        })
    }

    async fn nodes(&self) -> Result<Vec<NodeInfo>, AppError> {
        // One row per node the connection knows about: the one we dialled, plus
        // any peers named on the connection. Typesense exposes no
        // cluster-membership endpoint, so the peers can only come from config —
        // exactly as its own clients require (see `ConnectionParams::Typesense`).
        //
        // Probed concurrently: a three-node cluster should cost one round trip,
        // not three, and a peer that is down must not delay the healthy ones.
        let mut rows = vec![probe_node(&self.http, &self.host, self.port).await];
        let peers = futures_util::future::join_all(
            self.peers
                .iter()
                .map(|(host, port, http)| probe_node(http, host, *port)),
        )
        .await;
        rows.extend(peers);

        // Leader first, then followers, then anything unreachable — the reading
        // order someone scanning a cluster actually wants.
        rows.sort_by_key(|n| match n.state.as_str() {
            "LEADER" => 0,
            "FOLLOWER" => 1,
            "UNKNOWN" => 2,
            _ => 3,
        });
        Ok(rows)
    }

    async fn cluster_stats(&self) -> Result<ClusterStats, AppError> {
        let nodes = self.nodes().await.unwrap_or_default();
        // A search-only key cannot list collections; the dashboard then shows
        // node health only rather than failing outright.
        let collections = self.collections().await.unwrap_or_default();
        Ok(ClusterStats {
            collections: collections.len() as u32,
            documents: collections.iter().map(|c| c.num_documents).sum(),
            fields: collections.iter().map(|c| c.fields.len() as u32).sum(),
            nodes: nodes.len() as u32,
            healthy: !nodes.is_empty() && nodes.iter().all(|n| n.healthy),
            memory_bytes: nodes.first().and_then(|n| n.memory_bytes),
            memory_total_bytes: nodes.first().and_then(|n| n.memory_total_bytes),
        })
    }

    async fn collections(&self) -> Result<Vec<CollectionDescriptor>, AppError> {
        let wire: Vec<WireCollection> = self
            .http
            .get_json("/collections", Some("the collection list"))
            .await?;
        Ok(wire.into_iter().map(CollectionDescriptor::from).collect())
    }

    async fn collection(&self, name: &str) -> Result<CollectionDescriptor, AppError> {
        let wire: WireCollection = self
            .http
            .get_json(&format!("/collections/{name}"), Some("this collection"))
            .await?;
        Ok(CollectionDescriptor::from(wire))
    }

    async fn aliases(&self) -> Result<Vec<AliasInfo>, AppError> {
        let wire: WireAliases = self.http.get_json("/aliases", Some("aliases")).await?;
        Ok(wire
            .aliases
            .into_iter()
            .map(|a| AliasInfo {
                name: a.name,
                collection_name: a.collection_name,
            })
            .collect())
    }

    async fn api_keys(&self) -> Result<Vec<ApiKeyInfo>, AppError> {
        let wire: WireKeys = self.http.get_json("/keys", Some("API keys")).await?;
        Ok(wire
            .keys
            .into_iter()
            .map(|k| ApiKeyInfo {
                id: k.id,
                description: k.description,
                actions: k.actions,
                collections: k.collections,
                value_prefix: k.value_prefix,
                // Typesense encodes "never expires" as a sentinel far in the
                // future rather than null, so normalize both to None.
                expires_at: k.expires_at.filter(|e| *e > 0 && *e < 32_503_680_000),
            })
            .collect())
    }

    async fn synonyms(&self, collection: &str) -> Result<Vec<SynonymInfo>, AppError> {
        let value = if self.capabilities.curation_sets_api {
            self.http
                .get_value("/synonym_sets", Some("synonyms"))
                .await?
        } else {
            self.http
                .get_value(
                    &format!("/collections/{collection}/synonyms"),
                    Some("synonyms"),
                )
                .await?
        };
        // v30 returns an array of sets each holding `items`; ≤v29 returns
        // `{ synonyms: [...] }`. Accept either.
        let raw = collect_nested(&value, &["synonyms", "items"]);
        Ok(raw
            .into_iter()
            .filter_map(|v| serde_json::from_value::<WireSynonym>(v).ok())
            .map(|s| SynonymInfo {
                id: s.id,
                root: s.root.filter(|r| !r.is_empty()),
                synonyms: s.synonyms,
            })
            .collect())
    }

    async fn curations(&self, collection: &str) -> Result<Vec<CurationInfo>, AppError> {
        let value = if self.capabilities.curation_sets_api {
            self.http
                .get_value("/curation_sets", Some("curation rules"))
                .await?
        } else {
            self.http
                .get_value(
                    &format!("/collections/{collection}/overrides"),
                    Some("curation rules"),
                )
                .await?
        };
        let raw = collect_nested(&value, &["overrides", "items", "curations"]);
        Ok(raw
            .into_iter()
            .filter_map(|v| serde_json::from_value::<WireCuration>(v).ok())
            .map(|c| {
                let rule = c.rule.unwrap_or(WireCurationRule {
                    query: "*".into(),
                    match_kind: "exact".into(),
                });
                CurationInfo {
                    id: c.id,
                    rule_query: if rule.query.is_empty() {
                        "*".into()
                    } else {
                        rule.query
                    },
                    rule_match: if rule.match_kind.is_empty() {
                        "exact".into()
                    } else {
                        rule.match_kind
                    },
                    includes: c
                        .includes
                        .into_iter()
                        .map(|i| CurationPin {
                            id: i.id,
                            position: i.position,
                        })
                        .collect(),
                    excludes: c.excludes.into_iter().map(|e| e.id).collect(),
                }
            })
            .collect())
    }

    async fn analytics(&self) -> Result<AnalyticsOverview, AppError> {
        // Analytics is optional server configuration. `get_optional` turns the
        // "not set up / not permitted" answers into None so this reports
        // `configured: false` instead of failing the dashboard.
        let Some(value) = self.http.get_optional("/analytics/rules").await? else {
            return Ok(AnalyticsOverview::default());
        };
        let rules: Vec<AnalyticsRule> = collect_nested(&value, &["rules"])
            .into_iter()
            .filter_map(|v| {
                let name = v.get("name")?.as_str()?.to_string();
                let ty = v
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("popular_queries")
                    .to_string();
                Some(AnalyticsRule { name, ty })
            })
            .collect();

        // Popular queries live in a destination collection the operator names
        // in the rule; read it when one is configured.
        let mut popular_queries = Vec::new();
        for rule in &rules {
            let Some(destination) = collect_nested(&value, &["rules"])
                .iter()
                .find(|v| v.get("name").and_then(Value::as_str) == Some(rule.name.as_str()))
                .and_then(|v| v.pointer("/params/destination/collection"))
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            let path =
                format!("/collections/{destination}/documents/search?q=*&query_by=q&per_page=10&sort_by=count:desc");
            if let Some(page) = self.http.get_optional(&path).await? {
                for hit in page
                    .get("hits")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                {
                    let Some(document) = hit.get("document") else {
                        continue;
                    };
                    let Some(query) = document.get("q").and_then(Value::as_str) else {
                        continue;
                    };
                    let count = document.get("count").and_then(Value::as_u64).unwrap_or(0);
                    popular_queries.push(PopularQuery {
                        query: query.to_string(),
                        count,
                        no_hits: rule.ty.contains("nohits") || rule.ty.contains("no_hits"),
                    });
                }
            }
        }

        Ok(AnalyticsOverview {
            configured: !rules.is_empty(),
            rules,
            popular_queries,
        })
    }

    async fn search(&self, request: SearchRequest) -> Result<SearchResponse, AppError> {
        let params = search_params(&request, self.capabilities.curation_sets_api);
        let path = format!(
            "/collections/{}/documents/search?{}",
            request.collection,
            query_string(&params)
        );
        let wire: WireSearch = self.http.get_json(&path, Some("this collection")).await?;

        // `drop_tokens_threshold` has no dedicated response field; the count is
        // reported per hit, so read it off the best-ranked one.
        let dropped_tokens = wire
            .hits
            .first()
            .and_then(|h| h.text_match_info.as_ref())
            .and_then(|i| i.get("num_tokens_dropped"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32;

        let found = wire.found;
        let response = SearchResponse {
            found,
            out_of: wire.out_of,
            page: wire.page,
            per_page: request.per_page,
            search_time_ms: wire.search_time_ms,
            hits: wire.hits.into_iter().map(SearchHit::from).collect(),
            facet_counts: wire
                .facet_counts
                .into_iter()
                .map(|f| FacetCount {
                    field_name: f.field_name,
                    counts: f
                        .counts
                        .into_iter()
                        .map(|c| FacetValue {
                            value: c.value,
                            count: c.count,
                        })
                        .collect(),
                })
                .collect(),
            hidden_by_curation: None,
            dropped_tokens,
            request_params: params,
            request_url: self.http.url_for(&format!(
                "/collections/{}/documents/search",
                request.collection
            )),
        };

        if !request.count_hidden || !request.enable_curation {
            return Ok(response);
        }

        // Typesense reports no "hidden by curation" count, so derive it: run the
        // same search with curation off and difference `found`. Opt-in, because
        // it doubles the request.
        let shadow = SearchRequest {
            enable_curation: false,
            count_hidden: false,
            // Facets and paging are irrelevant to a count and cost time.
            facet_by: Vec::new(),
            per_page: 1,
            page: 1,
            ..request.clone()
        };
        let shadow_params = search_params(&shadow, self.capabilities.curation_sets_api);
        let shadow_path = format!(
            "/collections/{}/documents/search?{}",
            shadow.collection,
            query_string(&shadow_params)
        );
        let uncurated: WireSearch = self.http.get_json(&shadow_path, None).await?;

        Ok(SearchResponse {
            hidden_by_curation: Some(uncurated.found.saturating_sub(found)),
            ..response
        })
    }

    async fn documents(
        &self,
        collection: &str,
        page: u32,
        per_page: u32,
    ) -> Result<DocumentPage, AppError> {
        // A match-all search is the paged read; `/documents/export` streams the
        // whole collection with no paging, which the Documents tab must not do.
        let path = format!(
            "/collections/{collection}/documents/search?q=*&query_by=&per_page={per_page}&page={page}"
        );
        let wire: WireSearch = self.http.get_json(&path, Some("this collection")).await?;
        Ok(DocumentPage {
            documents: wire.hits.into_iter().map(|h| h.document).collect(),
            total: wire.found,
            page,
            per_page,
        })
    }

    async fn diagnose(
        &self,
        collection: &str,
        fields: Vec<String>,
        query: &str,
        num_typos: u8,
        relax_min_len: bool,
    ) -> Result<EmptyStateDiagnosis, AppError> {
        let dictionary = self.term_dictionary(collection, &fields).await?;
        Ok(EmptyStateDiagnosis {
            tokens: dictionary.diagnose(query, num_typos, relax_min_len),
            sampled_documents: dictionary.sampled,
            complete: dictionary.complete,
        })
    }

    async fn raw_http(&self, request: HttpConsoleRequest) -> Result<HttpConsoleResponse, AppError> {
        let path = if request.path.starts_with('/') {
            request.path.clone()
        } else {
            format!("/{}", request.path)
        };
        let raw = self.http.raw(&request.method, &path, request.body).await?;
        // The console prints whatever came back — a failed status is a result to
        // display, not an error to raise.
        let body = serde_json::from_str::<Value>(&raw.body)
            .unwrap_or_else(|_| Value::String(raw.body.clone()));
        Ok(HttpConsoleResponse {
            status: raw.status,
            body,
        })
    }
}

impl TypesenseConnection {
    /// The cached term dictionary for a collection + field set, building it on
    /// first use. Cached because the sample is a real network cost and the
    /// empty-state panel re-renders on every keystroke.
    async fn term_dictionary(
        &self,
        collection: &str,
        fields: &[String],
    ) -> Result<TermDictionary, AppError> {
        let key = format!("{collection}\u{0}{}", fields.join(","));
        if let Some(cached) = self.term_cache.read().await.get(&key) {
            return Ok(cached.clone());
        }

        let total = self
            .collection(collection)
            .await
            .map(|c| c.num_documents)
            .unwrap_or(0);
        // `include_fields` keeps the payload to just the searched fields.
        let path = format!(
            "/collections/{collection}/documents/export?include_fields={}",
            fields.join(",")
        );
        let jsonl = self.http.get_text(&path, Some("this collection")).await?;
        let documents: Vec<Value> = jsonl
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(SAMPLE_CAP as usize)
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();

        let dictionary = TermDictionary::build(&documents, fields, total);
        self.term_cache
            .write()
            .await
            .insert(key, dictionary.clone());
        Ok(dictionary)
    }
}

/// Status of one node: raft state, health, memory and CPU.
///
/// Never fails. A node that cannot be reached is reported as unhealthy with an
/// `UNREACHABLE` state rather than failing the whole table — one dead follower
/// must not blank out the cluster view.
async fn probe_node(http: &TypesenseHttp, host: &str, port: u16) -> NodeInfo {
    // `/status` is the better source for raft state: it spells it out
    // (`"LEADER"` / `"FOLLOWER"`) instead of `/debug`'s bare numeric code, and
    // adds the replication position. It is admin-gated, so `/debug` stays the
    // fallback for a search-only key.
    // Five independent GETs, issued together: sequentially this would be five
    // round trips per node, and the dashboard probes every node.
    let (status, debug, health, metrics, stats) = futures_util::future::join5(
        http.get_optional("/status"),
        http.get_optional("/debug"),
        http.get_optional("/health"),
        // System + process MEMORY lives in `/metrics.json`…
        http.get_optional("/metrics.json"),
        // …while per-node request rates and latencies live in `/stats.json`.
        // The two are different payloads; neither contains the other's fields.
        http.get_optional("/stats.json"),
    )
    .await;
    let (status, debug, metrics, stats) = (
        status.ok().flatten(),
        debug.ok().flatten(),
        metrics.ok().flatten(),
        stats.ok().flatten(),
    );
    let healthy = health
        .ok()
        .flatten()
        .and_then(|h| h.get("ok").and_then(Value::as_bool))
        .unwrap_or(false);

    let state = status
        .as_ref()
        .and_then(|s| s.get("state"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            match debug
                .as_ref()
                .and_then(|d| d.get("state"))
                .and_then(Value::as_i64)
            {
                // Typesense's raft state codes: 1 = leader, 4 = follower. Note a
                // STANDALONE node also reports 1 — it is the leader of a
                // one-node raft group — so this cannot distinguish "running
                // alone" from "leading a cluster".
                Some(1) => "LEADER".to_string(),
                Some(4) => "FOLLOWER".to_string(),
                // Reachable but stateless, or unreachable entirely.
                _ if debug.is_some() => "UNKNOWN".to_string(),
                _ => "UNREACHABLE".to_string(),
            }
        });
    let metric = |key: &str| metrics.as_ref().and_then(|m| metric_number(m, key));
    let status_number = |key: &str| {
        status
            .as_ref()
            .and_then(|s| s.get(key))
            .and_then(Value::as_u64)
    };

    NodeInfo {
        host: format!("{host}:{port}"),
        state,
        healthy,
        memory_bytes: metric("typesense_memory_resident_bytes").map(|v| v as u64),
        memory_total_bytes: metric("system_memory_total_bytes").map(|v| v as u64),
        cpu_percent: metric("system_cpu_active_percentage"),
        committed_index: status_number("committed_index"),
        queued_writes: status_number("queued_writes"),
        requests_per_second: stats
            .as_ref()
            .and_then(|s| s.get("total_requests_per_second"))
            .and_then(Value::as_f64),
        search_latency_ms: stats
            .as_ref()
            .and_then(|s| s.get("search_latency_ms"))
            .and_then(Value::as_f64),
    }
}

/// Read one `/metrics.json` value as a number.
///
/// Every value in that payload is a quoted **string** (`"55676928"`,
/// `"80.00"`), so `Value::as_u64` returns `None` for all of them — reading them
/// as numbers is what made the memory card blank. Numbers are accepted too, in
/// case a future version stops quoting them.
fn metric_number(metrics: &Value, key: &str) -> Option<f64> {
    match metrics.get(key)? {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// Pull a list out of a response that may be either a bare array, or an object
/// holding the array under one of `keys`, or a list of objects each holding it
/// (the v30 "sets contain items" shape).
fn collect_nested(value: &Value, keys: &[&str]) -> Vec<Value> {
    match value {
        Value::Array(items) => items
            .iter()
            .flat_map(|item| {
                // A bare array of the objects themselves, or of sets holding them.
                let nested: Vec<Value> = keys
                    .iter()
                    .filter_map(|k| item.get(*k))
                    .filter_map(Value::as_array)
                    .flatten()
                    .cloned()
                    .collect();
                if nested.is_empty() {
                    vec![item.clone()]
                } else {
                    nested
                }
            })
            .collect(),
        Value::Object(_) => keys
            .iter()
            .filter_map(|k| value.get(*k))
            .filter_map(Value::as_array)
            .flatten()
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::search::QueryByField;
    use serde_json::json;

    fn request() -> SearchRequest {
        SearchRequest {
            collection: "products".into(),
            q: "kestrel".into(),
            query_by: vec![
                QueryByField {
                    field: "name".into(),
                    weight: 3,
                },
                QueryByField {
                    field: "description".into(),
                    weight: 1,
                },
            ],
            num_typos: 2,
            prefix: true,
            filter_by: None,
            facet_by: Vec::new(),
            sort_by: None,
            per_page: 12,
            page: 1,
            relax_min_len: true,
            enable_synonyms: true,
            enable_curation: true,
            count_hidden: false,
        }
    }

    #[test]
    fn query_by_and_weights_stay_positionally_aligned() {
        let params = search_params(&request(), true);
        assert_eq!(params["query_by"], "name,description");
        assert_eq!(params["query_by_weights"], "3,1");
    }

    #[test]
    fn relax_min_len_sends_the_one_character_gates() {
        let params = search_params(&request(), true);
        assert_eq!(params["min_len_1typo"], "1");
        assert_eq!(params["min_len_2typo"], "1");
    }

    #[test]
    fn turning_relax_off_sends_no_gates_so_the_server_defaults_apply() {
        let params = search_params(
            &SearchRequest {
                relax_min_len: false,
                ..request()
            },
            true,
        );
        assert!(!params.contains_key("min_len_1typo"));
        assert!(!params.contains_key("min_len_2typo"));
    }

    #[test]
    fn curation_off_uses_the_v30_parameter_name_on_v30_servers() {
        let off = SearchRequest {
            enable_curation: false,
            ..request()
        };
        assert_eq!(search_params(&off, true)["enable_curations"], "false");
        assert_eq!(search_params(&off, false)["enable_overrides"], "false");
    }

    #[test]
    fn an_empty_query_becomes_match_all() {
        let params = search_params(
            &SearchRequest {
                q: "   ".into(),
                ..request()
            },
            true,
        );
        assert_eq!(params["q"], "*");
    }

    #[test]
    fn num_typos_is_clamped_to_the_typesense_maximum() {
        let params = search_params(
            &SearchRequest {
                num_typos: 9,
                ..request()
            },
            true,
        );
        assert_eq!(params["num_typos"], "2");
    }

    #[test]
    fn filter_expressions_are_percent_encoded() {
        let params = search_params(
            &SearchRequest {
                filter_by: Some("brand:=Kestrel && price:>100".into()),
                ..request()
            },
            true,
        );
        let qs = query_string(&params);
        assert!(qs.contains("filter_by=brand%3A%3DKestrel%20%26%26%20price%3A%3E100"));
        // The separator ampersands must survive as separators.
        assert!(qs.contains("&num_typos=2"));
    }

    #[test]
    fn matched_tokens_flatten_from_both_scalar_and_array_shapes() {
        assert_eq!(flatten_matched(&json!(["kestrel"])), vec!["kestrel"]);
        assert_eq!(
            flatten_matched(&json!([["kestrel"], ["pulse"]])),
            vec!["kestrel", "pulse"]
        );
        assert!(flatten_matched(&json!(null)).is_empty());
    }

    #[test]
    fn sixty_four_bit_scores_survive_as_strings_either_way_they_arrive() {
        assert_eq!(
            score_string(&json!("578730123365711872")),
            "578730123365711872"
        );
        assert_eq!(score_string(&json!(1108091339008u64)), "1108091339008");
    }

    #[test]
    fn text_match_info_reads_mixed_string_and_number_members() {
        let info = parse_text_match_info(json!({
            "best_field_score": "1108091339008",
            "score": "578730123365711872",
            "best_field_weight": 15,
            "fields_matched": 1,
            "tokens_matched": "2",
            "num_tokens_dropped": 0,
            "typo_prefix_score": 1
        }))
        .expect("parsed");
        assert_eq!(info.score, "578730123365711872");
        assert_eq!(info.best_field_weight, 15);
        assert_eq!(info.tokens_matched, 2, "a stringified counter still parses");
    }

    #[test]
    fn collections_derive_their_presentation_metadata_on_the_way_in() {
        let wire: WireCollection = serde_json::from_value(json!({
            "name": "products",
            "num_documents": 28,
            "default_sorting_field": "popularity",
            "fields": [
                {"name": "name", "type": "string"},
                {"name": "brand", "type": "string", "facet": true},
                {"name": "description", "type": "string"},
                {"name": "price", "type": "float", "sort": true}
            ]
        }))
        .expect("deserialize");
        let descriptor = CollectionDescriptor::from(wire);
        assert_eq!(descriptor.title_field.as_deref(), Some("name"));
        assert_eq!(descriptor.sub_fields, vec!["brand", "price"]);
        // `index` defaults to true when the server omits it.
        assert!(descriptor.fields.iter().all(|f| f.index));
    }

    #[test]
    fn metrics_values_parse_from_the_strings_typesense_actually_sends() {
        // Every /metrics.json value is quoted; reading them with `as_u64` (which
        // returns None for a string) is what left the memory card blank.
        let metrics = json!({
            "typesense_memory_resident_bytes": "55676928",
            "system_memory_total_bytes": "4109336576",
            "system_cpu_active_percentage": "80.00",
            "already_a_number": 42
        });
        assert_eq!(
            metric_number(&metrics, "typesense_memory_resident_bytes"),
            Some(55_676_928.0)
        );
        assert_eq!(
            metric_number(&metrics, "system_memory_total_bytes"),
            Some(4_109_336_576.0)
        );
        assert_eq!(
            metric_number(&metrics, "system_cpu_active_percentage"),
            Some(80.0)
        );
        assert_eq!(metric_number(&metrics, "already_a_number"), Some(42.0));
        assert_eq!(metric_number(&metrics, "absent"), None);
    }

    #[test]
    fn collect_nested_accepts_bare_arrays_wrapped_objects_and_v30_sets() {
        let bare = json!([{ "id": "a" }]);
        let wrapped = json!({ "synonyms": [{ "id": "a" }] });
        let sets = json!([{ "name": "set1", "items": [{ "id": "a" }] }]);
        for shape in [bare, wrapped, sets] {
            let found = collect_nested(&shape, &["synonyms", "items"]);
            assert_eq!(found.len(), 1);
            assert_eq!(found[0]["id"], "a");
        }
    }
}
