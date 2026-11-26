# ADR-0045 — Typesense engine: search port family over HTTP, relevance playground, minimal writes

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-08-11 (first commit that shipped the feature)
- **Area:** Engines
- **Related:** ADR-0003, ADR-0004, ADR-0006, ADR-0008, ADR-0046, ADR-0051

## Context

Typesense is an HTTP search API, not a table store: collections instead of databases, JSON
documents, and every read is a search call with `q`, `query_by`, `filter_by`, facets and typo
tolerance. There is no SQL, transaction or cursor. API keys are scoped — a search-only key gets
401 on `GET /collections`, `/keys` and curation endpoints, and cannot even discover which
collections it may read. Typesense v30 moved synonyms and curation from per-collection routes to
top-level resources. The useful questions for a user are "why did this rank here?" and "why did
this find nothing?", which the API does not answer directly. There is no Typesense-specific
documentation file under `docs/`.

## Decision

- **Own port family, named for the capability.** `src-tauri/src/shared/ports/search.rs` defines
  `SearchIndexReader` (cluster/schema metadata, search, empty-state diagnosis, raw HTTP) and a
  small `SearchIndexWriter`, bundled as `SearchConnection`, carried by `OpenConnection::Search`
  (wire token `"typesense"`). The Rust slice is `src-tauri/src/features/search/`, not
  `typesense/`; its module doc says a second search engine would implement the same ports and
  reuse the slice.
- **Transport: `reqwest`, no Typesense crate.** `src-tauri/src/engines/typesense/mod.rs` records
  that it reuses the same pure-Rust HTTP client the ClickHouse adapter uses (ADR-0046), so no new
  dependency entered the tree. `http.rs` wraps the client and attaches the API key as
  `X-TYPESENSE-API-KEY` on each request.
- **The API key stays in `http.rs`.** It comes from the keychain (ADR-0004), is never returned,
  logged, put on a DTO or echoed in an error; URLs shown to the renderer are built key-free
  (`url_for`).
- **Protocol instead of TLS mode.** Typesense has no TLS negotiation, so the connection has only an
  `http`/`https` scheme; `https` always verifies the chain. A self-signed node is meant to be
  reached over an SSH tunnel on `http` (ADR-0008), which the adapter supports.
- **Key scope probed once at connect** (`probe_capabilities`: `GET /debug` for the version,
  `GET /collections` for admin vs search-only). The verdict travels as `ServerCapabilities`, so
  views show an "admin key required" state instead of failing per panel. `error.rs` maps
  401/403 to `AppError::Unsupported` for that branch, 404 to `NotFound`, the rest to `Database`
  with the server's message. With a search-only key, the connection's `defaultCollection` is the
  only collection the workspace can show.
- **Two API dialects** chosen by the probed major version (`reader.rs`): ≤ v29 uses
  `/collections/{c}/synonyms`, `/collections/{c}/overrides`, `enable_overrides`; v30+ uses
  `/synonym_sets`, `/curation_sets`, `enable_curations`. The port exposes version-neutral shapes.
- **Numbers come from the server.** `found`, `out_of`, `search_time_ms`, `facet_counts`,
  `text_match` are passed through. "Hidden by curation" has no response field, so it is derived by
  an opt-in second search with curation off (`SearchRequest::count_hidden`). The per-token
  relevance x-ray in `src/features/browse/typesense/search.ts` is derived from
  `highlights[].matchedTokens`; only its contribution bar is labelled "estimated".
- **Empty-state diagnosis with a local term dictionary** (`terms.rs`). Probe searches cannot
  measure edit distance beyond `num_typos` 2, so nearest-term suggestions use a dictionary built
  from a sample of up to 2,000 documents (`SAMPLE_CAP`), cached in an `RwLock`. The UI says when
  the sample did not cover the whole collection.
- **Peers are configured, not discovered.** Typesense has no cluster-membership endpoint, so the
  optional `nodes` field (in `src-tauri/src/shared/ports/sql/params.rs`) lists peers for the
  dashboard's node table. It is observational only; all reads and writes go to the dialled node.
- **Writes are only document upsert and delete** (`writer.rs`). Schema changes, truncate/drop,
  delete-by-filter and reindex are deferred; nothing in the adapter can
  destroy a collection.
- **Tauri commands** (`src-tauri/src/features/search/commands.rs`, prefixed with the engine name):
  `typesense_capabilities`, `typesense_health`, `typesense_nodes`, `typesense_cluster_stats`,
  `typesense_collections`, `typesense_collection`, `typesense_aliases`, `typesense_api_keys`,
  `typesense_synonyms`, `typesense_curations`, `typesense_analytics`, `typesense_search`,
  `typesense_documents`, `typesense_diagnose`, `typesense_upsert_document`,
  `typesense_delete_document`, `typesense_raw_http`.
- **Read-only workspaces** (ADR-0006): upsert/delete call `ensure_writable`; the HTTP console
  (`typesense_raw_http`) allows only `GET`/`HEAD`/`OPTIONS` (`http_method_is_read_only` in
  `src-tauri/src/shared/readonly.rs`).
- **Renderer slice** `src/features/browse/typesense/`: `TypesenseWorkspace.tsx`, sidebar,
  `TypesenseDashboard.tsx`, `TsSearchTab.tsx` (query bar, request panel, filter chips, facet
  rail, x-ray, `curl` builder), `TsDocsTab.tsx`, `TsSchemaTab.tsx`, `TsCurationTab.tsx`,
  `TsKeysTab.tsx`, and the HTTP console in the bottom panel
  (`src/features/console/components/TypesenseHttpSession.tsx`, helpers in `httpConsole.ts`).

## Alternatives considered

- **Fit Typesense into the SQL or a NoSQL port.** Rejected; recorded in the `search.rs` module doc.
- **A Typesense Rust client crate.** Not used; the recorded reason is avoiding a new dependency when
  `reqwest` was already in the tree.
- **Infer nearest terms from probe searches.** Rejected in `terms.rs`: `num_typos` caps at 2.
- **Discover cluster peers automatically.** Not possible; there is no endpoint (`params.rs` comment).
- **Schema/collection lifecycle writes.** Deferred because they need confirmation
  flows and multi-step reindex jobs with a manual alias swap.

## Consequences

- **Positive:** search-only keys get a usable, explained workspace; both v29 and v30 servers work;
  displayed numbers are the server's; the key never reaches the renderer.
- **Negative / trade-offs:** no schema editing, collection truncate/drop, delete-by-filter or
  reindex in the UI (the raw HTTP console can still send them in a writable workspace). Nearest-term
  diagnosis is best-effort on large collections. Peers must be typed in by hand. A second curation-off
  search doubles request cost when hidden counts are wanted.
- **Testing:** `src-tauri/tests/typesense_integration.rs`, gated on `BYTETABLE_TEST_TYPESENSE_URL`,
  `BYTETABLE_TEST_TYPESENSE_KEY` and `BYTETABLE_TEST_TYPESENSE_NODES`, against a three-node
  `typesense/typesense:29.0` cluster on ports 8108/8118/8128 in `test-fixtures/docker-compose.yml`,
  seeded by `test-fixtures/seed/seed-typesense.sh`.
- **Follow-ups:** deferred index lifecycle work — field drop via `PATCH`, collection danger
  zone, delete-by-filter with a dry-run count, and a guided reindex.
