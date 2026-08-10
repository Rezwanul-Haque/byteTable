// Pure helpers for the search playground (M30 Tasks 2/3/4): tokenizing, the
// min_len typo budget, `filter_by` composition, `<mark>` parsing, the `curl`
// builder, and the relevance x-ray derivation.
//
// # Why the x-ray is derived here rather than read off the response
//
// The milestone asks the x-ray to show, per query token, the matched field, the
// match kind, the field weight, the token position and a contribution bar.
// Typesense's `text_match_info` is **per hit and aggregate** — `best_field_score`,
// `best_field_weight`, `fields_matched`, `tokens_matched`, `num_tokens_dropped`,
// `typo_prefix_score` — with no per-token breakdown at all.
//
// What IS honest to derive: `highlights[].matchedTokens` tells us which query
// token matched in which field, and comparing the matched term against the query
// token tells us whether it was an exact hit, a prefix extension, a typo (and at
// what edit distance) or something reachable by neither — i.e. a synonym. The
// position comes from scanning the document's own field text. Only the
// *contribution bar* has no server truth; the UI labels it "estimated" and shows
// the real `text_match` / `text_match_info` above it.

import type { Highlight, QueryByField, SearchHit, TextMatchInfo } from "./api";

/** Tokenize like the index does: lowercase runs of alphanumerics. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Banded Levenshtein with early exit; returns `cap + 1` once it exceeds `cap`. */
export function levenshtein(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, cur[j]!);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * How many typos a token of `length` characters actually gets. Mirrors the
 * backend's `allowed_typos` exactly — with **relax min_len** on (the default)
 * the selected budget applies in full; off, Typesense's own gating applies
 * (1 typo needs ≥4 characters, 2 need ≥7).
 */
export function allowedTypos(numTypos: number, length: number, relaxMinLen: boolean): number {
  const selected = Math.min(numTypos, 2);
  if (relaxMinLen) return selected;
  const gated = length >= 7 ? 2 : length >= 4 ? 1 : 0;
  return Math.min(selected, gated);
}

/**
 * The typo budget the SHORTEST token in `query` actually gets. `null` when the
 * question does not arise (no query, relaxed, or typos already off). The
 * playground shows the amber `effective N` chip when this is below the selected
 * `num_typos` — the one number that explains "why didn't my typo match?".
 */
export function effectiveTypos(
  query: string,
  numTypos: number,
  relaxMinLen: boolean,
): number | null {
  const tokens = tokenize(query);
  if (!tokens.length || relaxMinLen || numTypos === 0) return null;
  return Math.min(...tokens.map((t) => allowedTypos(numTypos, t.length, relaxMinLen)));
}

// -- filter_by ---------------------------------------------------------------

/** One facet selection. */
export interface FilterChip {
  field: string;
  value: string;
}

/**
 * Compose `filter_by` from the facet chips.
 *
 * Values of the SAME field are OR-ed via Typesense's `field:=[a,b]` array form
 * and different fields are AND-ed — which is what a facet rail means: narrowing
 * within a facet widens, narrowing across facets tightens. A value containing
 * anything but word characters is backtick-quoted, Typesense's own escape.
 */
export function buildFilterBy(chips: FilterChip[]): string | undefined {
  if (chips.length === 0) return undefined;
  const byField = new Map<string, string[]>();
  for (const chip of chips) {
    const list = byField.get(chip.field) ?? [];
    if (!list.includes(chip.value)) list.push(chip.value);
    byField.set(chip.field, list);
  }
  const quote = (v: string) => (/^[\w.-]+$/.test(v) ? v : "`" + v.replace(/`/g, "") + "`");
  return [...byField.entries()]
    .map(([field, values]) =>
      values.length === 1
        ? field + ":=" + quote(values[0]!)
        : field + ":=[" + values.map(quote).join(",") + "]",
    )
    .join(" && ");
}

/** Human label for a chip (what the removable pill shows). */
export function chipLabel(chip: FilterChip): string {
  return chip.field + ":=" + chip.value;
}

// -- highlighting ------------------------------------------------------------

/** One run of snippet text, marked or not. */
export interface MarkPart {
  text: string;
  mark: boolean;
}

/**
 * Split a Typesense highlight snippet into marked / unmarked runs.
 *
 * The server returns the field text with `<mark>` tags inserted and does NOT
 * escape other markup, so the snippet is parsed rather than injected as HTML —
 * React then renders every run as a text node, and any `<script>` living in a
 * document field is displayed, not executed.
 */
export function parseMarks(snippet: string): MarkPart[] {
  const parts: MarkPart[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), mark: false });
    parts.push({ text: m[1]!, mark: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), mark: false });
  return parts;
}

/** Plain text of a value for the un-highlighted fallback. */
export function plainText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(plainText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * The parts to render for one field: the server's highlight when it has one for
 * that field, else the raw value unmarked.
 */
export function fieldParts(
  hit: SearchHit,
  field: string | undefined,
  fallbackLimit?: number,
): MarkPart[] {
  if (!field) return [];
  const highlight = hit.highlights.find((h) => h.field === field);
  if (highlight?.snippet) return parseMarks(highlight.snippet);
  const raw = plainText(hit.document[field]);
  const text =
    fallbackLimit && raw.length > fallbackLimit ? raw.slice(0, fallbackLimit) + " …" : raw;
  return text ? [{ text, mark: false }] : [];
}

// -- relevance x-ray ---------------------------------------------------------

export type MatchKind = "exact" | "prefix" | "typo" | "synonym";

/** One per-token row of the x-ray. */
export interface XrayRow {
  token: string;
  /** The indexed term the server actually matched. */
  matched: string;
  field: string;
  kind: MatchKind;
  /** Edit distance, for `typo` rows. */
  distance: number;
  weight: number;
  /** 0-based token position in the matched field, or `null` when unresolvable. */
  position: number | null;
  /** 0–1 estimated contribution — the one figure with no server truth. */
  contribution: number;
}

export interface Xray {
  rows: XrayRow[];
  /** Query tokens with no highlight at all (dropped, or matched a field that
   *  produced no snippet). Named so the panel can say so rather than omit them. */
  unmatched: string[];
  /** The server's own numbers, shown as the authoritative head. */
  textMatch: string;
  info: TextMatchInfo | undefined;
}

/** Classify how `matched` relates to the query `token`. */
function classify(token: string, matched: string): { kind: MatchKind; distance: number } {
  if (token === matched) return { kind: "exact", distance: 0 };
  if (matched.startsWith(token)) return { kind: "prefix", distance: 0 };
  const distance = levenshtein(token, matched, 2);
  if (distance <= 2) return { kind: "typo", distance };
  // Reachable by neither prefix nor the typo budget — the server got here
  // through a synonym rule.
  return { kind: "synonym", distance: 0 };
}

/** Base score per kind, before the field weight (an estimate — see the header). */
const KIND_BASE: Record<MatchKind, number> = {
  exact: 100,
  prefix: 74,
  synonym: 70,
  typo: 100,
};

/** Position of `term` among the tokens of a document field, or null. */
function positionIn(document: Record<string, unknown>, field: string, term: string): number | null {
  const tokens = tokenize(plainText(document[field]));
  const index = tokens.indexOf(term);
  return index >= 0 ? index : null;
}

/**
 * Build the x-ray for one hit from the server's highlights (see the module
 * header for why this is derived rather than read).
 */
export function deriveXray(hit: SearchHit, query: string, queryBy: QueryByField[]): Xray {
  const weightOf = (field: string) => queryBy.find((f) => f.field === field)?.weight ?? 1;
  const tokens = tokenize(query);
  const rows: XrayRow[] = [];
  const unmatched: string[] = [];

  for (const token of tokens) {
    // Every (field, matchedTerm) pair this token could account for.
    const candidates: { highlight: Highlight; matched: string; score: number }[] = [];
    for (const highlight of hit.highlights) {
      for (const matched of highlight.matchedTokens) {
        const lower = matched.toLowerCase();
        const { kind, distance } = classify(token, lower);
        // A synonym match is a guess by elimination, so only accept it when no
        // closer explanation exists anywhere; rank it last.
        const rank = kind === "exact" ? 0 : kind === "prefix" ? 1 : kind === "typo" ? 2 : 3;
        const weight = weightOf(highlight.field);
        // Prefer the better match kind, then the more heavily weighted field.
        candidates.push({
          highlight,
          matched: lower,
          score: rank * 1000 - weight * 10 + distance,
        });
      }
    }
    if (candidates.length === 0) {
      unmatched.push(token);
      continue;
    }
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0]!;
    const { kind, distance } = classify(token, best.matched);
    const weight = weightOf(best.highlight.field);
    const position = positionIn(hit.document, best.highlight.field, best.matched);
    // Estimated contribution: the kind's base, docked per edit, scaled by the
    // field weight, normalised against the best possible (exact × max weight).
    const maxWeight = Math.max(1, ...queryBy.map((f) => f.weight));
    const base = Math.max(0, KIND_BASE[kind] - distance * 24);
    const positionBonus = position === null ? 0 : Math.max(0, 8 - position);
    const contribution = Math.min(1, ((base + positionBonus) * weight) / (108 * maxWeight));
    rows.push({
      token,
      matched: best.matched,
      field: best.highlight.field,
      kind,
      distance,
      weight,
      position,
      contribution,
    });
  }

  return { rows, unmatched, textMatch: hit.textMatch, info: hit.textMatchInfo };
}

/** Total edit distance across a hit's matched tokens — the `N typos` badge. */
export function typoCount(xray: Xray): number {
  return xray.rows.reduce((sum, r) => sum + r.distance, 0);
}

/**
 * The highest `text_match` among hits that actually carry one.
 *
 * Curated (pinned) documents are **injected rather than ranked**, so Typesense
 * omits `text_match` and `text_match_info` for them entirely. Taking the first
 * hit as the baseline therefore collapses the whole relevance column to zero
 * the moment a curation rule pins something to position 1 — hence this scan.
 */
export function topTextMatch(hits: SearchHit[]): number {
  let top = 0;
  for (const hit of hits) {
    const value = Number(hit.textMatch);
    if (hit.textMatch && Number.isFinite(value) && value > top) top = value;
  }
  return top;
}

/**
 * A 0–100 relevance number for the hit bar, or `null` for a hit the server did
 * not rank (a curation pin). Ranked hits carry a 64-bit `text_match` whose
 * absolute value means nothing to a reader, so this is the hit's score as a
 * share of the best ranked hit on the page — a *relative* reading, which is the
 * only honest one. `null` is rendered as "pinned", never as 0%.
 */
export function relevancePercent(hit: SearchHit, top: number): number | null {
  const value = Number(hit.textMatch);
  if (!hit.textMatch || !Number.isFinite(value) || top <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((value / top) * 100)));
}

// -- curl --------------------------------------------------------------------

/**
 * The `curl` for a search, built from the parameters the backend actually sent.
 *
 * The key is a `${TYPESENSE_API_KEY}` placeholder, never the real one: this
 * string is copied to the clipboard and pasted into terminals and issue
 * trackers. Pasting it back into the app's own HTTP console works regardless —
 * the console attaches the connection's key itself.
 */
export function curlFor(requestUrl: string, requestParams: Record<string, string>): string {
  const qs = Object.entries(requestParams)
    .map(([k, v]) => k + "=" + encodeURIComponent(v))
    .join("&");
  return (
    "curl -H 'X-TYPESENSE-API-KEY: ${TYPESENSE_API_KEY}' \\\n  '" + requestUrl + "?" + qs + "'"
  );
}

/**
 * Replace one token inside a query, for the empty state's clickable nearest-term
 * chips. A single-token query is replaced outright; a multi-token one swaps just
 * that token, leaving the rest of the phrase intact.
 */
export function substituteToken(query: string, token: string, replacement: string): string {
  if (tokenize(query).length <= 1) return replacement;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return query.replace(
    new RegExp("(^|[^\\p{L}\\p{N}])" + escaped + "(?![\\p{L}\\p{N}])", "iu"),
    (_m, lead: string) => lead + replacement,
  );
}
