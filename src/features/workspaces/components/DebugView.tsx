// Query debug mode (M45) — ported from the prototype's debugger.jsx (DebugView)
// and editor.jsx (the debug bar). Lives in the SQL tab's results area while
// debug mode is on: the step list on the left, the selected step's sentence,
// notes, per-condition counts and rows on the right.
//
// Everything said here comes from `debugModel` as `{ key, vars }` messages;
// `Rich` renders the `**bold**` and `code` spans the sentences carry.

import { Fragment, useEffect, useRef, type ReactNode } from "react";

import type { QueryResult } from "../../../shared/api/engine";
import { fmtNumber } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import {
  condRowsOf,
  headOf,
  notesOf,
  SAMPLE_BASE_ROWS,
  type Msg,
  type MsgArg,
  type Sampling,
  type Stage,
} from "../debugModel";
import { DEBUG_SAMPLE_ROWS, type CannotDebug, type WriteInfo } from "../debugServer";
import type { BigTableAsk } from "../hooks/useQueryDebug";
import { SqlResultGrid } from "./SqlResultGrid";
import "./DebugView.css";

type T = ReturnType<typeof useT>;

/** Resolve a message and its nested messages to text. Only `count` stays a
 *  raw number (it drives the plural); other numbers get locale grouping. */
function render(t: T, m: Msg): string {
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m.vars ?? {}) as [string, MsgArg][]) {
    if (typeof v === "object") vars[k] = render(t, v);
    else if (typeof v === "number" && k !== "count") vars[k] = fmtNumber(v);
    else vars[k] = v;
  }
  return t(m.key, vars);
}

/** `code` and **bold** spans in step text. Raw text, never HTML. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 1 ? (
          <code key={i}>{p.slice(1, -1)}</code>
        ) : p.startsWith("**") && p.endsWith("**") && p.length > 3 ? (
          <b key={i}>{p.slice(2, -2)}</b>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

const CANNOT_KEY = {
  empty: "debug.cannot.empty",
  multiple: "debug.cannot.multiple",
  notSelect: "debug.cannot.notSelect",
  noFrom: "debug.cannot.noFrom",
  parse: "debug.cannot.parse",
  multipleTargets: "debug.cannot.multipleTargets",
  unreadableWrite: "debug.cannot.unreadableWrite",
} as const;

/** Centred message for the states with no steps to show. */
function Centre({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="dbg-empty" role="status">
      <Icon name={icon} size={30} />
      <div className="dbg-empty-t">{title}</div>
      {children}
    </div>
  );
}

export function DebugCannot({ cannot }: { cannot: CannotDebug }) {
  const t = useT();
  return (
    <Centre icon="bug_report" title={t("debug.cannot.title")}>
      <p>
        {cannot.reason === "parse"
          ? t(CANNOT_KEY.parse, { message: cannot.message })
          : t(CANNOT_KEY[cannot.reason])}
      </p>
    </Centre>
  );
}

export function DebugPlanning() {
  const t = useT();
  return <Centre icon="hourglass_top" title={t("debug.planning")} />;
}

/** The big-table question (task A5): Run / Run on a sample / Cancel. */
export function DebugBigTable({
  ask,
  onRun,
  onCancel,
}: {
  ask: BigTableAsk;
  onRun: (sampled: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="dbg-empty" role="alertdialog" aria-label={t("debug.big.title")}>
      <Icon name="warning" size={30} style={{ color: "var(--warn)" }} />
      <div className="dbg-empty-t">{t("debug.big.title")}</div>
      <p>
        <Rich
          text={t("debug.big.body", {
            table: ask.table,
            n: fmtNumber(ask.rows),
            queries: fmtNumber(ask.queries),
          })}
        />
      </p>
      {ask.canSample ? (
        <p>
          <Rich
            text={t("debug.big.sampleHint", { n: fmtNumber(SAMPLE_BASE_ROWS), table: ask.table })}
          />
        </p>
      ) : null}
      <div className="dbg-big-actions">
        <Btn variant="text" small onClick={onCancel}>
          {t("common.cancel")}
        </Btn>
        {ask.canSample ? (
          <Btn variant="tonal" small onClick={() => onRun(true)}>
            {t("debug.big.sample")}
          </Btn>
        ) : null}
        <Btn variant="filled" small onClick={() => onRun(false)} autoFocus>
          {t("debug.big.run")}
        </Btn>
      </div>
    </div>
  );
}

export function DebugView({
  stages,
  idx,
  setIdx,
  max,
  running,
  sampling,
  write,
  onOpenQuery,
}: {
  stages: Stage[];
  idx: number;
  setIdx: (i: number) => void;
  max: number;
  /** The run is still going: steps without an outcome are not "stopped". */
  running: boolean;
  sampling: Sampling | null;
  /** Set for an UPDATE / DELETE dry run. */
  write: WriteInfo | null;
  onOpenQuery: (sql: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the current step in view: a column when wide, a strip when narrow.
  useEffect(() => {
    const box = listRef.current;
    const el = box?.querySelector<HTMLElement>(".dbg-step.on");
    if (!box || !el) return;
    const top = el.offsetTop - box.offsetTop;
    const bot = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bot > box.scrollTop + box.clientHeight) box.scrollTop = bot - box.clientHeight;
    const left = el.offsetLeft - box.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < box.scrollLeft) box.scrollLeft = Math.max(0, left - 8);
    else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth + 8;
  }, [idx]);

  const st = stages[idx] ?? stages[0];
  if (!st) return null;
  const star = sampling ? "*" : "";

  const copy = () => {
    void navigator.clipboard.writeText(st.step.sql).then(
      () => toast(t("debug.copied"), "ok"),
      () => {},
    );
  };

  const head = headOf(st, sampling, write);
  const notes = notesOf(st, write);
  const isWrite = st.step.key === "write" && write != null;
  const conds = condRowsOf(st);
  const incoming = st.prev ?? 0;
  const result: QueryResult | null =
    st.outcome && st.status === "done"
      ? {
          columns: st.outcome.columns,
          rows: st.outcome.rows,
          rowCount: st.outcome.rows.length,
          truncated: false,
          elapsedMs: st.outcome.ms,
        }
      : null;

  return (
    <div className="dbg">
      <div className="dbg-steps" ref={listRef} role="listbox" aria-label={t("debug.list.aria")}>
        <div className="dbg-steps-h">
          {t("debug.list.head")} <span>{t("debug.list.headSub")}</span>
        </div>
        {stages.map((s, i) => {
          const d = s.count != null && s.prev != null ? s.count - s.prev : null;
          const bad = s.status === "error" || (s.count === 0 && (s.prev ?? 0) > 0);
          const idle = s.status === "skipped" || (!running && s.status === "pending");
          return (
            <button
              type="button"
              key={s.step.key}
              role="option"
              aria-selected={i === idx}
              aria-label={t("debug.stepAria", { n: i + 1, kw: s.step.kw })}
              className={
                "dbg-step" +
                (i === idx ? " on" : "") +
                (i > idx ? " ahead" : "") +
                (bad ? " bad" : "") +
                (idle || s.status === "cancelled" ? " skipped" : "")
              }
              onClick={() => setIdx(i)}
            >
              <span className="dbg-step-n">{i + 1}</span>
              <span className="dbg-step-main">
                <span className="dbg-step-kw">{s.step.kw}</span>
                <span className="dbg-step-text">{s.step.text}</span>
                <span className="dbg-step-bar">
                  <i
                    style={{
                      transform: `scaleX(${s.count ? Math.max(0.02, s.count / max) : 0})`,
                    }}
                  />
                </span>
              </span>
              <span className="dbg-step-count">
                {s.status === "error" ? (
                  <b className="dbg-bad">{t("debug.count.error")}</b>
                ) : s.status === "running" ? (
                  <span className="dbg-spin" aria-label={t("debug.stepRunning")} />
                ) : s.count == null ? (
                  <b>—</b>
                ) : (
                  <b>
                    {fmtNumber(s.count)}
                    {star}
                  </b>
                )}
                {d ? (
                  <em className={d < 0 ? "down" : "up"}>
                    {d < 0 ? "−" : "+"}
                    {fmtNumber(Math.abs(d))}
                  </em>
                ) : s.count != null ? (
                  <em>{i === 0 ? t("debug.delta.rows") : t("debug.delta.same")}</em>
                ) : null}
              </span>
            </button>
          );
        })}
        <div className="dbg-steps-f">
          <Icon name="shield" size={13} />{" "}
          <span>
            {t("debug.list.foot")}
            {sampling ? (
              <>
                {" "}
                {t("debug.list.sampled", { n: fmtNumber(sampling.rows), table: sampling.table })}
              </>
            ) : null}
          </span>
        </div>
      </div>

      <div className="dbg-detail">
        <div className="dbg-head">
          <div className="dbg-head-kw">
            <span>{idx + 1}</span>
            {st.step.kw}
          </div>
          <div className="dbg-headline" role={st.status === "error" ? "alert" : undefined}>
            {st.status === "error" ? (
              <span className="dbg-bad">
                {t("debug.fails", { message: st.outcome?.error ?? "" })}
              </span>
            ) : st.status === "skipped" ? (
              t("debug.notReached")
            ) : st.status === "cancelled" || (!running && st.status === "pending") ? (
              t("debug.stopped")
            ) : st.status !== "done" ? (
              <span className="dbg-dim">{t("debug.stepRunning")}</span>
            ) : head ? (
              <Rich text={render(t, head)} />
            ) : null}
          </div>
          <div className="dbg-head-actions">
            <button type="button" className="dbg-link" onClick={copy} title={st.step.sql}>
              <Icon name="content_copy" size={13} /> {t("debug.copy")}
            </button>
            <button
              type="button"
              className="dbg-link"
              onClick={() => onOpenQuery(st.step.sql + ";")}
            >
              <Icon name="open_in_new" size={13} /> {t("debug.open")}
            </button>
          </div>
        </div>

        {notes.map((n, i) => (
          <div key={i} className={"dbg-note" + (n.tone === "info" ? "" : " " + n.tone)}>
            <Icon
              name={n.tone === "warn" ? "warning" : n.tone === "ok" ? "check_circle" : "info"}
              size={15}
            />
            <span>
              <Rich text={render(t, n)} />
            </span>
          </div>
        ))}

        {conds && st.count != null ? (
          <div className="dbg-conds">
            <div className="dbg-conds-h">
              {t("debug.conds.head")}{" "}
              <span>{t("debug.conds.headSub", { n: fmtNumber(incoming) })}</span>
            </div>
            {conds.map((c, i) => (
              <div key={i} className="dbg-cond">
                <code title={c.text}>{c.text}</code>
                <span className="dbg-cond-bar">
                  <i
                    style={{
                      width: incoming ? Math.round(((c.keeps ?? 0) / incoming) * 100) + "%" : 0,
                    }}
                  />
                </span>
                <span className="dbg-cond-n">
                  <Rich
                    text={t("debug.conds.keeps", {
                      n: c.keeps == null ? "?" : fmtNumber(c.keeps),
                    })}
                  />
                </span>
                <span className={"dbg-cond-d" + (c.keeps === 0 ? " zero" : "")}>
                  {c.keeps == null ? "" : "−" + fmtNumber(incoming - c.keeps)}
                </span>
              </div>
            ))}
            <div className="dbg-cond total">
              <code>{t("debug.conds.all")}</code>
              <span className="dbg-cond-bar">
                <i
                  style={{
                    width: incoming ? Math.round((st.count / incoming) * 100) + "%" : 0,
                  }}
                />
              </span>
              <span className="dbg-cond-n">
                <Rich text={t("debug.conds.keeps", { n: fmtNumber(st.count) })} />
              </span>
              <span className="dbg-cond-d">−{fmtNumber(incoming - st.count)}</span>
            </div>
          </div>
        ) : null}

        {result && st.count != null ? (
          <div className="dbg-rows">
            <div className="dbg-rows-h">
              {isWrite
                ? t(write.kind === "delete" ? "debug.rows.headDelete" : "debug.rows.headUpdate")
                : t("debug.rows.head")}{" "}
              <em className="dbg-ro">
                <Icon name="lock" size={11} /> {t("debug.rows.ro")}
              </em>
              {isWrite && write.preview ? <span> · {t("debug.rows.preview")}</span> : null}
              {st.count > DEBUG_SAMPLE_ROWS ? (
                <span>
                  {" · "}
                  {t("debug.rows.capped", {
                    n: fmtNumber(DEBUG_SAMPLE_ROWS),
                    total: fmtNumber(st.count),
                  })}
                </span>
              ) : null}
            </div>
            {st.count > 0 ? (
              // No `editing` prop: the grid is inert, and its JSON / blob
              // viewers open read-only.
              <SqlResultGrid result={result} />
            ) : (
              <div className="dbg-norows">{t("debug.rows.none")}</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
