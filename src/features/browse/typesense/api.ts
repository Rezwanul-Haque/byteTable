// Typed invoke() wrappers for the Typesense slice's Tauri commands, plus the TS
// mirrors of the Rust wire types in `src-tauri/src/shared/ports/search.rs`.
// Field names are camelCase per the serde attributes on the Rust side.
// Cross-feature consumption of this slice's api.ts is sanctioned; reaching into
// its components is not.
//
// Two things to know before using these:
//
// 1. **Admin-only reads throw `Unsupported`, not `Database`.** A search-only key
//    cannot call `collections` / `apiKeys` / `synonyms` / `curations`. Check
//    `capabilities().adminKey` up front and render the documented empty state
//    rather than catching per call.
// 2. **64-bit scores are strings.** `textMatch` and the two `textMatchInfo`
//    score members exceed JS's safe integer range, so they stay strings all the
//    way through. Never `Number()` them for anything but a display ratio.

import { invoke } from "@tauri-apps/api/core";

// -- Cluster + capabilities -------------------------------------------------

/**
 * What the connect-time probe learned. `adminKey` is the important one: with a
 * search-only key the client cannot even *list* collections (a scoped key's
 * allowed collections are baked into the key, and Typesense exposes no
 * self-introspection endpoint), so `defaultCollection` becomes the only
 * collection name the workspace can show.
 */
export interface ServerCapabilities {
  version: string;
  majorVersion: number;
  adminKey: boolean;
  defaultCollection?: string;
  /** True on v30+, where synonyms/curation are top-level resources. */
  curationSetsApi: boolean;
}

export interface ClusterHealth {
  ok: boolean;
  version: string;
  nodeCount: number;
}

/**
 * The node this connection is talking to.
 *
 * Always exactly one: Typesense has no cluster-membership endpoint (peers are
 * configured out of band), so a multi-node cluster still renders one row. There
 * is also no uptime anywhere in the API — `GET /debug` returns only
 * `{state, version}` — which is why there is no field for it.
 */
export interface NodeInfo {
  host: string;
  /** `LEADER` / `FOLLOWER`, or `SINGLE` for a lone node. */
  state: string;
  healthy: boolean;
  /** Typesense's own resident memory, from `/metrics.json`. */
  memoryBytes?: number;
  /** Total memory visible to the node, for the "used / total" reading. */
  memoryTotalBytes?: number;
  /**
   * **Host-wide** CPU percentage — the whole machine's, not Typesense's.
   * Typesense exposes no per-process CPU metric, so nodes sharing a machine all
   * report the same value and a busy neighbour pushes it to 100% while
   * Typesense itself is idle. Label it as host CPU wherever it is shown.
   */
  cpuPercent?: number;
  /**
   * Raft log position (`GET /status`). The one genuine cross-node signal
   * Typesense exposes: every node in a healthy cluster reports the same index,
   * so one that trails is lagging replication. Admin-only.
   */
  committedIndex?: number;
  /** Writes queued but not yet applied — non-zero means the node is behind. */
  queuedWrites?: number;
  /**
   * Requests per second served by THIS node (`/stats.json`). The per-process
   * workload signal — unlike {@link cpuPercent}, which is the whole machine's,
   * this describes what this Typesense is actually doing.
   */
  requestsPerSecond?: number;
  /** Mean search latency in ms on this node. */
  searchLatencyMs?: number;
}

export interface ClusterStats {
  collections: number;
  documents: number;
  fields: number;
  nodes: number;
  healthy: boolean;
  memoryBytes?: number;
  memoryTotalBytes?: number;
}

// -- Schema -----------------------------------------------------------------

export interface FieldInfo {
  name: string;
  /** `string`, `string[]`, `int32`, `int64`, `float`, `bool`, `geopoint`, … */
  type: string;
  facet: boolean;
  optional: boolean;
  index: boolean;
  sort: boolean;
}

/**
 * A collection's schema plus derived presentation metadata. `titleField` and
 * `subFields` are NOT server concepts — the backend derives them from the schema
 * (title = first non-snippet text field; subFields = up to three facetable or
 * sortable scalars), replacing the prototype's hand-authored mapping.
 */
export interface CollectionDescriptor {
  name: string;
  numDocuments: number;
  fields: FieldInfo[];
  defaultSortingField?: string;
  /**
   * Always absent against a real server: Typesense reports memory per PROCESS,
   * never per collection, and `GET /collections/{name}` carries no size field of
   * any kind. Kept optional so a future API that adds one needs no wire change.
   */
  memoryBytes?: number;
  titleField?: string;
  subFields: string[];
}

export interface AliasInfo {
  name: string;
  collectionName: string;
}

/** API key metadata. There is no field for a full key: Typesense never returns
 *  one after creation, so none can be displayed or stored. */
export interface ApiKeyInfo {
  id: number;
  description: string;
  actions: string[];
  collections: string[];
  valuePrefix: string;
  /** Unix seconds, or absent for a key that never expires. */
  expiresAt?: number;
}

/** One-way when `root` is set (`root` → `synonyms`), else multi-way. */
export interface SynonymInfo {
  id: string;
  root?: string;
  synonyms: string[];
}

export interface CurationPin {
  id: string;
  position: number;
}

/** A curation rule (pre-v30 "override", v30+ "curation"). */
export interface CurationInfo {
  id: string;
  ruleQuery: string;
  /** `exact` or `contains`. */
  ruleMatch: string;
  includes: CurationPin[];
  excludes: string[];
}

export interface AnalyticsRule {
  name: string;
  type: string;
}

export interface PopularQuery {
  query: string;
  count: number;
  noHits: boolean;
}

/**
 * Analytics is optional server configuration — rules must be created and
 * popular queries land in a destination collection the operator sets up. On a
 * default install `configured` is false, which is NOT an error: the panel shows
 * an explicit "analytics not configured" state.
 */
export interface AnalyticsOverview {
  configured: boolean;
  rules: AnalyticsRule[];
  popularQueries: PopularQuery[];
}

// -- Search -----------------------------------------------------------------

export interface QueryByField {
  field: string;
  /** 1–5 in the UI (Typesense accepts 0–127). */
  weight: number;
}

export interface SearchRequest {
  collection: string;
  q: string;
  queryBy: QueryByField[];
  /** 0, 1 or 2 — Typesense caps typo tolerance at 2. */
  numTypos: number;
  prefix: boolean;
  filterBy?: string;
  facetBy: string[];
  /** Absent = relevance (`_text_match:desc`). */
  sortBy?: string;
  perPage: number;
  page: number;
  /**
   * Sends `min_len_1typo=1&min_len_2typo=1` so short tokens get the full typo
   * budget — this is why `Kstrl` finds `Kestrel`. ON by default. Off, the
   * server's own gating applies (1 typo needs ≥4 chars, 2 need ≥7).
   */
  relaxMinLen: boolean;
  enableSynonyms: boolean;
  /** Maps to `enable_curations` (v30+) / `enable_overrides` (pre-v30). */
  enableCuration: boolean;
  /**
   * Ask the backend to derive `hiddenByCuration` by re-running the search with
   * curation off and differencing `found`. Typesense reports no such count, so
   * this costs a second request — only set it when the collection actually has
   * curation rules that could apply.
   */
  countHidden: boolean;
}

/**
 * Typesense's per-hit ranking breakdown. Note what it is *not*: aggregate per
 * hit, with **no per-token detail**. The relevance x-ray's per-token rows are
 * derived in the renderer from `highlights[].matchedTokens`; these numbers are
 * the authoritative head above them.
 */
export interface TextMatchInfo {
  /** 64-bit, kept as a string — see the module note. */
  bestFieldScore: string;
  score: string;
  bestFieldWeight: number;
  fieldsMatched: number;
  tokensMatched: number;
  numTokensDropped: number;
  typoPrefixScore: number;
}

export interface Highlight {
  field: string;
  /** `<mark>`-wrapped snippet (first element for an array field). */
  snippet?: string;
  /** Every query token that matched in this field, flattened across elements. */
  matchedTokens: string[];
}

export interface SearchHit {
  document: Record<string, unknown>;
  /** Raw `text_match` ranking score — 64-bit, kept as a string. */
  textMatch: string;
  textMatchInfo?: TextMatchInfo;
  highlights: Highlight[];
  /** True when a curation rule pinned this document into place. */
  curated: boolean;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetCount {
  fieldName: string;
  counts: FacetValue[];
}

export interface SearchResponse {
  found: number;
  outOf: number;
  page: number;
  perPage: number;
  searchTimeMs: number;
  hits: SearchHit[];
  facetCounts: FacetCount[];
  /** Absent = not computed (no `countHidden`, or no curation rules) — show no
   *  chip rather than a zero. */
  hiddenByCuration?: number;
  /** Tokens the server dropped to find results (`drop_tokens_threshold`). */
  droppedTokens: number;
  /** The exact parameters sent — drives the request panel and `curl`. */
  requestParams: Record<string, string>;
  /** The URL the search went to. Carries no API key. */
  requestUrl: string;
}

export interface DocumentPage {
  documents: Record<string, unknown>[];
  total: number;
  page: number;
  perPage: number;
}

// -- Empty-state diagnosis --------------------------------------------------

export interface NearTerm {
  term: string;
  field: string;
  distance: number;
}

export interface TokenDiagnosis {
  token: string;
  length: number;
  allowedTypos: number;
  /** Up to three nearest indexed terms within 4 edits, closest first. */
  nearest: NearTerm[];
  /** True when a term was within the selected `numTypos` but the min_len rule
   *  cut the budget below it — i.e. "relax min_len" would fix this. */
  blockedByMinLen: boolean;
}

/**
 * The "why did this find nothing?" payload. Typesense has no nearest-term
 * endpoint and probe searches cannot substitute (`num_typos` caps at 2 while
 * this reaches 4 edits), so the backend samples documents into a local term
 * dictionary. `sampledDocuments` / `complete` carry that caveat: unless
 * `complete`, the panel must say "in a sample of N documents".
 */
export interface EmptyStateDiagnosis {
  tokens: TokenDiagnosis[];
  sampledDocuments: number;
  complete: boolean;
}

// -- HTTP console -----------------------------------------------------------

/** An already-normalized console command. The forgiving *parsing* of what the
 *  user typed (bare paths, full URLs, pasted `curl`) happens in the renderer. */
export interface HttpConsoleRequest {
  method: string;
  /** Path plus query string, always leading-slashed. */
  path: string;
  body?: string;
}

export interface HttpConsoleResponse {
  status: number;
  /** Parsed JSON when the body was JSON, else a string. */
  body: unknown;
}

// -- Commands ---------------------------------------------------------------

export function typesenseCapabilities(handleId: string): Promise<ServerCapabilities> {
  return invoke<ServerCapabilities>("typesense_capabilities", { handleId });
}

export function typesenseHealth(handleId: string): Promise<ClusterHealth> {
  return invoke<ClusterHealth>("typesense_health", { handleId });
}

export function typesenseNodes(handleId: string): Promise<NodeInfo[]> {
  return invoke<NodeInfo[]>("typesense_nodes", { handleId });
}

export function typesenseClusterStats(handleId: string): Promise<ClusterStats> {
  return invoke<ClusterStats>("typesense_cluster_stats", { handleId });
}

/** Admin key required — throws `Unsupported` for a search-only key. */
export function typesenseCollections(handleId: string): Promise<CollectionDescriptor[]> {
  return invoke<CollectionDescriptor[]>("typesense_collections", { handleId });
}

/** Reachable with a search-only key scoped to this collection. */
export function typesenseCollection(handleId: string, name: string): Promise<CollectionDescriptor> {
  return invoke<CollectionDescriptor>("typesense_collection", { handleId, name });
}

/** Admin key required. */
export function typesenseAliases(handleId: string): Promise<AliasInfo[]> {
  return invoke<AliasInfo[]>("typesense_aliases", { handleId });
}

/** Admin key required. Returns metadata only — never a full key. */
export function typesenseApiKeys(handleId: string): Promise<ApiKeyInfo[]> {
  return invoke<ApiKeyInfo[]>("typesense_api_keys", { handleId });
}

/** Admin key required. */
export function typesenseSynonyms(handleId: string, collection: string): Promise<SynonymInfo[]> {
  return invoke<SynonymInfo[]>("typesense_synonyms", { handleId, collection });
}

/** Admin key required. */
export function typesenseCurations(handleId: string, collection: string): Promise<CurationInfo[]> {
  return invoke<CurationInfo[]>("typesense_curations", { handleId, collection });
}

export function typesenseAnalytics(handleId: string): Promise<AnalyticsOverview> {
  return invoke<AnalyticsOverview>("typesense_analytics", { handleId });
}

export function typesenseSearch(handleId: string, request: SearchRequest): Promise<SearchResponse> {
  return invoke<SearchResponse>("typesense_search", { handleId, request });
}

export function typesenseDocuments(
  handleId: string,
  collection: string,
  page: number,
  perPage: number,
): Promise<DocumentPage> {
  return invoke<DocumentPage>("typesense_documents", { handleId, collection, page, perPage });
}

export function typesenseDiagnose(
  handleId: string,
  collection: string,
  fields: string[],
  query: string,
  numTypos: number,
  relaxMinLen: boolean,
): Promise<EmptyStateDiagnosis> {
  return invoke<EmptyStateDiagnosis>("typesense_diagnose", {
    handleId,
    collection,
    fields,
    query,
    numTypos,
    relaxMinLen,
  });
}

export function typesenseUpsertDocument(
  handleId: string,
  collection: string,
  document: unknown,
): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("typesense_upsert_document", {
    handleId,
    collection,
    document,
  });
}

export function typesenseDeleteDocument(
  handleId: string,
  collection: string,
  id: string,
): Promise<void> {
  return invoke<void>("typesense_delete_document", { handleId, collection, id });
}

export function typesenseRawHttp(
  handleId: string,
  request: HttpConsoleRequest,
): Promise<HttpConsoleResponse> {
  return invoke<HttpConsoleResponse>("typesense_raw_http", { handleId, request });
}
