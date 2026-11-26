// Result compare (M51) — the SQL tab's Compare view, ported from the
// prototype's `ComparePanel` (compare.jsx).
//
// A is the editor's statement (live: editing the editor updates the card at
// once). B is the other version: the previous run, a history entry, or a
// pasted query, in an editable highlighted box. Compare runs both on the tab's
// connection through the `result_compare` slice — read-only, capped at
// MAX_ROWS a side, in one snapshot where the engine has one — then
// `compareModel.diff` matches the rows. Key and order choices re-evaluate the
// diff without running anything again.
//
// No partial answer: a refused or failed side shows its message and there is
// no verdict.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { CellValue, QueryResult } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { Icon } from "../../../shared/ui/Icon";
import { highlightSql } from "../../browse/shared/highlightSql";
import { CellContent } from "../../browse/shared/components/GridCell";
import { maskSql, useMask } from "../../masking/state";
import type { SqlHistoryEntry } from "../../workspaces/types";
import { compareCancel, compareRun, type Refusal, type SideOutcome } from "../api";
import {
  MAX_ROWS,
  SHOW_ROWS,
  firstList,
  stmtOf,
  suggestKey,
  verdictOf,
  type ChangedRow,
  type Side,
} from "../compareModel";
import { useCompareDiff } from "../hooks/useCompareDiff";
import { isMultiStatement, isReadOnlySql } from "../readSql";
import "./ComparePanel.css";

/** Earlier statements offered as B. */
const MAX_SOURCES = 8;
/** Characters of a source's SQL in the dropdown. */
const SOURCE_CHARS = 44;

type ListId = "changed" | "onlyA" | "onlyB" | "same";

/** One side as it ran: its rows, or why there are none. */
interface SideRun {
  side: Side | null;
  ms: number;
  error: string | null;
}

interface Run {
  sqlA: string;
  sqlB: string;
  a: SideRun;
  b: SideRun;
  snapshot: boolean;
}

/** The refusal the renderer can tell before sending anything. */
function refusalOf(sql: string): Refusal | null {
  const stmt = stmtOf(sql);
  if (!stmt) return "empty";
  if (isMultiStatement(stmt)) return "multi";
  if (!isReadOnlySql(stmt)) return "write";
  return null;
}

const toSide = (r: QueryResult): Side => ({
  columns: r.columns.map((c) => c.name),
  rows: r.rows,
});

// ---- the rows of one list ---------------------------------------------------

/** `pairs` (changed rows) draws A over B with the differing cells marked. */
function CmpTable({
  cols,
  rows,
  pairs,
  side,
  keyCols,
  label,
  labelledBy,
}: {
  cols: string[];
  rows?: CellValue[][];
  pairs?: ChangedRow[];
  side?: "a" | "b" | null;
  keyCols: string[];
  label: string;
  labelledBy: string;
}) {
  const isKey = (c: string) => keyCols.includes(c);
  const cell = (row: CellValue[], i: number, cls: string) => (
    <td key={i} className={cls}>
      <CellContent value={row[i] ?? null} column={cols[i]!} />
    </td>
  );
  const head = (
    <thead>
      <tr>
        <th className="cmp-side-h" aria-label={label} />
        {cols.map((c) => (
          <th key={c}>
            {isKey(c) ? <Icon name="key" size={11} /> : null}
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
  return (
    <div className="cmp-table-wrap" tabIndex={0} role="tabpanel" aria-labelledby={labelledBy}>
      <table className="cmp-table">
        {head}
        {pairs ? (
          pairs.slice(0, SHOW_ROWS).map((p, n) => (
            <tbody key={n} className="cmp-pair">
              <tr className="is-a">
                <td className="cmp-side">A</td>
                {cols.map((c, i) =>
                  cell(p.a, i, p.cols.includes(i) ? "cmp-del" : isKey(c) ? "cmp-key" : "cmp-dim"),
                )}
              </tr>
              <tr className="is-b">
                <td className="cmp-side">B</td>
                {cols.map((c, i) =>
                  cell(p.b, i, p.cols.includes(i) ? "cmp-add" : isKey(c) ? "cmp-key" : "cmp-dim"),
                )}
              </tr>
            </tbody>
          ))
        ) : (
          <tbody>
            {(rows ?? []).slice(0, SHOW_ROWS).map((r, n) => (
              <tr
                key={n}
                className={side === "a" ? "is-a only" : side === "b" ? "is-b only" : undefined}
              >
                <td className="cmp-side">{side === "a" ? "A" : side === "b" ? "B" : "="}</td>
                {cols.map((c, i) => cell(r, i, isKey(c) ? "cmp-key" : ""))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

// ---- the panel --------------------------------------------------------------

export function ComparePanel({
  sqlA,
  handleId,
  schemaName,
  history,
  minBtn,
  resultsMin,
  onClose,
}: {
  /** The editor's statement — A. */
  sqlA: string;
  handleId: string;
  schemaName: string;
  /** The workspace's run history, newest first. */
  history: SqlHistoryEntry[];
  /** The results area's minimise button, shared with the other views. */
  minBtn: ReactNode;
  resultsMin: boolean;
  onClose: () => void;
}) {
  const t = useT();
  useMask(); // cells and A's SQL follow data masking
  const stmtA = stmtOf(sqlA);

  // What B can be filled from: earlier successful reads that are not A.
  const [cands] = useState(() =>
    history
      .filter(
        (h) => h.ok && stmtOf(h.sql) !== "" && stmtOf(h.sql) !== stmtA && refusalOf(h.sql) === null,
      )
      .slice(0, MAX_SOURCES),
  );
  const [sqlB, setSqlB] = useState(cands[0]?.sql ?? "");
  const [src, setSrc] = useState(cands[0] ? "0" : "write");
  const [run, setRun] = useState<Run | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [mode, setMode] = useState<"auto" | "key" | "row">("auto");
  const [key, setKey] = useState<string[]>([]);
  const [ordered, setOrdered] = useState(false);
  const [tab, setTab] = useState<ListId>("changed");
  // The run in flight, set synchronously so a second ⌘↩ cannot start another.
  // A run whose id is no longer here (stopped, or the view left) never lands.
  const live = useRef<string | null>(null);
  // Leaving Compare stops a comparison still running.
  useEffect(
    () => () => {
      if (live.current) void compareCancel(live.current).catch(() => {});
      live.current = null;
    },
    [],
  );

  const refusalText = (r: Refusal) =>
    r === "empty"
      ? t("compare.err.empty")
      : r === "write"
        ? t("compare.err.write")
        : r === "multi"
          ? t("compare.err.multi")
          : t("compare.err.tooMany", { max: MAX_ROWS.toLocaleString() });

  const sideRun = (o: SideOutcome): SideRun => ({
    side: o.result ? toSide(o.result) : null,
    ms: o.result ? Math.max(1, Math.round(o.result.elapsedMs)) : 0,
    error: o.refused
      ? refusalText(o.refused)
      : o.error != null
        ? o.error
        : o.result
          ? null
          : t("ws.sql.noResult"),
  });

  /** Apply a finished run: keep the user's key if it still applies, else suggest one. */
  const land = (next: Run) => {
    setRun(next);
    const a = next.a.side;
    const b = next.b.side;
    if (!a || !b) return;
    const shared = new Set(a.columns.filter((c) => b.columns.includes(c)));
    const kept = key.filter((c) => shared.has(c));
    if (mode === "auto" || (mode === "key" && !kept.length)) {
      const s = suggestKey(a, b);
      setKey(s);
      setMode(s.length ? "key" : "row");
    } else if (mode === "key") setKey(kept);
  };

  const go = () => {
    if (live.current) return;
    const sa = stmtOf(stmtA);
    const sb = stmtOf(sqlB);
    // Refused before anything is sent: neither side runs.
    const ra = refusalOf(sa);
    const rb = refusalOf(sb);
    if (ra || rb) {
      const none: SideRun = { side: null, ms: 0, error: null };
      land({
        sqlA: sa,
        sqlB: sb,
        a: ra ? { ...none, error: refusalText(ra) } : none,
        b: rb ? { ...none, error: refusalText(rb) } : none,
        snapshot: false,
      });
      return;
    }
    const id = `cmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    live.current = id;
    setRunId(id);
    compareRun(handleId, id, sa, sb, schemaName)
      .then((out) => {
        if (live.current !== id || out.cancelled) return;
        land({ sqlA: sa, sqlB: sb, a: sideRun(out.a), b: sideRun(out.b), snapshot: out.snapshot });
      })
      .catch((err: unknown) => {
        if (live.current !== id) return;
        const msg = appErrorMessage(err, t("ws.sql.queryFailed"));
        const failed: SideRun = { side: null, ms: 0, error: msg };
        land({ sqlA: sa, sqlB: sb, a: failed, b: failed, snapshot: false });
      })
      .finally(() => {
        if (live.current !== id) return;
        live.current = null;
        setRunId(null);
      });
  };
  const stop = () => {
    if (live.current) void compareCancel(live.current).catch(() => {});
  };

  // Opening Compare with something to compare against runs it straight away.
  useEffect(() => {
    if (stmtA && sqlB.trim()) go();
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sides = useMemo(
    () => (run?.a.side && run.b.side ? { a: run.a.side, b: run.b.side } : null),
    [run],
  );
  const ready = sides !== null;
  const { diff: d, progress } = useCompareDiff(sides, mode === "key" ? key : [], ordered);
  const busy = runId !== null || progress !== null;

  // Land on the first list that has something in it, after each comparison.
  const landedFor = useRef<object | null>(null);
  useEffect(() => {
    if (d && landedFor.current !== run) {
      landedFor.current = run;
      setTab(firstList(d));
    }
  }, [d, run]);
  // Whole-row mode has no Changed list.
  const shownTab: ListId = d && d.mode !== "key" && tab === "changed" ? firstList(d) : tab;

  const stale = run !== null && (run.sqlA !== stmtOf(stmtA) || run.sqlB !== stmtOf(sqlB));
  const pick = (v: string) => {
    setSrc(v);
    if (v !== "write") setSqlB(cands[+v]?.sql ?? "");
  };
  const toggleKey = (c: string) =>
    setKey((k) => (k.includes(c) ? k.filter((x) => x !== c) : [...k, c]));
  const rowsN = (n: number) => t("compare.rows", { count: n });

  const lists: { id: ListId; label: string; count: number }[] = d
    ? [
        ...(d.mode === "key"
          ? [{ id: "changed" as const, label: t("compare.list.changed"), count: d.counts.changed }]
          : []),
        { id: "onlyA", label: t("compare.list.onlyA"), count: d.counts.onlyA },
        { id: "onlyB", label: t("compare.list.onlyB"), count: d.counts.onlyB },
        { id: "same", label: t("compare.list.same"), count: d.counts.same },
      ]
    : [];
  const onTabKey = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step || !lists.length) return;
    e.preventDefault();
    const at = lists.findIndex((l) => l.id === shownTab);
    const next = lists[(at + step + lists.length) % lists.length]!;
    setTab(next.id);
    (e.currentTarget as HTMLElement)
      .querySelector<HTMLButtonElement>(`[data-list="${next.id}"]`)
      ?.focus();
  };

  const verdict = d ? verdictOf(d) : null;
  const verdictTitle =
    verdict === "noShared"
      ? t("compare.verdict.noShared")
      : verdict === "same"
        ? t("compare.verdict.same")
        : verdict === "colsDiffer"
          ? t("compare.verdict.colsDiffer")
          : verdict === "order"
            ? t("compare.verdict.order")
            : t("compare.verdict.differ");
  const verdictDetail = !d
    ? ""
    : verdict === "noShared"
      ? t("compare.verdict.noSharedDetail")
      : verdict === "same"
        ? d.orderDiffers
          ? t("compare.verdict.sameDetailOrder", { rows: rowsN(d.counts.same) })
          : t("compare.verdict.sameDetail", { rows: rowsN(d.counts.same) })
        : [
            d.counts.changed ? t("compare.part.changed", { rows: rowsN(d.counts.changed) }) : "",
            d.counts.onlyA ? t("compare.part.onlyA", { rows: rowsN(d.counts.onlyA) }) : "",
            d.counts.onlyB ? t("compare.part.onlyB", { rows: rowsN(d.counts.onlyB) }) : "",
            t("compare.part.same", { rows: rowsN(d.counts.same) }),
          ]
            .filter(Boolean)
            .join(" · ") + ".";

  const meta = (s: SideRun | undefined) =>
    s?.side ? `${rowsN(s.side.rows.length)} · ${s.ms} ms` : null;
  const list = d ? (shownTab === "changed" ? d.changed : d[shownTab]) : [];

  return (
    <>
      <div className="sql-result-bar explain-bar">
        {minBtn}
        <button type="button" className="result-tab" onClick={onClose}>
          <Icon name="arrow_back" size={13} /> {t("ws.sql.results")}
        </button>
        <span className="result-tab active">
          <Icon name="compare_arrows" size={13} /> {t("compare.tab")}
        </span>
        <div style={{ flex: 1 }} />
        <span className="dim">{schemaName}</span>
      </div>
      {resultsMin ? null : (
        <div className="cmp">
          {/* ---- the two queries ---- */}
          <div className="cmp-setup">
            <div className={"cmp-q is-a" + (run?.a.error ? " err" : "")}>
              <div className="cmp-q-h">
                <span className="cmp-tag a">A</span>
                <b>{t("compare.a.title")}</b>
                <span className="cmp-q-meta">{meta(run?.a) ?? t("compare.a.where")}</span>
              </div>
              <pre
                className="cmp-sql"
                aria-label={t("compare.a.aria")}
                dangerouslySetInnerHTML={{ __html: highlightSql(maskSql(stmtA)) || " " }}
              />
              {run?.a.error ? (
                <div className="cmp-q-err" role="alert">
                  <Icon name="error" size={14} /> {run.a.error}
                </div>
              ) : null}
            </div>
            <div className={"cmp-q is-b" + (run?.b.error ? " err" : "")}>
              <div className="cmp-q-h">
                <span className="cmp-tag b">B</span>
                <b>{t("compare.b.title")}</b>
                <select
                  className="cmp-src"
                  value={src}
                  onChange={(e) => pick(e.target.value)}
                  aria-label={t("compare.b.srcAria")}
                >
                  {cands.map((h, i) => (
                    <option key={i} value={String(i)}>
                      {(i === 0 ? t("compare.b.previous") : t("compare.b.history")) +
                        " · " +
                        h.sql.replace(/\s+/g, " ").slice(0, SOURCE_CHARS)}
                    </option>
                  ))}
                  <option value="write">{t("compare.b.write")}</option>
                </select>
                <span className="cmp-q-meta">{meta(run?.b) ?? ""}</span>
              </div>
              {/* B is editable and highlighted: the colours are a layer under a
                  see-through text box, as in the prototype. */}
              <div className="cmp-code">
                <pre
                  className="cmp-sql cmp-hl"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: highlightSql(sqlB) + "\n" }}
                />
                <textarea
                  className="cmp-sql cmp-sql-in"
                  value={sqlB}
                  spellCheck={false}
                  rows={1}
                  aria-label={t("compare.b.aria")}
                  placeholder={t("compare.b.placeholder")}
                  onChange={(e) => {
                    setSqlB(e.target.value);
                    setSrc("write");
                  }}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      e.stopPropagation();
                      go();
                    }
                  }}
                />
              </div>
              {run?.b.error ? (
                <div className="cmp-q-err" role="alert">
                  <Icon name="error" size={14} /> {run.b.error}
                </div>
              ) : null}
            </div>
          </div>

          {/* ---- how to match, and go ---- */}
          <div className="cmp-opts">
            <span className="cmp-opts-l">{t("compare.match")}</span>
            <div className="ch-switch" role="radiogroup" aria-label={t("compare.matchAria")}>
              <button
                type="button"
                role="radio"
                aria-checked={mode === "key"}
                className={mode === "key" ? "on" : ""}
                disabled={!ready}
                onClick={() => {
                  setMode("key");
                  if (!key.length && sides) setKey(suggestKey(sides.a, sides.b));
                }}
              >
                <Icon name="key" size={13} /> {t("compare.byKey")}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === "row"}
                className={mode === "row" ? "on" : ""}
                disabled={!ready}
                onClick={() => setMode("row")}
              >
                <Icon name="table_rows" size={13} /> {t("compare.wholeRow")}
              </button>
            </div>
            {mode === "key" && d ? (
              <div className="cmp-keys" role="group" aria-label={t("compare.keyAria")}>
                {d.cols.map((c) => (
                  <button
                    type="button"
                    key={c}
                    className={"cmp-key-chip" + (key.includes(c) ? " on" : "")}
                    aria-pressed={key.includes(c)}
                    onClick={() => toggleKey(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : (
              <span className="cmp-opts-note">
                {mode === "row" ? t("compare.wholeRowNote") : ""}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <label className="cmp-check">
              <Checkbox checked={ordered} onChange={(e) => setOrdered(e.target.checked)} />
              <span>{t("compare.ordered")}</span>
            </label>
            {runId ? (
              <span className="cmp-opts-note cmp-running" role="status">
                <Icon name="progress_activity" size={14} className="cmp-spin" />{" "}
                {t("compare.comparing")}
              </span>
            ) : null}
            {runId ? (
              <Btn small variant="tonal" icon="stop" onClick={stop} title={t("compare.stopTitle")}>
                {t("compare.stop")}
              </Btn>
            ) : (
              <Btn
                small
                variant={stale || !run ? "filled" : "tonal"}
                icon={busy ? "progress_activity" : "compare_arrows"}
                className={busy ? "cmp-busy" : undefined}
                disabled={busy || !stmtA || !sqlB.trim()}
                onClick={go}
                title={t("compare.goTitle")}
              >
                {progress !== null
                  ? t("compare.comparingPct", { pct: Math.round(progress * 100) })
                  : run
                    ? t("compare.again")
                    : t("compare.go")}
              </Btn>
            )}
          </div>

          {runId && !run ? (
            <div className="cmp-empty" role="status">
              <Icon name="progress_activity" size={26} className="cmp-spin" />
              <div>{t("compare.comparing")}</div>
            </div>
          ) : !run ? (
            <div className="cmp-empty">
              <Icon name="compare_arrows" size={30} />
              <div>{t("compare.empty.title")}</div>
              <p>{t("compare.empty.body")}</p>
            </div>
          ) : !ready ? (
            <div className="cmp-empty">
              <Icon name="error" size={28} />
              <div>{t("compare.failed.title")}</div>
              <p>{t("compare.failed.body")}</p>
            </div>
          ) : !d ? (
            <div className="cmp-empty" role="status">
              <Icon name="progress_activity" size={26} className="cmp-spin" />
              <div>{t("compare.comparingPct", { pct: Math.round((progress ?? 0) * 100) })}</div>
            </div>
          ) : (
            <>
              {stale ? (
                <div className="cmp-stale" role="status">
                  <Icon name="history" size={14} /> {t("compare.stale")}
                </div>
              ) : null}
              <div
                className={"cmp-verdict " + (d.identical ? "ok" : "diff")}
                role="status"
                aria-live="polite"
              >
                <Icon name={d.identical ? "check_circle" : "difference"} size={18} />
                <div>
                  <b>{verdictTitle}</b>
                  <span>{verdictDetail}</span>
                </div>
              </div>
              {d.onlyACols.length || d.onlyBCols.length ? (
                <div className="cmp-note">
                  <Icon name="view_column" size={14} />
                  <span>
                    {t("compare.note.cols")}
                    {d.onlyACols.length ? (
                      <span>
                        {" "}
                        <span className="cmp-tag a sm">A</span> {d.onlyACols.join(", ")}
                      </span>
                    ) : null}
                    {d.onlyBCols.length ? (
                      <span>
                        {" "}
                        <span className="cmp-tag b sm">B</span> {d.onlyBCols.join(", ")}
                      </span>
                    ) : null}
                  </span>
                </div>
              ) : null}
              {d.mode === "key" && (d.dupA || d.dupB) ? (
                <div className="cmp-note warn">
                  <Icon name="warning" size={14} />
                  <span>
                    <b>{d.key.join(" + ")}</b>{" "}
                    {t("compare.note.dupes", {
                      where: [
                        d.dupA ? t("compare.note.inA", { rows: rowsN(d.dupA) }) : "",
                        d.dupB ? t("compare.note.inB", { rows: rowsN(d.dupB) }) : "",
                      ]
                        .filter(Boolean)
                        .join(t("compare.note.and")),
                    })}
                  </span>
                </div>
              ) : null}
              {mode === "key" && !key.length ? (
                <div className="cmp-note warn">
                  <Icon name="warning" size={14} /> {t("compare.note.noKey")}
                </div>
              ) : null}

              {!d.noShared ? (
                <>
                  <div
                    className="cmp-tabs"
                    role="tablist"
                    aria-label={t("compare.listsAria")}
                    onKeyDown={onTabKey}
                  >
                    {lists.map((l) => (
                      <button
                        type="button"
                        key={l.id}
                        id={`cmp-list-${l.id}`}
                        data-list={l.id}
                        role="tab"
                        aria-selected={shownTab === l.id}
                        tabIndex={shownTab === l.id ? 0 : -1}
                        className={"cmp-tab " + l.id + (shownTab === l.id ? " on" : "")}
                        onClick={() => setTab(l.id)}
                      >
                        {l.label} <b>{l.count.toLocaleString()}</b>
                      </button>
                    ))}
                  </div>
                  {!list.length ? (
                    <div
                      className="cmp-none"
                      role="tabpanel"
                      aria-labelledby={`cmp-list-${shownTab}`}
                    >
                      {t(
                        shownTab === "changed"
                          ? "compare.none.changed"
                          : shownTab === "onlyA"
                            ? "compare.none.onlyA"
                            : shownTab === "onlyB"
                              ? "compare.none.onlyB"
                              : "compare.none.same",
                      )}
                    </div>
                  ) : (
                    <>
                      {shownTab === "changed" ? (
                        <CmpTable
                          cols={d.cols}
                          pairs={d.changed}
                          keyCols={d.key}
                          label={t("compare.sideAria")}
                          labelledBy="cmp-list-changed"
                        />
                      ) : (
                        <CmpTable
                          cols={d.cols}
                          rows={d[shownTab]}
                          side={shownTab === "onlyA" ? "a" : shownTab === "onlyB" ? "b" : null}
                          keyCols={d.key}
                          label={t("compare.sideAria")}
                          labelledBy={`cmp-list-${shownTab}`}
                        />
                      )}
                      {list.length > SHOW_ROWS ? (
                        <div className="cmp-more">
                          {t("compare.more", {
                            shown: SHOW_ROWS,
                            total: list.length.toLocaleString(),
                          })}
                        </div>
                      ) : null}
                    </>
                  )}
                </>
              ) : null}
              <div className="cmp-foot">
                <Icon name="info" size={13} />
                <span>
                  {t("compare.foot.rule")}
                  {/* The second sentence only holds when both did not read one snapshot. */}
                  {run.snapshot ? null : " " + t("compare.foot.racy")}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
