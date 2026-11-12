// The assistant drawer (M44 Tasks C1–C12) — ported from the prototype's
// `AiPanel`. One chat thread per SQL tab for write / change / explain / plan /
// index. It reuses the `.sq-drawer` pattern at 420px with NO scrim, so the
// editor stays usable beside it.
//
// Every message goes the same way: the backend builds the exact prompt
// (`assistantPrepare`), the thread shows it as a dashed bubble with the review
// card, and Send hands that same prompt id back to be sent. Review is skipped
// only when `aiReview` is off AND there are no rows AND the workspace is not
// production. Nothing here executes SQL: "Use in editor" replaces the editor
// text, and index DDL only ever opens in a new query tab.

import { useEffect, useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import type { Engine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { highlightSql } from "../../browse/shared/highlightSql";
import { useWorkspacesStore } from "../../workspaces/state";
import { aiSettingsOf, assistantDiscard, assistantPrepare, type SchemaTable } from "../api";
import { useAssistant } from "../hooks/useAssistant";
import {
  aiIntent,
  bullets,
  mentionedTables,
  modelKeyOf,
  prevWordStart,
  parseIndexAnswer,
  parseSqlAnswer,
  replaceTrigger,
  runtimeOf,
  sameSql,
  slot,
  startersFor,
  triggerAt,
  actionsFor,
  languageOf,
  validateFor,
  type AiConn,
  type AiKind,
  type Language,
  type Trigger,
} from "../logic";

/** Plain text into HTML, for code that isn't SQL (no highlighter for it). */
const escHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
import { modelsKey, schemaKey, useAssistantStore, type AiMsg, type Msg } from "../state";
import { AiAlphaTag, AiFill, AiPromptSummary, AiPromptView, AiRich } from "./AiBits";
import { AiLockCard } from "./AiLockCard";
import { AiModelRow } from "./AiModelRow";
import { AiSessionList } from "./AiSessionList";
import { AiSuggest, type Suggestion } from "./AiSuggest";
import { openAiSettings } from "../openSettings";
import "./Assistant.css";

type Action = { id: "explain" | "plan" | "index"; icon: string; key: "explain" | "plan" | "index" };
const ACTIONS: Action[] = [
  { id: "explain", icon: "menu_book", key: "explain" },
  { id: "plan", icon: "account_tree", key: "plan" },
  { id: "index", icon: "bolt", key: "index" },
];

/** The SQL an ask answer leaves as the thread's draft (C9: an unchanged
 *  follow-up keeps the previous one). */
function draftOf(m: AiMsg, lang: Language): string | null {
  if (m.kind !== "ask" || m.st !== "done") return null;
  const a = parseSqlAnswer(m.raw, lang);
  if (!a.sql) return m.prevSql;
  if (m.prevSql && sameSql(a.sql, m.prevSql)) return m.prevSql;
  return a.sql;
}

function lastDraft(msgs: Msg[], lang: Language): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "ai") {
      const d = draftOf(m, lang);
      if (d) return d;
    }
  }
  return null;
}

/** Paragraphs of a prose answer, each with inline `code` / **bold**. */
function Prose({ text }: { text: string }) {
  const list = bullets(text);
  if (list) {
    return (
      <ul className="ai-say">
        {list.map((b, i) => (
          <li key={i}>
            <AiRich text={b} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <>
      {text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p, i) => (
          <div key={i} className="ai-say">
            <AiRich text={p.replace(/\n/g, " ")} />
          </div>
        ))}
    </>
  );
}

export interface PlanRequest {
  nonce: number;
  sql: string;
}

/** A question handed in from outside the drawer (the command palette). */
export interface AskRequest {
  nonce: number;
  text: string;
}

interface AiPanelProps {
  tabId: string;
  /** The workspace whose chat sessions this drawer shows. */
  wsKey: string;
  open: boolean;
  onClose: () => void;
  conn: AiConn;
  handleId: string;
  schemaName: string;
  engine: Engine;
  /** The editor's statement at the caret (or the selection / whole buffer). */
  getSql: () => string;
  hasSql: boolean;
  /** Bumped to focus the message box (⌘I, the Ask button). */
  askNonce: number;
  /** "Explain this plan" on the Explain tab: ask the plan question for you. */
  planRequest: PlanRequest | null;
  askRequest: AskRequest | null;
  onAccept: (sql: string) => void;
  /** "Use in editor" by default; a host whose target is a terminal or a form
   *  names it ("Use in terminal"). */
  useLabel?: string;
  usedLabel?: string;
  /** A second place an answer can go, offered beside the first when it
   *  `applies` — MongoDB's "Build in Aggregation tab" for an aggregate. */
  altAction?: AiAltAction;
}

export interface AiAltAction {
  label: string;
  icon: string;
  applies: (code: string) => boolean;
  run: (code: string) => void;
}

export function AiPanel({
  tabId,
  wsKey,
  open,
  onClose,
  conn,
  handleId,
  schemaName,
  engine,
  getSql,
  hasSql,
  askNonce,
  planRequest,
  askRequest,
  onAccept,
  useLabel,
  usedLabel,
  altAction,
}: AiPanelProps) {
  const t = useT();
  const toast = useToast();
  const { s, setAi, state, d, isProd, rowsAllowed: canRows } = useAssistant(conn);
  // The workspace's active session; none until the first message starts one.
  const sid = useAssistantStore((st) => st.sessions[wsKey]?.active ?? null);
  const th =
    useAssistantStore((st) => (sid ? st.threads[sid] : undefined)) ??
    useAssistantStore.getState().thread(null);
  const ensureSession = useAssistantStore((st) => st.ensureSession);
  const newSession = useAssistantStore((st) => st.newSession);
  const [showHistory, setShowHistory] = useState(false);
  const cur = sid ?? "";
  const patch = useAssistantStore((st) => st.patch);
  const patchMsg = useAssistantStore((st) => st.patchMsg);
  const deliver = useAssistantStore((st) => st.deliver);
  const cancelStream = useAssistantStore((st) => st.cancel);
  const loadSchema = useAssistantStore((st) => st.loadSchema);
  const key = schemaKey(handleId, schemaName);
  const tables = useAssistantStore((st) => st.schemas[key]);
  const all: SchemaTable[] = useMemo(() => tables ?? [], [tables]);

  const [text, setText] = useState("");
  // The `@` / `/` token under the caret, and the highlighted suggestion.
  const [trig, setTrig] = useState<Trigger | null>(null);
  const [sugIdx, setSugIdx] = useState(0);
  const [rowData, setRowData] = useState(false);
  const [scope, setScope] = useState<string[] | null>(null); // null = all tables
  const [scopeOpen, setScopeOpen] = useState(false);
  const inRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const busy = th.streaming !== null || th.preparing;
  const draft = lastDraft(th.msgs, languageOf(engine));
  const uid = "ai-in-" + tabId;

  // Structure only: names of tables and columns, for the scope chip and the
  // local check of generated SQL.
  useEffect(() => {
    if (open && state === "on") void loadSchema(handleId, schemaName);
  }, [open, state, handleId, schemaName, loadSchema]);
  useEffect(() => setScope(null), [schemaName]);

  // The tables checklist closes on a click outside it (or its chip) and on Esc,
  // like the app's other popovers — it must not sit over the composer.
  useEffect(() => {
    if (!scopeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(".ai-pop-anchor")) setScopeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setScopeOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [scopeOpen]);

  // Never let focus or auto-scroll move anything but the thread itself: a
  // plain focus() or scrollIntoView() while the drawer slides in scrolls the
  // clipped editor area sideways and drags the closed drawers into view. So:
  // focus only after the slide-in, with preventScroll, and scroll the thread
  // by its own scrollTop.
  useEffect(() => {
    if (!(open && state === "on")) return;
    const timer = setTimeout(() => inRef.current?.focus({ preventScroll: true }), 240);
    return () => clearTimeout(timer);
  }, [open, askNonce, state]);
  const lastRaw = th.msgs.length ? (th.msgs[th.msgs.length - 1] as AiMsg).raw : "";
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [th.msgs.length, th.pending, busy, lastRaw]);
  useEffect(() => {
    if (th.pending) sendRef.current?.focus({ preventScroll: true });
  }, [th.pending]);

  const scopeNames = scope ?? all.map((x) => x.name);

  /** Every message goes through here: build the exact prompt, then review or send. */
  const submit = (
    kind: AiKind,
    say: string,
    req: string,
    sqlOverride?: string,
    focus: string[] = [],
  ) => {
    if (busy || th.pending) return;
    const prevSql = kind === "ask" ? draft : null;
    const sql = kind === "ask" ? "" : (sqlOverride ?? getSql());
    const withRows = kind === "ask" && rowData && canRows;
    setText("");
    const at = sid ?? ensureSession(wsKey);
    patch(at, { preparing: true });
    assistantPrepare(
      {
        handleId,
        schema: schemaName,
        kind,
        scope: scope ?? [],
        focus,
        request: req,
        sql,
        prevSql,
        rowData: withRows,
        connectionId: conn.id,
      },
      aiSettingsOf(s),
    )
      .then((prompt) => {
        const pending = { kind, say, req, prevSql, sql, prompt };
        const rows = prompt.rowTables.length > 0;
        if (s.aiReview || rows || isProd) {
          patch(at, { preparing: false, pending, peek: rows });
        } else {
          patch(at, { preparing: false, pending });
          setRowData(false);
          deliver(at);
        }
      })
      .catch((err: unknown) => {
        patch(at, { preparing: false });
        if (kind === "ask") setText(req);
        toast(appErrorMessage(err, t("ai.err.prepare")), "err");
      });
  };

  const tableNames = all.map((x) => x.name);
  // What this workspace speaks: SQL keeps the prototype's surfaces; the other
  // languages get the same drawer in their own words.
  const lang = languageOf(engine);
  const actions = ACTIONS.filter((a) => actionsFor(lang).includes(a.id));
  const noun: "tables" | "collections" | "keys" =
    lang === "mongo" || lang === "typesense" ? "collections" : lang === "redis" ? "keys" : "tables";
  // Tables the message being typed @-mentions: they, not the ticks, decide
  // what this message sends — the chip says so.
  const mentioned = mentionedTables(text, tableNames);
  const sendText = () => {
    const v = text.trim();
    if (!v) return;
    setTrig(null);
    // @-mentioned tables focus this message's structure (backend adds their
    // foreign-key targets); no mention = the tables chip decides.
    submit(aiIntent(v, hasSql), v, v, undefined, mentionedTables(v, tableNames));
  };

  // ---- @ tables · / commands and models ----
  const runtime = runtimeOf(s);
  const modelReport = useAssistantStore((st) => st.models[modelsKey(aiSettingsOf(s))]);
  const loadModels = useAssistantStore((st) => st.loadModels);
  const slashOpen = trig?.sign === "/";
  useEffect(() => {
    if (slashOpen) void loadModels(aiSettingsOf(s), conn.id);
    // Fetch once per opening of the / list, not per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashOpen]);

  const readTrig = (el: HTMLTextAreaElement) => {
    const next = triggerAt(el.value, el.selectionStart ?? el.value.length);
    if (next?.sign !== trig?.sign || next?.start !== trig?.start) setSugIdx(0);
    setTrig(next);
  };
  /** Swap the trigger token for `insert` and put the caret after it. */
  const fill = (insert: string) => {
    if (!trig) return;
    const r = replaceTrigger(text, trig.start + 1 + trig.query.length, trig, insert);
    setText(r.text);
    setTrig(null);
    requestAnimationFrame(() => inRef.current?.setSelectionRange(r.caret, r.caret));
  };
  const q = (trig?.query ?? "").toLowerCase();
  const suggestions: Suggestion[] = (() => {
    if (!trig) return [];
    if (trig.sign === "@") {
      // Redis key patterns aren't names a message can mention.
      if (lang === "redis") return [];
      return all
        .filter((tb) => tb.name.toLowerCase().includes(q))
        .sort((a, b) => +!a.name.toLowerCase().startsWith(q) - +!b.name.toLowerCase().startsWith(q))
        .slice(0, 50)
        .map((tb) => ({
          id: "t:" + tb.name,
          group: noun === "collections" ? t("ai.suggest.collections") : t("ai.suggest.tables"),
          icon: "table",
          label: tb.name,
          hint: t("ai.scope.cols", { count: tb.columns.length }),
          run: () => fill("@" + tb.name + " "),
        }));
    }
    const command = (
      name: string,
      icon: string,
      label: string,
      run: () => void,
      disabled = false,
    ): Suggestion => ({
      id: "c:" + name,
      group: t("ai.suggest.commands"),
      icon,
      label,
      hint: disabled ? t("ai.quick.empty") : "/" + name,
      disabled,
      run: () => {
        fill("");
        run();
      },
    });
    const quick = !hasSql || busy || !!th.pending;
    const commands: Suggestion[] = [
      command("explain", "menu_book", t("ai.act.explain.t"), () => act(ACTIONS[0]!), quick),
      ...(lang === "sql"
        ? [
            command("plan", "account_tree", t("ai.act.plan.t"), () => act(ACTIONS[1]!), quick),
            command("index", "bolt", t("ai.act.index.t"), () => act(ACTIONS[2]!), quick),
          ]
        : []),
      command("new", "add_comment", t("ai.slash.new"), () => newSession(wsKey)),
      command("history", "history", t("ai.sessions.title"), () => setShowHistory(true)),
      ...(canRows
        ? [
            command(
              "rows",
              rowData ? "visibility_off" : "table_view",
              rowData ? t("ai.slash.rowsOff") : t("ai.slash.rowsOn"),
              () => setRowData((v) => !v),
            ),
          ]
        : []),
      command("settings", "settings", t("ai.settings"), openAiSettings),
    ].filter((c) => c.id.slice(2).startsWith(q) || c.label.toLowerCase().includes(q));
    const models: Suggestion[] = (modelReport?.models ?? [])
      .filter((m) => m.name.toLowerCase().includes(q))
      .map((m) => ({
        id: "m:" + m.name,
        group: t("ai.suggest.models"),
        icon: m.name === d.model ? "radio_button_checked" : "radio_button_unchecked",
        label: m.name,
        hint: m.name === d.model ? t("ai.suggest.current") : undefined,
        run: () => {
          fill("");
          setAi(modelKeyOf(runtime), m.name);
        },
      }));
    return [...commands, ...models];
  })();
  const sugOpen = trig !== null;
  const sugId = uid + "-sug";
  const activeSug = suggestions[Math.min(sugIdx, Math.max(0, suggestions.length - 1))];
  const act = (a: Action, sqlOverride?: string) =>
    submit(a.id, t(`ai.act.${a.key}.say`), t(`ai.act.${a.key}.say`), sqlOverride);

  // "Explain this plan" on the Explain tab asks the plan question through the
  // normal review path.
  const lastPlan = useRef(0);
  useEffect(() => {
    if (!planRequest || planRequest.nonce === lastPlan.current || state !== "on") return;
    lastPlan.current = planRequest.nonce;
    act(ACTIONS[1]!, planRequest.sql);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planRequest, state]);

  // A question from the palette goes through the same review path as a typed
  // one: routed by intent, reviewed before sending unless review is off.
  const lastAsk = useRef(0);
  useEffect(() => {
    if (!askRequest || askRequest.nonce === lastAsk.current || state !== "on") return;
    lastAsk.current = askRequest.nonce;
    submit(
      aiIntent(askRequest.text, hasSql),
      askRequest.text,
      askRequest.text,
      undefined,
      mentionedTables(askRequest.text, tableNames),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askRequest, state]);

  const copy = (v: string) => {
    void navigator.clipboard.writeText(v).then(
      () => toast(t("ai.copied"), "ok"),
      () => toast(t("ai.copyFail"), "err"),
    );
  };
  // SQL-family code is highlighted; mongosh / HTTP / Redis lines are shown as
  // they are (the SQL highlighter would colour their words wrongly).
  const hl = (v: string) => ({
    __html: lang === "sql" || lang === "cql" || lang === "partiQl" ? highlightSql(v) : escHtml(v),
  });

  const answer = (m: AiMsg) => {
    if (m.st === "load" && !m.raw)
      return (
        <div className="ai-typing" aria-label={t("ai.working")}>
          <i />
          <i />
          <i />
          <span>{d.model || d.via}</span>
        </div>
      );
    if (m.st === "neterr")
      return (
        <div className="ai-note warn">
          <Icon name="wifi_off" size={15} />{" "}
          <span>
            {d.local
              ? t("ai.net.local", { host: d.host, via: d.via })
              : t("ai.net.offline", { host: d.host })}{" "}
            <button type="button" className="ai-link" onClick={openAiSettings}>
              {d.local ? t("ai.openSettings") : t("ai.net.switch")}
            </button>
          </span>
        </div>
      );
    if (m.st === "setup")
      return (
        <div className="ai-note warn">
          <Icon name="link_off" size={15} />{" "}
          <span>
            {d.custom ? t("ai.setup.custom") : t("ai.setup.url")}{" "}
            <button type="button" className="ai-link" onClick={openAiSettings}>
              {t("ai.setup.finish")}
            </button>
          </span>
        </div>
      );
    if (m.st === "error")
      return (
        <div className="ai-note warn">
          <Icon name="error" size={15} /> <span>{m.error}</span>
        </div>
      );
    const streaming = m.st === "load";
    const stopped =
      m.st === "cancelled" ? (
        <div className="ai-note">
          <Icon name="stop_circle" size={15} /> <span>{t("ai.stopped")}</span>
        </div>
      ) : null;

    if (m.kind === "ask") {
      const a = parseSqlAnswer(m.raw, lang);
      const follow = !!m.prevSql;
      const unchanged = !streaming && follow && (!a.sql || sameSql(a.sql, m.prevSql!));
      if (!streaming && !a.sql && !follow)
        return (
          <>
            <Prose text={a.note || m.raw} />
            {stopped}
          </>
        );
      const sql = unchanged ? m.prevSql! : (a.sql ?? "");
      const check = streaming || unchanged ? null : validateFor(lang, sql, all, engine);
      return (
        <>
          <div className="ai-say">
            {unchanged ? t("ai.ask.unchanged") : follow ? t("ai.ask.updated") : t("ai.ask.lead")}
          </div>
          <pre className="ai-code" dangerouslySetInnerHTML={hl(sql)} />
          {!unchanged && a.assumptions.length ? (
            // A real model writes its assumptions as sentences, not the
            // prototype's two-word tags, so they read as a wrapping list.
            <div className="ai-assume ai-assume-list">
              <span className="ai-assume-l">
                {follow ? t("ai.ask.changed") : t("ai.ask.assumed")}
              </span>
              <ul>
                {a.assumptions.map((x) => (
                  <li key={x}>
                    <AiRich text={x} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {!streaming && a.note && !unchanged ? <Prose text={a.note} /> : null}
          {check ? (
            check.write ? (
              <div className="ai-valid bad">
                <Icon name="edit" size={14} /> {t("ai.valid.write")}
              </div>
            ) : check.parseError ? (
              <div className="ai-valid bad">
                <Icon name="warning" size={14} /> {t("ai.valid.parse", { why: check.parseError })}
              </div>
            ) : check.unknown.length ? (
              <div className="ai-valid bad">
                <Icon name="warning" size={14} />{" "}
                {t("ai.valid.unknown", { schema: schemaName, names: check.unknown.join(", ") })}
              </div>
            ) : (
              <div className="ai-valid">
                <Icon name="verified" size={14} /> {t("ai.valid.ok", { schema: schemaName })}
              </div>
            )
          ) : null}
          {stopped}
          {!streaming && sql ? (
            <div className="ai-msg-actions">
              <Btn
                variant={m.used ? "text" : "filled"}
                small
                icon={m.used ? "check" : "keyboard_return"}
                onClick={() => {
                  onAccept(sql);
                  patchMsg(cur, m.id, { used: true });
                }}
              >
                {m.used ? (usedLabel ?? t("ai.ask.inEditor")) : (useLabel ?? t("ai.ask.use"))}
              </Btn>
              {altAction?.applies(sql) ? (
                <Btn
                  variant="text"
                  small
                  icon={altAction.icon}
                  onClick={() => {
                    altAction.run(sql);
                    patchMsg(cur, m.id, { used: true });
                  }}
                >
                  {altAction.label}
                </Btn>
              ) : null}
              <Btn variant="text" small icon="content_copy" onClick={() => copy(sql)}>
                {t("ai.copy")}
              </Btn>
              <span className="ai-grow" />
              {m.took != null ? (
                <span className="ai-meta">{(m.took / 1000).toFixed(1)} s</span>
              ) : null}
            </div>
          ) : null}
        </>
      );
    }

    if (m.kind === "index" && !streaming) {
      const r = parseIndexAnswer(m.raw, all);
      return (
        <>
          {r.outcome === "exists" ? (
            <div className="ai-verdict">
              <Icon name="check_circle" size={15} /> {t("ai.idx.exists")}
            </div>
          ) : null}
          {r.outcome === "none" ? (
            <div className="ai-verdict">
              <Icon name="do_not_disturb_on" size={15} /> {t("ai.idx.none")}
            </div>
          ) : null}
          {r.outcome === "ddl" ? (
            <pre className="ai-code" dangerouslySetInnerHTML={hl(r.ddl)} />
          ) : null}
          {r.why ? <Prose text={r.why} /> : null}
          {stopped}
          {r.outcome === "ddl" ? (
            <div className="ai-msg-actions">
              <Btn
                variant="tonal"
                small
                icon="open_in_new"
                onClick={() => useWorkspacesStore.getState().openSqlTabWith(r.ddl)}
              >
                {t("ai.idx.open")}
              </Btn>
              <Btn variant="text" small icon="content_copy" onClick={() => copy(r.ddl)}>
                {t("ai.copy")}
              </Btn>
              <span className="ai-grow" />
              <span className="ai-est" title={t("ai.idx.estTitle")}>
                {t("ai.idx.est")}
              </span>
            </div>
          ) : null}
        </>
      );
    }

    // explain / plan (and an index answer still streaming)
    return (
      <>
        {m.planNote ? (
          <div className="ai-say ai-warn-t">{t("ai.plan.unavailable", { why: m.planNote })}</div>
        ) : null}
        <Prose text={m.raw} />
        {stopped}
      </>
    );
  };

  const prodNote = isProd ? (
    <div className="ai-prodnote">
      <Icon name="public" size={15} />
      <span>
        <AiFill
          text={t("ai.prod.note", { allowed: slot("allowed") })}
          slots={{ allowed: <b>{t("ai.prod.allowed")}</b> }}
        />{" "}
        <button
          type="button"
          className="ai-link"
          onClick={() => {
            const next = { ...s.aiAllowed };
            delete next[conn.id];
            setAi("aiAllowed", next);
          }}
        >
          {t("ai.prod.turnOff")}
        </button>
      </span>
    </div>
  ) : null;

  const pending = th.pending;

  return (
    <aside
      className={"sq-drawer ai-panel" + (open ? " open" : "")}
      aria-hidden={!open}
      aria-label={t("ai.title")}
      inert={!open}
    >
      <div className="sq-drawer-head">
        <span className="sq-drawer-title">
          <Icon
            name={state === "locked" ? "lock" : "auto_awesome"}
            size={16}
            style={{ color: state === "locked" ? "var(--error)" : "var(--accent)" }}
          />{" "}
          <span className="ai-alpha-host">
            {t("ai.title")}
            <AiAlphaTag />
          </span>
        </span>
        <span style={{ display: "flex", gap: 2 }}>
          {state === "on" ? (
            <>
              <IconBtn
                icon="add_comment"
                onClick={() => {
                  newSession(wsKey);
                  setShowHistory(false);
                }}
                disabled={!th.msgs.length && !pending}
                title={t("ai.newChat")}
                aria-label={t("ai.newChat")}
              />
              <IconBtn
                icon="history"
                active={showHistory}
                onClick={() => setShowHistory((v) => !v)}
                title={t("ai.sessions.title")}
                aria-label={t("ai.sessions.title")}
                aria-pressed={showHistory}
              />
            </>
          ) : null}
          <IconBtn
            icon="settings"
            onClick={openAiSettings}
            title={t("ai.settings")}
            aria-label={t("ai.settings")}
          />
          <IconBtn
            icon="close"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          />
        </span>
      </div>

      {state !== "on" ? (
        <div className="ai-panel-body">
          {state === "off" ? (
            <div className="ai-off">
              <Icon name="auto_awesome" size={26} />
              <div className="ai-lock-t">{t("ai.off.title")}</div>
              <p>{t("ai.off.body")}</p>
              <Btn variant="tonal" small onClick={openAiSettings}>
                {t("ai.off.setup")}
              </Btn>
            </div>
          ) : (
            <AiLockCard conn={conn} />
          )}
        </div>
      ) : showHistory ? (
        <AiSessionList wsKey={wsKey} onPick={() => setShowHistory(false)} />
      ) : (
        <>
          <div className="ai-thread" role="log" aria-live="polite" ref={threadRef}>
            {prodNote}
            {!th.msgs.length && !pending ? (
              <div className="ai-empty">
                <div className="ai-empty-t">{t("ai.empty.title")}</div>
                <p>{lang === "sql" ? t("ai.empty.body") : t("ai.empty.bodyOther")}</p>
                {/* Built from this schema's table and column names, so they are
                    always about tables that exist here; none until it loads. */}
                <div className="ai-starters">
                  {startersFor(all, lang).map((st) => {
                    const docs = noun === "collections";
                    const q =
                      st.kind === "keys"
                        ? t("ai.starter.keys", { pattern: st.table })
                        : st.kind === "latest"
                          ? docs
                            ? t("ai.starter.latestDocs", { table: st.table })
                            : t("ai.starter.latest", { table: st.table })
                          : st.kind === "countBy"
                            ? t("ai.starter.countBy", { table: st.table, column: st.column })
                            : docs
                              ? t("ai.starter.countDocs", { table: st.table })
                              : t("ai.starter.count", { table: st.table });
                    return (
                      <button
                        key={st.kind + st.table}
                        type="button"
                        className="ai-starter"
                        disabled={busy}
                        onClick={() =>
                          submit("ask", q, q, undefined, st.kind === "keys" ? [] : [st.table])
                        }
                      >
                        <Icon name="arrow_outward" size={14} /> {q}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {th.msgs.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="ai-msg user">
                  <div className="ai-bubble">{m.text}</div>
                  <div className="ai-sent">
                    <AiFill
                      text={t("ai.sent.line", {
                        what: slot("what"),
                        tokens: m.prompt.tokens.toLocaleString(),
                        view: slot("view"),
                      })}
                      slots={{
                        what: m.prompt.rowTables.length ? (
                          <span className="ai-warn-t">
                            {t("ai.sent.rows", { tables: m.prompt.rowTables.join(", ") })}
                          </span>
                        ) : (
                          t("ai.sent.structure", { count: m.prompt.tables })
                        ),
                        view: (
                          <button
                            type="button"
                            className="ai-link"
                            aria-expanded={!!m.peek}
                            onClick={() => patchMsg(cur, m.id, { peek: !m.peek })}
                          >
                            {m.peek ? t("ai.sent.hide") : t("ai.sent.view")}
                          </button>
                        ),
                      }}
                    />
                  </div>
                  {m.peek ? <AiPromptView prompt={m.prompt} /> : null}
                </div>
              ) : (
                <div key={m.id} className="ai-msg ai">
                  {answer(m)}
                  {m.st === "load" && m.raw ? (
                    <div className="ai-msg-actions">
                      <Btn variant="text" small icon="stop" onClick={() => cancelStream(cur)}>
                        {t("ai.stop")}
                      </Btn>
                    </div>
                  ) : null}
                </div>
              ),
            )}
            {th.preparing ? (
              <div className="ai-note">
                <Icon name="progress_activity" size={15} className="ai-spin" /> {t("ai.preparing")}
              </div>
            ) : null}
            {pending ? (
              <div className="ai-msg user pending">
                <div className="ai-bubble">{pending.say}</div>
                <div className="ai-pending">
                  <AiPromptSummary
                    prompt={pending.prompt}
                    open={th.peek}
                    onToggle={() => patch(cur, { peek: !th.peek })}
                  />
                  {th.peek ? <AiPromptView prompt={pending.prompt} /> : null}
                  <div className="ai-row">
                    <span className="ai-note">{t("ai.review.notSent")}</span>
                    <span className="ai-grow" />
                    <Btn
                      variant="text"
                      small
                      onClick={() => {
                        void assistantDiscard(pending.prompt.id).catch(() => {});
                        setText(pending.kind === "ask" ? pending.req : "");
                        patch(cur, { pending: null, peek: false });
                      }}
                    >
                      {t("common.cancel")}
                    </Btn>
                    <button
                      ref={sendRef}
                      type="button"
                      className="btn btn-filled btn-small"
                      onClick={() => {
                        setRowData(false);
                        deliver(cur);
                      }}
                    >
                      <Icon name="send" size={15} />
                      <span>{t("ai.review.send", { to: d.local ? d.via : d.host })}</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="ai-composer">
            <div className="ai-quick" role="group" aria-label={t("ai.quick.aria")}>
              {actions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="ai-chip"
                  onClick={() => act(a)}
                  disabled={!hasSql || busy || !!pending}
                  title={hasSql ? t(`ai.act.${a.key}.title`) : t("ai.quick.empty")}
                >
                  <Icon name={a.icon} size={13} /> {t(`ai.act.${a.key}.t`)}
                </button>
              ))}
            </div>
            <div className="ai-compose">
              {sugOpen ? (
                <AiSuggest
                  id={sugId}
                  items={suggestions}
                  active={Math.min(sugIdx, Math.max(0, suggestions.length - 1))}
                  empty={
                    trig?.sign === "@"
                      ? t("ai.suggest.noTables", { q: trig.query })
                      : t("ai.suggest.noCommands", { q: trig?.query ?? "" })
                  }
                  onPick={(sg) => sg.run()}
                  onHover={setSugIdx}
                />
              ) : null}
              <label className="ai-sr" htmlFor={uid}>
                {t("ai.compose.label")}
              </label>
              <textarea
                id={uid}
                ref={inRef}
                rows={2}
                className="ai-ask-input"
                value={text}
                disabled={!!pending}
                onChange={(e) => {
                  setText(e.target.value);
                  readTrig(e.target);
                }}
                onSelect={(e) => readTrig(e.currentTarget)}
                onBlur={() => setTrig(null)}
                spellCheck={false}
                autoComplete="off"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={sugOpen}
                aria-controls={sugOpen ? sugId : undefined}
                aria-activedescendant={
                  sugOpen && activeSug
                    ? sugId + "-" + Math.min(sugIdx, suggestions.length - 1)
                    : undefined
                }
                onKeyDown={(e) => {
                  // The suggestion list has the arrows, Enter/Tab and Esc while open.
                  if (sugOpen) {
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const n = suggestions.length;
                      if (n)
                        setSugIdx(
                          (i) => (Math.min(i, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n,
                        );
                      return;
                    }
                    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && activeSug) {
                      e.preventDefault();
                      if (!activeSug.disabled) activeSug.run();
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setTrig(null);
                      return;
                    }
                  }
                  // ⌘⌫ / Ctrl+⌫ deletes the word before the caret, not the
                  // whole line (macOS's native ⌘⌫). Done as the browser's own
                  // delete, so ⌘Z brings the word back.
                  if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
                    const el = e.currentTarget;
                    const caret = el.selectionStart ?? 0;
                    if (caret === el.selectionEnd && caret > 0) {
                      e.preventDefault();
                      el.setSelectionRange(prevWordStart(el.value, caret), caret);
                      if (!document.execCommand("delete")) {
                        const from = prevWordStart(el.value, caret);
                        setText(el.value.slice(0, from) + el.value.slice(caret));
                        requestAnimationFrame(() => inRef.current?.setSelectionRange(from, from));
                      }
                    }
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendText();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onClose();
                  }
                }}
                placeholder={
                  draft
                    ? t("ai.compose.followUp")
                    : lang === "sql"
                      ? t("ai.compose.placeholder")
                      : lang === "redis"
                        ? t("ai.compose.placeholderRedis")
                        : t("ai.compose.placeholderOther")
                }
              />
              <div className="ai-ctx">
                <div className="ai-pop-anchor">
                  <button
                    type="button"
                    className={"ai-chip" + (mentioned.length ? " focus" : "")}
                    onClick={() => setScopeOpen((o) => !o)}
                    aria-expanded={scopeOpen}
                    title={mentioned.length ? t("ai.scope.focusTitle") : t("ai.scope.title")}
                  >
                    <Icon name={mentioned.length ? "alternate_email" : "schema"} size={13} />{" "}
                    <b className="ai-chip-t">
                      {mentioned.length
                        ? mentioned.map((m) => "@" + m).join(", ")
                        : scope === null
                          ? noun === "tables"
                            ? t("ai.scope.all", { count: all.length })
                            : noun === "collections"
                              ? t("ai.scope.allColl", { count: all.length })
                              : t("ai.scope.allKeys", { count: all.length })
                          : t("ai.scope.some", { n: scope.length, count: all.length })}
                    </b>{" "}
                    <Icon name="expand_less" size={13} />
                  </button>
                  {scopeOpen ? (
                    <div className="ai-scope" role="group" aria-label={t("ai.scope.aria")}>
                      <div className="ai-scope-h">
                        {t("ai.scope.head", { schema: schemaName })}
                        <button type="button" className="ai-link" onClick={() => setScope(null)}>
                          {t("ai.scope.allBtn")}
                        </button>
                      </div>
                      {mentioned.length ? (
                        <div className="ai-scope-note">
                          <Icon name="alternate_email" size={13} />
                          <span>{t("ai.scope.focusNote")}</span>
                        </div>
                      ) : null}
                      {all.map((tb) => {
                        const on = scopeNames.includes(tb.name);
                        return (
                          <label
                            key={tb.name}
                            className={"ai-scope-item" + (mentioned.length ? " muted" : "")}
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => {
                                // At least one table stays ticked.
                                if (on && scopeNames.length <= 1) return;
                                const next = on
                                  ? scopeNames.filter((x) => x !== tb.name)
                                  : all
                                      .map((x) => x.name)
                                      .filter((x) => x === tb.name || scopeNames.includes(x));
                                setScope(next.length === all.length ? null : next);
                              }}
                            />
                            <span className="ai-scope-n">{tb.name}</span>
                            <span className="ai-scope-c">
                              {t("ai.scope.cols", { count: tb.columns.length })}
                            </span>
                          </label>
                        );
                      })}
                      <div className="ai-scope-f">
                        {noun === "tables"
                          ? t("ai.scope.foot")
                          : noun === "collections"
                            ? t("ai.scope.footColl")
                            : t("ai.scope.footKeys")}
                      </div>
                    </div>
                  ) : null}
                </div>
                {lang === "redis" ? (
                  <span className="ai-chip off" title={t("ai.rows.redisTitle")}>
                    <Icon name="lock" size={13} /> {t("ai.rows.redis")}
                  </span>
                ) : canRows ? (
                  <button
                    type="button"
                    className={"ai-chip" + (rowData ? " warn" : "")}
                    onClick={() => setRowData((v) => !v)}
                    aria-pressed={rowData}
                    title={t("ai.rows.title")}
                  >
                    <Icon name={rowData ? "table_view" : "visibility_off"} size={13} />{" "}
                    <AiFill
                      text={t("ai.rows.chip", { state: slot("state") })}
                      slots={{ state: <b>{rowData ? t("ai.rows.on") : t("ai.rows.off")}</b> }}
                    />
                  </button>
                ) : (
                  <span className="ai-chip off" title={t("ai.rows.prodTitle")}>
                    <Icon name="lock" size={13} /> {t("ai.rows.prod")}
                  </span>
                )}
                <span className="ai-grow" />
                <button
                  type="button"
                  className="ai-send"
                  onClick={sendText}
                  disabled={!text.trim() || busy || !!pending}
                  aria-label={t("ai.compose.send")}
                  title={t("ai.compose.sendTitle")}
                >
                  <Icon name="arrow_upward" size={17} />
                </button>
              </div>
            </div>
            {/* Runtime · model · where prompts go — next to the box you send from. */}
            <AiModelRow open={open} conn={conn} />
          </div>
        </>
      )}
    </aside>
  );
}
