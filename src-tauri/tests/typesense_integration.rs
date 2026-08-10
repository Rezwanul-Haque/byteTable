//! Live Typesense integration tests for the M30 search adapter
//! (`engines::typesense`).
//!
//! Gated behind `BYTETABLE_TEST_TYPESENSE_URL` — the default `cargo test`
//! (and CI without a server) skips them with an `eprintln!` notice. Run
//! against the Docker fixture with:
//!
//! ```sh
//! BYTETABLE_TEST_TYPESENSE_URL='http://localhost:8108' \
//!   BYTETABLE_TEST_TYPESENSE_KEY='bytetable' \
//!   cargo test --test typesense_integration -- --nocapture
//! ```
//!
//! Requires the seed from `test-fixtures/seed/seed-typesense.sh` to have been
//! run (creates `products` / `articles` / `users`, a synonym set, a curation
//! rule with a pin AND a hide, an alias, and a search-only key).
//!
//! To exercise the key-scope degradation, re-run with the search-only key the
//! seed printed:
//!
//! ```sh
//! BYTETABLE_TEST_TYPESENSE_KEY='<search-only key>' \
//!   cargo test --test typesense_integration -- --nocapture
//! ```

use bytetable_lib::engines::typesense::TypesenseConnector;
use bytetable_lib::shared::engine::{ConnectSecret, ConnectionParams, Connector, Engine, Protocol};
use bytetable_lib::shared::search::{QueryByField, SearchConnection, SearchRequest};

/// Parse `http://host:port` (or `https://…`) into connection params.
fn parse_url(url: &str) -> ConnectionParams {
    let (protocol, rest) = if let Some(rest) = url.strip_prefix("https://") {
        (Protocol::Https, rest)
    } else {
        (Protocol::Http, url.strip_prefix("http://").unwrap_or(url))
    };
    let rest = rest.trim_end_matches('/');
    let (host, port) = rest
        .split_once(':')
        .map(|(h, p)| (h.to_string(), p.parse().unwrap_or(8108)))
        .unwrap_or((rest.to_string(), 8108));

    ConnectionParams::Typesense {
        protocol,
        host,
        port,
        default_collection: Some("products".to_string()),
        // Peers cannot be discovered (Typesense has no membership endpoint), so
        // the node table only shows what the connection is told about. Set
        // `BYTETABLE_TEST_TYPESENSE_NODES` to exercise the multi-node path
        // against the 3-node fixture cluster.
        nodes: std::env::var("BYTETABLE_TEST_TYPESENSE_NODES")
            .ok()
            .filter(|n| !n.is_empty()),
        ssh: None,
    }
}

/// Poll `num_documents` until it reaches `want`, or give up after ~2s.
///
/// A single node updates the collection's document count synchronously, but in
/// a **raft cluster** the write is committed through the log first, so the count
/// trails the write by a beat. Asserting on it immediately is a race that only
/// appears against a real cluster.
async fn wait_for_count(conn: &std::sync::Arc<dyn SearchConnection>, want: u64) -> u64 {
    let mut seen = 0;
    for _ in 0..20 {
        seen = conn
            .collection("products")
            .await
            .expect("collection")
            .num_documents;
        if seen == want {
            return seen;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    seen
}

/// How many nodes the connection was told about (1 when no peers are set).
fn expected_node_count() -> usize {
    match std::env::var("BYTETABLE_TEST_TYPESENSE_NODES") {
        Ok(n) if !n.is_empty() => n.split(',').filter(|s| !s.trim().is_empty()).count() + 1,
        _ => 1,
    }
}

/// The gate: `Some((params, secret))` when the env var is set, else `None`
/// after a skip notice.
fn gate() -> Option<(ConnectionParams, ConnectSecret)> {
    match std::env::var("BYTETABLE_TEST_TYPESENSE_URL") {
        Ok(url) if !url.is_empty() => {
            let key = std::env::var("BYTETABLE_TEST_TYPESENSE_KEY")
                .unwrap_or_else(|_| "bytetable".to_string());
            Some((parse_url(&url), ConnectSecret::new(key)))
        }
        _ => {
            eprintln!("SKIP: BYTETABLE_TEST_TYPESENSE_URL not set (live Typesense required)");
            None
        }
    }
}

async fn open(
    params: &ConnectionParams,
    secret: &ConnectSecret,
) -> std::sync::Arc<dyn SearchConnection> {
    TypesenseConnector
        .open_with_secret(params, Some(secret))
        .await
        .expect("open typesense connection")
        .into_search()
        .expect("search connection")
}

fn query_by(fields: &[(&str, u32)]) -> Vec<QueryByField> {
    fields
        .iter()
        .map(|(f, w)| QueryByField {
            field: (*f).to_string(),
            weight: *w,
        })
        .collect()
}

fn request(q: &str) -> SearchRequest {
    SearchRequest {
        collection: "products".into(),
        q: q.to_string(),
        query_by: query_by(&[("name", 4), ("brand", 3), ("description", 1)]),
        num_typos: 2,
        prefix: true,
        filter_by: None,
        facet_by: vec!["brand".into(), "categories".into()],
        sort_by: None,
        per_page: 12,
        page: 1,
        relax_min_len: true,
        enable_synonyms: true,
        enable_curation: true,
        count_hidden: false,
    }
}

/// The connect-time probe: version + key scope.
#[tokio::test]
async fn typesense_open_reports_version_and_key_scope() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;

    let info = conn.engine_info();
    assert_eq!(info.engine, Engine::Typesense);
    assert!(!info.server_version.is_empty());

    let caps = conn.capabilities();
    assert_eq!(caps.default_collection.as_deref(), Some("products"));
    // The v30 dialect switch must agree with the probed major version.
    assert_eq!(caps.curation_sets_api, caps.major_version >= 30);

    conn.close().await.expect("close");
}

/// Cluster + schema metadata. Admin-only reads are skipped (not failed) when the
/// key is search-only — that is the documented degradation, not a bug.
#[tokio::test]
async fn typesense_reads_cluster_and_schema() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;

    let health = conn.health().await.expect("health");
    assert!(health.ok, "the fixture node should be healthy");

    let nodes = conn.nodes().await.expect("nodes");
    assert_eq!(
        nodes.len(),
        expected_node_count(),
        "the node table shows the dialled node plus every configured peer — \
         Typesense cannot enumerate peers itself"
    );
    // Leader first, so a cluster reads in a sensible order.
    if nodes.len() > 1 {
        assert_eq!(
            nodes[0].state,
            "LEADER",
            "a real cluster must sort its leader to the top, got {:?}",
            nodes.iter().map(|n| &n.state).collect::<Vec<_>>()
        );
        assert!(
            nodes.iter().filter(|n| n.state == "FOLLOWER").count() >= 1,
            "a multi-node raft cluster should report followers"
        );
        assert!(
            nodes.iter().all(|n| n.healthy),
            "every fixture node should be healthy"
        );
        // `committed_index` is the only genuine cross-node signal Typesense
        // exposes: a converged cluster reports the same log position everywhere.
        let indexes: Vec<_> = nodes.iter().filter_map(|n| n.committed_index).collect();
        assert_eq!(
            indexes.len(),
            nodes.len(),
            "every node should report a committed_index from /status"
        );
        assert!(
            nodes.iter().all(|n| n.queued_writes == Some(0)),
            "an idle fixture cluster should have no queued writes"
        );
    }
    let node = &nodes[0];
    // Memory + CPU come from /metrics.json, whose values are quoted STRINGS.
    // Reading them as JSON numbers (or from /stats.json, which carries no memory
    // at all) is what left the dashboard's memory card blank.
    assert!(
        node.memory_bytes.is_some_and(|m| m > 0),
        "the memory card needs typesense_memory_resident_bytes, got {:?}",
        node.memory_bytes
    );
    assert!(
        node.memory_total_bytes.is_some_and(|m| m > 0),
        "the 'used / total' reading needs system_memory_total_bytes"
    );
    assert!(
        node.cpu_percent.is_some(),
        "system_cpu_active_percentage should parse"
    );
    // The per-PROCESS workload signal, from /stats.json. Typesense publishes no
    // per-process CPU (there is no `typesense_cpu_*` to pair with its
    // `typesense_memory_*` series, in v29 or v30), so this is what the node
    // table shows to answer "how hard is this node working".
    assert!(
        node.requests_per_second.is_some(),
        "total_requests_per_second should come from /stats.json"
    );
    // `cpu_percent` is the HOST's CPU, not Typesense's — there is no
    // `typesense_cpu_*` metric to pair with the `typesense_memory_*` series.
    // Co-located nodes therefore report the same machine's load, which is why
    // the column is labelled "Host CPU" rather than "CPU".
    if nodes.len() > 1 {
        let cpus: Vec<f64> = nodes.iter().filter_map(|n| n.cpu_percent).collect();
        let spread = cpus.iter().cloned().fold(f64::MIN, f64::max)
            - cpus.iter().cloned().fold(f64::MAX, f64::min);
        assert!(
            spread < 50.0,
            "nodes on one machine should report a similar HOST cpu; a wide spread \
             would mean this is per-process after all, got {cpus:?}"
        );
    }

    // Reachable with either key scope: a per-collection read.
    let products = conn.collection("products").await.expect("collection");
    assert_eq!(products.name, "products");
    assert!(products.num_documents >= 28, "the seed imports 28 products");
    // Presentation metadata is DERIVED from the schema, not sent by the server.
    assert_eq!(products.title_field.as_deref(), Some("name"));
    assert!(
        !products.sub_fields.is_empty(),
        "facetable/sortable scalars should populate the hit meta line"
    );
    assert!(
        products.memory_bytes.is_none(),
        "Typesense reports memory per process, never per collection"
    );

    if !conn.capabilities().admin_key {
        eprintln!("SKIP the admin-only assertions: connected with a search-only key");
        return;
    }

    let collections = conn.collections().await.expect("collections");
    for expected in ["products", "articles", "users"] {
        assert!(
            collections.iter().any(|c| c.name == expected),
            "collections should include {expected}"
        );
    }

    let aliases = conn.aliases().await.expect("aliases");
    assert!(
        aliases.iter().any(|a| a.name == "catalog"),
        "the seed creates a `catalog` alias"
    );

    let keys = conn.api_keys().await.expect("api_keys");
    assert!(!keys.is_empty());
    for key in &keys {
        // The full key is unretrievable by design; only a prefix ever arrives.
        assert!(!key.value_prefix.is_empty() || key.description.is_empty());
    }

    conn.close().await.expect("close");
}

/// Analytics: rules configured + real recorded traffic.
///
/// The dashboard panel reads genuine analytics, which only exist when the server
/// runs with `--enable-search-analytics` AND a rule points a source collection
/// at a destination collection. The fixture sets both up and sends traffic, so
/// `configured` must be true and popular/no-hit rows must have landed.
#[tokio::test]
async fn typesense_reports_configured_analytics() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;
    if !conn.capabilities().admin_key {
        eprintln!("SKIP: analytics rules need an admin key");
        return;
    }

    let analytics = conn.analytics().await.expect("analytics");
    assert!(
        analytics.configured,
        "the fixture creates popular_queries + nohits_queries rules"
    );
    assert!(
        analytics.rules.iter().any(|r| r.ty.contains("popular")),
        "a popular_queries rule should be configured, got {:?}",
        analytics.rules
    );
    assert!(
        analytics.rules.iter().any(|r| r.ty.contains("nohits")),
        "a nohits_queries rule should be configured"
    );
    assert!(
        !analytics.popular_queries.is_empty(),
        "the seed sends traffic and waits for a flush, so rows should exist"
    );
    // The no-hit rule's rows are the ones tinted danger in the panel.
    assert!(
        analytics.popular_queries.iter().any(|q| q.no_hits),
        "`usb hub` / `webcam` match nothing and should record as no-hit queries"
    );

    conn.close().await.expect("close");
}

/// A search must return the SERVER's own numbers, plus the highlights the
/// relevance x-ray is derived from.
#[tokio::test]
async fn typesense_search_returns_server_numbers_and_highlights() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;

    let response = conn.search(request("keyboard")).await.expect("search");
    assert!(
        response.found > 0,
        "`keyboard` should match seeded products"
    );
    assert!(response.out_of >= 28);
    assert_eq!(response.page, 1);
    assert!(
        !response.request_params.is_empty(),
        "the request panel needs the parameters actually sent"
    );
    assert!(
        !response.request_url.contains("api-key") && !response.request_url.contains("bytetable"),
        "the displayed URL must never carry the API key: {}",
        response.request_url
    );

    let hit = response.hits.first().expect("at least one hit");
    assert!(
        !hit.highlights.is_empty(),
        "highlights are what the x-ray's per-token rows are built from"
    );
    assert!(
        hit.highlights.iter().any(|h| !h.matched_tokens.is_empty()),
        "at least one highlight must name the tokens it matched"
    );

    // A CURATED hit is injected by a pin rather than ranked, so Typesense omits
    // `text_match` for it entirely — which is exactly why the relevance bar
    // takes its baseline from the best *ranked* hit instead of `hits[0]`.
    let ranked = response
        .hits
        .iter()
        .find(|h| !h.curated)
        .expect("at least one ranked (non-pinned) hit");
    assert!(
        !ranked.text_match.is_empty(),
        "a ranked hit carries the text_match that drives the relevance bar"
    );
    assert!(
        ranked.text_match_info.is_some(),
        "a ranked hit carries text_match_info — the x-ray's authoritative head"
    );
    assert!(
        response
            .hits
            .iter()
            .all(|h| !h.curated || h.text_match.is_empty()),
        "a pinned hit must NOT be given a fabricated score"
    );

    // Faceting drives the rail.
    assert!(
        response
            .facet_counts
            .iter()
            .any(|f| f.field_name == "brand"),
        "facet_by=brand should come back with counts"
    );

    conn.close().await.expect("close");
}

/// Typo tolerance and the min_len gate — the milestone's headline behaviours.
#[tokio::test]
async fn typesense_typo_tolerance_matches_the_min_len_rules() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;

    // A misspelling with the typo budget on finds results…
    let fuzzy = conn.search(request("keybord")).await.expect("search");
    assert!(
        fuzzy.found > 0,
        "`keybord` should reach `keyboard` with typos on"
    );

    // …and finds nothing with num_typos=0.
    let exact = conn
        .search(SearchRequest {
            num_typos: 0,
            ..request("keybord")
        })
        .await
        .expect("search");
    assert_eq!(exact.found, 0, "num_typos=0 must not correct a misspelling");

    // `Kstrl` → `Kestrel` is 2 edits on a 5-character token, so it only works
    // with the min_len gate relaxed — the milestone's acceptance case.
    let relaxed = conn
        .search(SearchRequest {
            query_by: query_by(&[("brand", 4), ("name", 3)]),
            relax_min_len: true,
            ..request("Kstrl")
        })
        .await
        .expect("search");
    let gated = conn
        .search(SearchRequest {
            query_by: query_by(&[("brand", 4), ("name", 3)]),
            relax_min_len: false,
            ..request("Kstrl")
        })
        .await
        .expect("search");
    assert!(
        relaxed.found > 0,
        "relax min_len should let a 5-char token spend 2 typos and reach `Kestrel`"
    );
    assert_eq!(
        gated.found, 0,
        "without relax min_len, a 5-char token only gets 1 typo, so 2 edits cannot match"
    );

    conn.close().await.expect("close");
}

/// The empty-state diagnosis: nearest indexed terms from the sampled dictionary.
#[tokio::test]
async fn typesense_diagnoses_an_empty_result() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;

    let diagnosis = conn
        .diagnose(
            "products",
            vec!["brand".to_string(), "name".to_string()],
            "Kstrl",
            2,
            false,
        )
        .await
        .expect("diagnose");

    let token = diagnosis.tokens.first().expect("one token");
    assert_eq!(token.token, "kstrl");
    assert_eq!(token.length, 5);
    // Gated: 5 characters earns only 1 typo.
    assert_eq!(token.allowed_typos, 1);
    assert!(
        token
            .nearest
            .iter()
            .any(|n| n.term == "kestrel" && n.distance == 2),
        "the panel must name `kestrel` at 2 edits, got: {:?}",
        token.nearest
    );
    assert!(
        token.blocked_by_min_len,
        "a 2-edit term inside num_typos=2 but outside the gated budget is exactly the \
         `relax min_len` case"
    );

    conn.close().await.expect("close");
}

/// Curation: the pin surfaces as `curated`, and the hide is countable only by
/// differencing a curation-off search (Typesense reports no such number).
#[tokio::test]
async fn typesense_curation_pins_and_hides() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;
    if !conn.capabilities().admin_key {
        eprintln!("SKIP: curation rules need an admin key");
        return;
    }

    let curations = conn.curations("products").await.expect("curations");
    let rule = curations
        .iter()
        .find(|c| c.id == "promote-kestrel")
        .expect("the seed creates `promote-kestrel`");
    assert_eq!(rule.rule_query, "keyboard");
    assert_eq!(rule.includes.len(), 1);
    assert_eq!(rule.excludes.len(), 1);

    let synonyms = conn.synonyms("products").await.expect("synonyms");
    assert!(
        synonyms
            .iter()
            .any(|s| s.synonyms.iter().any(|w| w == "keeb")),
        "the seed creates a `keyboard/keeb/kbd` synonym set"
    );

    // With `count_hidden`, the adapter runs the second curation-off search and
    // reports the difference.
    let counted = conn
        .search(SearchRequest {
            count_hidden: true,
            ..request("keyboard")
        })
        .await
        .expect("search");
    assert_eq!(
        counted.hidden_by_curation,
        Some(1),
        "the rule hides exactly one matching document"
    );

    // Without it, the field stays absent — the UI must show no chip rather than
    // a zero it did not measure.
    let uncounted = conn.search(request("keyboard")).await.expect("search");
    assert_eq!(uncounted.hidden_by_curation, None);

    conn.close().await.expect("close");
}

/// Document write round-trip: upsert then delete, with the counts moving.
#[tokio::test]
async fn typesense_upsert_and_delete_round_trip() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;
    if !conn.capabilities().admin_key {
        eprintln!("SKIP: document writes need an admin key");
        return;
    }

    let before = conn
        .collection("products")
        .await
        .expect("collection")
        .num_documents;

    // Every token here is deliberately unlike the queries the other tests run
    // (`keyboard`, `keybord`, `Kstrl`) and far outside a 2-typo radius of them.
    // `cargo test` runs these concurrently, so a document that matched would
    // shift `found` underneath the curation test's hidden-count assertion.
    let doc = serde_json::json!({
        "id": "zz_isolated_fixture",
        "name": "Zeta Isolated Fixture",
        "brand": "Zetafixture",
        "categories": ["fixtures"],
        "description": "Temporary document written by the M30 integration test.",
        "price": 1.0,
        "rating": 5.0,
        "popularity": 1,
        "in_stock": true,
        "created_at": 1_750_000_000i64
    });
    conn.upsert_document("products", doc).await.expect("upsert");

    let after = wait_for_count(&conn, before + 1).await;
    assert_eq!(after, before + 1, "num_documents should reflect the upsert");

    conn.delete_document("products", "zz_isolated_fixture")
        .await
        .expect("delete");

    let restored = wait_for_count(&conn, before).await;
    assert_eq!(restored, before, "the delete should restore the count");

    conn.close().await.expect("close");
}

/// A document with no `id` is rejected locally, before any request — an upsert
/// without one would silently duplicate rather than replace.
#[tokio::test]
async fn typesense_rejects_an_upsert_without_an_id() {
    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;

    let err = conn
        .upsert_document("products", serde_json::json!({ "name": "no id" }))
        .await
        .expect_err("an id-less document must be rejected");
    assert!(
        err.to_string().contains("id"),
        "the error should name `id`: {err}"
    );

    conn.close().await.expect("close");
}

/// The HTTP console passthrough reports the status verbatim rather than raising.
#[tokio::test]
async fn typesense_raw_http_passes_status_through() {
    use bytetable_lib::shared::search::HttpConsoleRequest;

    let Some((params, secret)) = gate() else {
        return;
    };
    let conn = open(&params, &secret).await;

    let ok = conn
        .raw_http(HttpConsoleRequest {
            method: "GET".into(),
            path: "/health".into(),
            body: None,
        })
        .await
        .expect("raw_http");
    assert_eq!(ok.status, 200);

    // A 404 is a RESULT to print, not an error to raise — the console shows the
    // status line and the server's body.
    let missing = conn
        .raw_http(HttpConsoleRequest {
            method: "GET".into(),
            path: "/collections/definitely_not_here".into(),
            body: None,
        })
        .await
        .expect("raw_http should not raise on a 404");
    assert_eq!(missing.status, 404);

    conn.close().await.expect("close");
}
