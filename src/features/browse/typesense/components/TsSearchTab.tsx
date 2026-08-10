// Typesense search playground (M30 Tasks 2/3/4) — the centrepiece of the track,
// ported from typesense-search.jsx. Layout, top to bottom: query bar → controls
// row → collapsible request panel → filter chips → results + facet rail →
// the shared `.table-footer` pager.
//
// Every number shown comes from the server's own response (`found`, `out_of`,
// `search_time_ms`, `facet_counts`, `text_match`). The two figures Typesense
// does NOT report are handled explicitly rather than invented:
//
//   - **hidden by curation** — no such response field exists, so it is derived
//     by a second curation-off search, and only when the collection actually has
//     curation rules that could apply (see `countHidden`).
//   - **per-token relevance** — `text_match_info` is aggregate per hit, so the
//     x-ray's rows are derived from `highlights[].matchedTokens` and the
//     contribution bars are labelled "estimated". See `../search.ts`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import {
  typesenseCurations,
  typesenseDiagnose,
  typesenseSearch,
  type CollectionDescriptor,
  type EmptyStateDiagnosis,
  type PopularQuery,
  type QueryByField,
  type SearchHit,
  type SearchResponse,
} from "../api";
import { tsCount, tsFmt } from "../format";
import {
  buildFilterBy,
  chipLabel,
  curlFor,
  deriveXray,
  effectiveTypos,
  fieldParts,
  relevancePercent,
  substituteToken,
  topTextMatch,
  typoCount,
  type FilterChip,
  type MarkPart,
  type Xray,
} from "../search";
import { TsError, TsLoading } from "./TsBits";

/** Identity for one hit within a page — the document id, falling back to the
 *  rank so a (malformed) id-less document still gets a unique key. */
function hitKey(hit: SearchHit, index: number): string {
  const id = hit.document.id;
  return typeof id === "string" && id ? id : "#" + index;
}

/** Debounce for the instant-search input — long enough not to hammer the node
 *  mid-word, short enough to still feel instant. */
const DEBOUNCE_MS = 180;
const PAGE_SIZE_OPTIONS = [12, 25, 50, 100, 250] as const;
/** Snippet fields never make a good title; they make a good body. */
const SNIPPET_FIELDS = ["description", "body", "content"];

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Latency sparkline — hidden until latency actually varies (Task 3): at least
 *  three samples AND two distinct values, so it is never a row of equal bars. */
function TsSparkline({ values }: { values: number[] }) {
  const distinct = new Set(values);
  if (values.length < 3 || distinct.size < 2) return null;
  const max = Math.max(...values, 1);
  return (
    <span
      className="ts-spark"
      title={
        "search_time_ms across the last " +
        Math.min(14, values.length) +
        " queries · peak " +
        max +
        " ms"
      }
    >
      {values.slice(-14).map((v, i) => (
        <span key={i} style={{ height: Math.max(2, Math.round((v / max) * 12)) + "px" }} />
      ))}
    </span>
  );
}

function TsHighlight({ parts }: { parts: MarkPart[] }) {
  return (
    <span>
      {parts.map((p, i) =>
        p.mark ? (
          <mark key={i} className="ts-mark">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}

const KIND_LABEL: Record<string, string> = {
  exact: "exact",
  prefix: "prefix",
  typo: "typo",
  synonym: "synonym",
};

/** The relevance x-ray (Task 2). The head carries the server's real numbers; the
 *  rows are derived and the bars are explicitly estimated. */
function TsXray({ xray, queryBy }: { xray: Xray; queryBy: QueryByField[] }) {
  const info = xray.info;
  return (
    <div className="ts-xray">
      <div className="ts-xray-head">
        <span>relevance x-ray · contribution estimated</span>
        <span className="ts-xray-tm">
          text_match <b>{xray.textMatch || "—"}</b>
          {info ? (
            <>
              {" · "}
              {info.tokensMatched} tok · {info.fieldsMatched} field
              {info.fieldsMatched === 1 ? "" : "s"} · weight {info.bestFieldWeight}
            </>
          ) : null}
        </span>
      </div>
      <div className="ts-xray-rows">
        {xray.rows.length === 0 ? (
          <div className="ts-xray-none">no query tokens — browsing by sort order</div>
        ) : (
          xray.rows.map((r, i) => (
            <div key={i} className="ts-xray-row">
              <span className="ts-xray-tok">{r.token}</span>
              <Icon name="arrow_right_alt" size={13} style={{ color: "var(--text-faint)" }} />
              <span className="ts-xray-field">{r.field}</span>
              <span className={"ts-kind " + (r.kind === "synonym" ? "syn" : r.kind)}>
                {KIND_LABEL[r.kind]}
                {r.kind === "typo" ? " ·" + r.distance : ""}
              </span>
              {r.matched !== r.token ? <span className="ts-xray-pos">→ {r.matched}</span> : null}
              <span className="ts-xray-w">×{r.weight}</span>
              {r.position !== null ? <span className="ts-xray-pos">pos {r.position}</span> : null}
              <span className="ts-xray-bar">
                <span style={{ width: Math.round(r.contribution * 100) + "%" }} />
              </span>
            </div>
          ))
        )}
        {xray.unmatched.length > 0 ? (
          <div className="ts-xray-none">
            not matched in any highlighted field: {xray.unmatched.join(", ")}
          </div>
        ) : null}
      </div>
      <div className="ts-xray-foot">
        searched fields: {queryBy.map((q) => q.field + "×" + q.weight).join(" · ")}
      </div>
    </div>
  );
}

function TsHitRow({
  hit,
  rank,
  topScore,
  collection,
  query,
  queryBy,
  open,
  onToggle,
}: {
  hit: SearchHit;
  rank: number;
  /** Best `text_match` on the page — the denominator for the relevance bar. */
  topScore: number;
  collection: CollectionDescriptor;
  query: string;
  queryBy: QueryByField[];
  /** Whether this row's x-ray is the one currently expanded. */
  open: boolean;
  onToggle: () => void;
}) {
  const xray = useMemo(() => deriveXray(hit, query, queryBy), [hit, query, queryBy]);
  const typos = typoCount(xray);
  const bodyField = collection.fields.find(
    (f) => f.type.startsWith("string") && SNIPPET_FIELDS.includes(f.name),
  );
  const titleParts = fieldParts(hit, collection.titleField);
  const snippetParts = fieldParts(hit, bodyField?.name, 220);
  // `null` when the server ranked nothing for this hit: either curation pinned
  // it (injected, not scored) or the query was a match-all browse, where no hit
  // gets a `text_match` at all. Those are different reasons for the same blank,
  // so the tooltip distinguishes them — and neither is "0% relevant".
  const percent = relevancePercent(hit, topScore);
  const id = typeof hit.document.id === "string" ? hit.document.id : "";

  return (
    <div className={"ts-hit" + (open ? " open" : "") + (hit.curated ? " pinned" : "")}>
      <button type="button" className="ts-hit-main" onClick={onToggle}>
        <span className="ts-rank">{rank}</span>
        <span className="ts-hit-body">
          <span className="ts-hit-title">
            {titleParts.length ? <TsHighlight parts={titleParts} /> : <span>{id}</span>}
            {hit.curated ? (
              <span className="ts-pin">
                <Icon name="push_pin" size={11} /> curated
              </span>
            ) : null}
            {typos > 0 ? (
              <span className="ts-typo-tag">
                {typos} typo{typos > 1 ? "s" : ""}
              </span>
            ) : null}
          </span>
          {snippetParts.length ? (
            <span className="ts-hit-snip">
              <TsHighlight parts={snippetParts} />
            </span>
          ) : null}
          <span className="ts-hit-meta">
            <span className="ts-hit-id">{id}</span>
            {collection.subFields.map((f) => (
              <span key={f} className="ts-hit-kv">
                {f} <b>{tsFmt(hit.document[f])}</b>
              </span>
            ))}
          </span>
        </span>
        <span className="ts-hit-score">
          {percent === null ? (
            <span
              className="ts-relnum"
              title={
                hit.curated
                  ? "Pinned by a curation rule — injected rather than ranked, so it has no text_match"
                  : "No text ranking for a match-all query — these results are ordered by sort_by"
              }
            >
              —
            </span>
          ) : (
            <>
              <span className="ts-relbar">
                <span style={{ width: percent + "%" }} />
              </span>
              <span className="ts-relnum">{percent}</span>
            </>
          )}
        </span>
        <Icon
          name={open ? "expand_less" : "expand_more"}
          size={16}
          style={{ color: "var(--text-faint)" }}
        />
      </button>
      {open ? <TsXray xray={xray} queryBy={queryBy} /> : null}
    </div>
  );
}

/**
 * The sort picker — a custom dropdown, never a native `<select>` (Task 3).
 *
 * Hand-rolled rather than the shared `Select` because this is a toolbar PILL
 * (`.ts-ctl`, matching the toggles beside it), not a form field. The styling is
 * the only thing that differs, though: the keyboard and ARIA behaviour mirrors
 * `Select` deliberately — `role="listbox"`/`option`, Enter/Space/ArrowDown to
 * open, arrows + Home/End to move, Escape to close, and focus returned to the
 * trigger on close. Options are `<button>`s, so they are reachable by Tab too.
 */
function TsSortPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Outside mousedown / Escape / window blur close the popover — the same three
  // dismissals the shared Select uses.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onBlur = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  // Opening with the keyboard should land on an option, not leave focus behind.
  useEffect(() => {
    if (!open) return;
    const active = Math.max(
      0,
      options.findIndex((o) => o.value === value),
    );
    optRefs.current[active]?.focus();
  }, [open, options, value]);

  const onOptKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      optRefs.current[Math.min(options.length - 1, index + 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      optRefs.current[Math.max(0, index - 1)]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      optRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      optRefs.current[options.length - 1]?.focus();
    }
  };

  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <div style={{ position: "relative" }} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={"ts-ctl" + (value !== "_text_match:desc" ? " on" : "")}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        title="sort_by"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={"Sort by " + (current?.label ?? "relevance")}
      >
        <Icon name="sort" size={13} /> {current?.label ?? "relevance"}{" "}
        <Icon name="expand_more" size={13} style={{ color: "var(--text-faint)" }} />
      </button>
      {open ? (
        <div className="schema-pop ts-sort-pop" role="listbox" aria-label="Sort by">
          {options.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => {
                optRefs.current[i] = el;
              }}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={"schema-pop-item" + (o.value === value ? " active" : "")}
              onClick={() => {
                onChange(o.value);
                close(true);
              }}
              onKeyDown={(e) => onOptKeyDown(e, i)}
            >
              <Icon
                name={
                  o.value === "_text_match:desc"
                    ? "auto_awesome"
                    : o.value.endsWith("asc")
                      ? "arrow_upward"
                      : "arrow_downward"
                }
                size={14}
              />
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The empty-state diagnosis (Task 4). Rows come from the backend's sampled term
 * dictionary — Typesense has no nearest-term endpoint — so the footer says how
 * big the sample was unless it covered the whole collection.
 */
function TsWhyEmpty({
  diagnosis,
  numTypos,
  relaxMinLen,
  onRelax,
  onTypos,
  onPickTerm,
}: {
  diagnosis: EmptyStateDiagnosis;
  numTypos: number;
  relaxMinLen: boolean;
  onRelax: () => void;
  onTypos: (n: number) => void;
  onPickTerm: (token: string, term: string) => void;
}) {
  if (!diagnosis.tokens.length) return null;
  const blocked = diagnosis.tokens.some((t) => t.blockedByMinLen);
  // A closer term exists but sits outside the CURRENT budget — raising typos
  // would reach it.
  const needsMoreTypos = diagnosis.tokens.some(
    (t) => t.nearest.length > 0 && t.nearest[0]!.distance > t.allowedTypos,
  );
  return (
    <div className="ts-why">
      <div className="ts-why-head">why</div>
      {diagnosis.tokens.map((t) => (
        <div key={t.token} className="ts-why-row">
          <span className="ts-why-tok">{t.token}</span>
          <span className="ts-why-budget">
            {t.length} chars → <b>{t.allowedTypos}</b> typo{t.allowedTypos === 1 ? "" : "s"} allowed
          </span>
          {t.nearest.length ? (
            <span className="ts-why-near">
              nearest indexed term
              {t.nearest.map((n) => (
                <button
                  key={n.term + n.field}
                  type="button"
                  className="ts-why-term"
                  onClick={() => onPickTerm(t.token, n.term)}
                  title={"Search for “" + n.term + "” instead"}
                >
                  {n.term}
                  <i>
                    {n.field} · {n.distance} edit{n.distance === 1 ? "" : "s"}
                  </i>
                </button>
              ))}
            </span>
          ) : (
            <span className="ts-why-near">nothing within 4 edits in the selected fields</span>
          )}
        </div>
      ))}
      <div className="ts-why-foot">
        {blocked ? (
          <span>
            Typesense only allows 1 typo from 4 characters and 2 from 7 (<code>min_len_1typo</code>{" "}
            / <code>min_len_2typo</code>), so a short token cannot reach a 2-edit match.
          </span>
        ) : null}
        {blocked && !relaxMinLen ? (
          <button type="button" className="ts-why-fix" onClick={onRelax}>
            relax min_len
          </button>
        ) : null}
        {needsMoreTypos && numTypos < 2 ? (
          <button type="button" className="ts-why-fix" onClick={() => onTypos(2)}>
            set typos to 2
          </button>
        ) : null}
        {!diagnosis.complete ? (
          <span>
            Nearest terms come from a sample of {tsCount(diagnosis.sampledDocuments)} documents, not
            the whole index.
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The playground
// ---------------------------------------------------------------------------

interface TsSearchTabProps {
  handleId: string;
  collection: CollectionDescriptor | null;
  /** A query seeded from elsewhere (a curation rule, a popular query). */
  seedQuery?: string;
  onSeedConsumed?: () => void;
  /** Popular queries from the cluster's analytics, when configured. */
  popularQueries?: PopularQuery[];
  /** False for a search-only key — curation rules are then unreadable, so the
   *  `N hidden` chip cannot be computed and is never shown. */
  adminKey?: boolean;
}

export function TsSearchTab({
  handleId,
  collection,
  seedQuery,
  onSeedConsumed,
  popularQueries = [],
  adminKey = false,
}: TsSearchTabProps) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const name = collection?.name ?? "";

  const textFields = useMemo(
    () => (collection?.fields ?? []).filter((f) => f.type.startsWith("string") && f.index),
    [collection],
  );
  const facetFields = useMemo(
    () => (collection?.fields ?? []).filter((f) => f.facet).map((f) => f.name),
    [collection],
  );
  const sortOptions = useMemo(
    () => [
      { value: "_text_match:desc", label: "relevance" },
      ...(collection?.fields ?? [])
        .filter((f) => f.sort)
        .flatMap((f) => [
          { value: f.name + ":desc", label: f.name + " ↓" },
          { value: f.name + ":asc", label: f.name + " ↑" },
        ]),
    ],
    [collection],
  );

  /** Default field weights: the title heaviest, snippet fields lightest. */
  const defaultQueryBy = useCallback((): QueryByField[] => {
    return textFields.slice(0, 4).map((f, i) => ({
      field: f.name,
      weight:
        f.name === collection?.titleField
          ? 5
          : SNIPPET_FIELDS.includes(f.name)
            ? 1
            : i === 0
              ? 4
              : 2,
    }));
  }, [textFields, collection]);

  const [q, setQ] = useState("");
  const [queryBy, setQueryBy] = useState<QueryByField[]>(defaultQueryBy);
  const [disabledFields, setDisabledFields] = useState<Set<string>>(new Set());
  const [numTypos, setNumTypos] = useState(2);
  const [prefix, setPrefix] = useState(true);
  const [synonyms, setSynonyms] = useState(true);
  const [curation, setCuration] = useState(true);
  const [relaxMinLen, setRelaxMinLen] = useState(true);
  const [sortBy, setSortBy] = useState("_text_match:desc");
  const [chips, setChips] = useState<FilterChip[]>([]);
  const [showRequest, setShowRequest] = useState(false);
  const [perPage, setPerPage] = useState<number>(12);
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number[]>([]);
  const [diagnosis, setDiagnosis] = useState<EmptyStateDiagnosis | null>(null);
  /**
   * Which hit's relevance x-ray is expanded — at most one at a time.
   *
   * Owned here rather than per row: the x-ray is a comparison tool, and two
   * open panels push the rows being compared off the screen. Clicking the open
   * row collapses it; clicking another moves the expansion.
   */
  const [openHit, setOpenHit] = useState<string | null>(null);
  /** Whether this collection has curation rules at all — gates the second
   *  (curation-off) request that derives `hiddenByCuration`. */
  const [hasCuration, setHasCuration] = useState(false);

  // Reset every control when the tab's collection changes.
  useEffect(() => {
    setQ("");
    setChips([]);
    setSortBy("_text_match:desc");
    setQueryBy(defaultQueryBy());
    setDisabledFields(new Set());
    setPage(1);
    setLatency([]);
    setDiagnosis(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // A seeded query (from a curation row, a popular query, the dashboard).
  useEffect(() => {
    if (seedQuery === undefined) return;
    setQ(seedQuery);
    setPage(1);
    onSeedConsumed?.();
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuery]);

  // Does this collection have curation rules? Admin-only, and cheap to ask once.
  useEffect(() => {
    if (!name || !adminKey) {
      setHasCuration(false);
      return;
    }
    let live = true;
    typesenseCurations(handleId, name)
      .then((rules) => live && setHasCuration(rules.length > 0))
      .catch(() => live && setHasCuration(false));
    return () => {
      live = false;
    };
  }, [handleId, name, adminKey]);

  const activeQueryBy = useMemo(
    () => queryBy.filter((f) => !disabledFields.has(f.field)),
    [queryBy, disabledFields],
  );
  const filterBy = useMemo(() => buildFilterBy(chips), [chips]);

  // Any parameter change resets to page 1 (Task 3).
  const paramKey = [
    name,
    q,
    JSON.stringify(activeQueryBy),
    numTypos,
    prefix,
    synonyms,
    curation,
    relaxMinLen,
    sortBy,
    filterBy ?? "",
    perPage,
  ].join("\u0000");
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setPage(1);
  }, [paramKey]);

  // An expanded x-ray explains one hit of one result set; once the parameters
  // or the page move, it is describing something that is no longer on screen.
  useEffect(() => {
    setOpenHit(null);
  }, [paramKey, page]);

  // The search itself, debounced. `countHidden` is only ever requested when the
  // collection actually has curation rules AND curation is on — it costs a
  // second round trip, so it is never speculative.
  useEffect(() => {
    if (!name || activeQueryBy.length === 0) {
      setResult(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      typesenseSearch(handleId, {
        collection: name,
        q,
        queryBy: activeQueryBy,
        numTypos,
        prefix,
        filterBy,
        facetBy: facetFields,
        sortBy: sortBy === "_text_match:desc" ? undefined : sortBy,
        perPage,
        page,
        relaxMinLen,
        enableSynonyms: synonyms,
        enableCuration: curation,
        countHidden: curation && hasCuration,
      })
        .then((r) => {
          if (!live) return;
          setResult(r);
          setLatency((l) => [...l, r.searchTimeMs].slice(-14));
        })
        .catch((e) => {
          if (!live) return;
          setError(isAppErrorPayload(e) ? e.message : "The search failed.");
          setResult(null);
        })
        .finally(() => live && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, paramKey, page, hasCuration]);

  // The empty-state diagnosis — only when there is a query AND nothing matched.
  useEffect(() => {
    if (!result || result.found > 0 || !q.trim() || !name) {
      setDiagnosis(null);
      return;
    }
    let live = true;
    typesenseDiagnose(
      handleId,
      name,
      activeQueryBy.map((f) => f.field),
      q,
      numTypos,
      relaxMinLen,
    )
      .then((d) => live && setDiagnosis(d))
      .catch(() => live && setDiagnosis(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, q, name, numTypos, relaxMinLen]);

  const pageCount = Math.max(1, Math.ceil((result?.found ?? 0) / perPage));
  // Clamp when the page count shrinks under the current page (Task 3).
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const effective = effectiveTypos(q, numTypos, relaxMinLen);
  const toggleField = (field: string) =>
    setDisabledFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  const bumpWeight = (field: string, delta: number) =>
    setQueryBy((qb) =>
      qb.map((f) =>
        f.field === field ? { ...f, weight: Math.max(1, Math.min(5, f.weight + delta)) } : f,
      ),
    );
  const toggleChip = (field: string, value: string) =>
    setChips((prev) =>
      prev.some((c) => c.field === field && c.value === value)
        ? prev.filter((c) => !(c.field === field && c.value === value))
        : [...prev, { field, value }],
    );

  // Reports the actual outcome, matching the shared CopyButton: a denied or
  // unavailable clipboard must not toast success.
  const copyCurl = () => {
    if (!result) return;
    const text = curlFor(result.requestUrl, result.requestParams);
    if (!navigator.clipboard?.writeText) {
      toast("Couldn't copy to clipboard", "err");
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => toast("curl request copied", "ok"),
      () => toast("Couldn't copy to clipboard", "err"),
    );
  };

  if (!collection) {
    return (
      <div className="ts-empty">
        <Icon name="search" size={26} style={{ color: "var(--text-faint)" }} />
        <p>No collection selected.</p>
        <span className="ts-empty-hint">Pick a collection in the sidebar to search it.</span>
      </div>
    );
  }

  const found = result?.found ?? 0;
  const from = found === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(found, page * perPage);
  // The baseline for every relevance bar. Scans for the best RANKED hit:
  // a curation pin carries no `text_match`, so hits[0] is often scoreless.
  const topScore = topTextMatch(result?.hits ?? []);

  return (
    <div className="ts-search" data-screen-label={"Typesense search playground: " + name}>
      {/* 1 — query bar */}
      <div className="ts-qbar">
        <Icon name="search" size={20} style={{ color: "var(--accent)" }} />
        <input
          ref={inputRef}
          className="ts-qinput"
          autoFocus
          value={q}
          spellCheck={false}
          placeholder={"Search " + name + " — instant, typo tolerant…"}
          onChange={(e) => setQ(e.target.value)}
        />
        {q ? (
          <button
            type="button"
            className="ts-qclear"
            title="Clear"
            onClick={() => {
              setQ("");
              inputRef.current?.focus();
            }}
          >
            <Icon name="close" size={15} />
          </button>
        ) : null}
        <span className="ts-lat">
          <b title="found — documents matching this query">{tsCount(found)}</b>{" "}
          <span title={"out_of — total documents in " + name}>
            / {tsCount(result?.outOf ?? collection.numDocuments)}
          </span>
          <span className="ts-lat-ms" title="search_time_ms reported by the server">
            {result ? result.searchTimeMs + " ms" : "—"}
          </span>
          {result?.hiddenByCuration ? (
            <button
              type="button"
              className="ts-hidden-chip"
              onClick={() => setCuration(false)}
              title={
                "A curation rule hides " +
                result.hiddenByCuration +
                " matching document" +
                (result.hiddenByCuration === 1 ? "" : "s") +
                " — click to switch curation off"
              }
            >
              <Icon name="visibility_off" size={12} /> {result.hiddenByCuration} hidden
            </button>
          ) : null}
          <TsSparkline values={latency} />
        </span>
      </div>

      {/* 2 — controls */}
      <div className="ts-ctlrow">
        <span className="ts-ctl-label">query_by</span>
        {queryBy.map((f) => {
          const on = !disabledFields.has(f.field);
          return (
            <span key={f.field} className={"ts-fpill" + (on ? "" : " off")}>
              <button
                type="button"
                className="ts-fpill-name"
                onClick={() => toggleField(f.field)}
                title="Toggle field"
              >
                {f.field}
              </button>
              <button
                type="button"
                className="ts-fpill-w"
                onClick={() => bumpWeight(f.field, -1)}
                disabled={!on || f.weight <= 1}
                title="Lower weight"
              >
                −
              </button>
              <b>{f.weight}</b>
              <button
                type="button"
                className="ts-fpill-w"
                onClick={() => bumpWeight(f.field, 1)}
                disabled={!on || f.weight >= 5}
                title="Raise weight"
              >
                +
              </button>
            </span>
          );
        })}
        <span className="ts-ctl-sep" />
        <span className="ts-ctl-label">typos</span>
        <div className="seg ts-seg">
          {[0, 1, 2].map((n) => (
            <button
              key={n}
              type="button"
              className={"seg-btn" + (numTypos === n ? " active" : "")}
              onClick={() => setNumTypos(n)}
              title={n === 2 ? "num_typos caps at 2 in Typesense" : undefined}
            >
              {n}
            </button>
          ))}
        </div>
        {effective !== null && effective < numTypos ? (
          <span
            className="ts-budget-warn"
            title={
              "min_len_1typo=4 / min_len_2typo=7 — your shortest token gets only " +
              effective +
              " typo" +
              (effective === 1 ? "" : "s") +
              ". Turn on “relax min_len” to override."
            }
          >
            <Icon name="straighten" size={12} /> effective {effective}
          </span>
        ) : null}
        <button
          type="button"
          className={"ts-ctl" + (prefix ? " on" : "")}
          onClick={() => setPrefix((p) => !p)}
          title="prefix search on the last token"
        >
          <Icon name="text_fields" size={13} /> prefix
        </button>
        <button
          type="button"
          className={"ts-ctl" + (synonyms ? " on" : "")}
          onClick={() => setSynonyms((s) => !s)}
          title="apply the collection's synonym sets"
        >
          <Icon name="swap_calls" size={13} /> synonyms
        </button>
        <button
          type="button"
          className={"ts-ctl" + (curation ? " on" : "")}
          onClick={() => setCuration((s) => !s)}
          title="apply curation rules (pins & hides)"
        >
          <Icon name="push_pin" size={13} /> curation
        </button>
        <button
          type="button"
          className={"ts-ctl" + (relaxMinLen ? " on" : "")}
          onClick={() => setRelaxMinLen((s) => !s)}
          title="send min_len_1typo=1 & min_len_2typo=1 — give short tokens the full typo budget too"
        >
          <Icon name="straighten" size={13} /> relax min_len
        </button>
        <TsSortPicker value={sortBy} options={sortOptions} onChange={setSortBy} />
        <span className="ts-ctl-spacer" />
        <button
          type="button"
          className={"ts-ctl" + (showRequest ? " on" : "")}
          onClick={() => setShowRequest((s) => !s)}
          title="Show the search request this UI is sending"
        >
          <Icon name="code" size={13} /> request
        </button>
        <button
          type="button"
          className="ts-ctl"
          onClick={copyCurl}
          disabled={!result}
          title="Copy this search as a curl command"
        >
          <Icon name="content_copy" size={13} /> curl
        </button>
      </div>

      {/* 3 — request panel, directly under the controls (NOT in the footer) */}
      {showRequest && result ? (
        <div className="ts-req-panel">
          <div className="ts-req-cols">
            <div>
              <div className="ts-req-h">search parameters</div>
              <pre className="ts-req-pre">{JSON.stringify(result.requestParams, null, 2)}</pre>
            </div>
            <div>
              <div className="ts-req-h">curl</div>
              <pre className="ts-req-pre">{curlFor(result.requestUrl, result.requestParams)}</pre>
            </div>
          </div>
        </div>
      ) : null}

      {/* 4 — filter chips */}
      {chips.length ? (
        <div className="ts-filterrow">
          <span className="ts-ctl-label">filter_by</span>
          {chips.map((c, i) => (
            <span key={c.field + ":" + c.value} className="ts-chip-filter">
              {chipLabel(c)}
              <button
                type="button"
                title="Remove this filter"
                onClick={() => setChips((prev) => prev.filter((_, j) => j !== i))}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          <button type="button" className="ts-clear-filters" onClick={() => setChips([])}>
            clear all
          </button>
        </div>
      ) : null}

      {/* 5 — results + facet rail */}
      <div className="ts-body">
        <div className="ts-results">
          {error ? (
            <TsError message={error} />
          ) : activeQueryBy.length === 0 ? (
            <div className="ts-empty">
              <Icon name="search_off" size={32} style={{ color: "var(--text-faint)" }} />
              <p>Every query_by field is switched off.</p>
              <span className="ts-empty-hint">
                Turn at least one field back on — Typesense needs a field to search in.
              </span>
            </div>
          ) : !result && loading ? (
            <TsLoading what="results" />
          ) : result && result.droppedTokens > 0 ? (
            <div className="ts-note">
              <Icon name="info" size={14} /> dropped {result.droppedTokens} token
              {result.droppedTokens > 1 ? "s" : ""} to find matches (drop_tokens_threshold)
            </div>
          ) : null}

          {result && found === 0 && !error ? (
            <div className="ts-empty">
              <Icon name="search_off" size={38} style={{ color: "var(--text-faint)" }} />
              <div>
                No documents matched <b>{q || "*"}</b>
                {chips.length ? " with these filters" : ""}.
              </div>
              {q.trim() && diagnosis ? (
                <TsWhyEmpty
                  diagnosis={diagnosis}
                  numTypos={numTypos}
                  relaxMinLen={relaxMinLen}
                  onRelax={() => setRelaxMinLen(true)}
                  onTypos={setNumTypos}
                  onPickTerm={(token, term) => {
                    const next = substituteToken(q, token, term);
                    setQ(next);
                    const el = inputRef.current;
                    if (el) {
                      el.focus();
                      // Caret at the end, so the user can keep typing.
                      window.setTimeout(() => el.setSelectionRange(next.length, next.length), 0);
                    }
                  }}
                />
              ) : null}
              <div className="ts-empty-hint">
                Try raising <b>typos</b>, enabling more <b>query_by</b> fields, or clearing filters.
              </div>
            </div>
          ) : (
            result?.hits.map((h, i) => {
              const key = hitKey(h, i);
              return (
                <TsHitRow
                  key={key}
                  hit={h}
                  rank={(result.page - 1) * result.perPage + i + 1}
                  topScore={topScore}
                  collection={collection}
                  query={q}
                  queryBy={activeQueryBy}
                  open={openHit === key}
                  onToggle={() => setOpenHit((cur) => (cur === key ? null : key))}
                />
              );
            })
          )}
        </div>

        <div className="ts-facets">
          <div className="ts-facets-head">facet_by</div>
          {(result?.facetCounts ?? []).map((f) => {
            const max = f.counts[0]?.count ?? 0;
            return (
              <div key={f.fieldName} className="ts-facet">
                <div className="ts-facet-name">{f.fieldName}</div>
                {f.counts.slice(0, 6).map((v) => {
                  const active = chips.some((c) => c.field === f.fieldName && c.value === v.value);
                  return (
                    <button
                      key={v.value}
                      type="button"
                      className={"ts-facet-row" + (active ? " active" : "")}
                      onClick={() => toggleChip(f.fieldName, v.value)}
                    >
                      <span className="ts-facet-bar">
                        <span
                          style={{
                            width: max > 0 ? Math.round((v.count / max) * 100) + "%" : "0%",
                          }}
                        />
                      </span>
                      <span className="ts-facet-val">{v.value}</span>
                      <span className="ts-facet-cnt">{tsCount(v.count)}</span>
                    </button>
                  );
                })}
                {f.counts.length === 0 ? <div className="ts-facet-none">—</div> : null}
              </div>
            );
          })}
          {facetFields.length === 0 ? (
            <div className="ts-facet-none">no facetable fields in this collection</div>
          ) : null}

          {popularQueries.length > 0 ? (
            <>
              <div className="ts-facets-head" style={{ marginTop: 14 }}>
                popular queries
              </div>
              {popularQueries.slice(0, 5).map((p) => (
                <button
                  key={p.query}
                  type="button"
                  className="ts-pop-row"
                  onClick={() => setQ(p.query)}
                  title={"run “" + p.query + "”"}
                >
                  <span className="ts-pop-q">{p.query}</span>
                  {p.noHits ? <span className="ts-pop-hits zero">no hits</span> : null}
                  <span className="ts-pop-cnt">{tsCount(p.count)}</span>
                </button>
              ))}
            </>
          ) : null}
        </div>
      </div>

      {/* 6 — the shared pager (same pattern as the SQL and Cassandra grids) */}
      <div className="table-footer">
        <span className="table-hint">
          <Icon name="keyboard" size={11} /> <code>/</code> focuses search · click a facet to filter
          · expand a hit for the relevance x-ray
        </span>
        <div className="pager">
          <span className="pager-label" id="ts-search-pager-label">
            Hits per page
          </span>
          <Select
            className="pager-size"
            placement="up"
            aria-labelledby="ts-search-pager-label"
            value={String(perPage)}
            options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => {
              setPerPage(Number(v));
              setPage(1);
            }}
          />
          <span className="pager-range">
            {found === 0 ? "0" : tsCount(from) + "–" + tsCount(to)} of {tsCount(found)} · Page{" "}
            {page} of {pageCount}
          </span>
          <IconBtn
            icon="chevron_left"
            title="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          />
          <IconBtn
            icon="chevron_right"
            title="Next page"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          />
        </div>
      </div>
    </div>
  );
}
