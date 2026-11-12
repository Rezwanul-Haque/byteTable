// Fix a failed statement (Task D3) — lives inside the SQL tab's error card,
// next to the error, not in the chat thread. Ported from the prototype's
// `AiFix`: review card (structure · statement · error) → "Looking for the
// smallest fix" → a one-line reason, a line diff, the validation line, and
// Discard / Apply / Apply & run. With no small, safe fix it says so and
// proposes nothing.

import { useEffect, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import type { Engine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { highlightSql } from "../../browse/shared/highlightSql";
import {
  aiSettingsOf,
  assistantCancel,
  assistantDiscard,
  assistantPrepare,
  assistantSend,
  type Prepared,
} from "../api";
import { useAssistant } from "../hooks/useAssistant";
import { parseFixAnswer, validate, type AiConn, type FixAnswer } from "../logic";
import { schemaKey, useAssistantStore } from "../state";
import { AiDest, AiPromptSummary, AiPromptView, AiRich } from "./AiBits";
import { openAiSettings } from "../openSettings";
import "./Assistant.css";

type St =
  | "idle"
  | "preparing"
  | "review"
  | "load"
  | "proposed"
  | "none"
  | "neterr"
  | "setup"
  | "error";

interface AiFixProps {
  conn: AiConn;
  handleId: string;
  schemaName: string;
  engine: Engine;
  sql: string;
  error: string;
  onApply: (sql: string, run: boolean) => void;
}

export function AiFix({ conn, handleId, schemaName, engine, sql, error, onApply }: AiFixProps) {
  const t = useT();
  const { s, state, d, isProd } = useAssistant(conn);
  const [st, setSt] = useState<St>("idle");
  const [peek, setPeek] = useState(false);
  const [prompt, setPrompt] = useState<Prepared | null>(null);
  const [res, setRes] = useState<FixAnswer | null>(null);
  const [msg, setMsg] = useState("");
  const live = useRef<string | null>(null);
  const loadSchema = useAssistantStore((x) => x.loadSchema);
  const tables = useAssistantStore((x) => x.schemas[schemaKey(handleId, schemaName)]);

  // An in-flight fix dies with the card (a new error, a dismissed result).
  useEffect(
    () => () => {
      if (live.current) void assistantCancel(live.current).catch(() => {});
    },
    [],
  );

  const send = (p: Prepared) => {
    setSt("load");
    live.current = p.id;
    let raw = "";
    let ended = false;
    const end = (next: St, m = "") => {
      if (ended) return;
      ended = true;
      live.current = null;
      setMsg(m);
      if (next === "proposed") {
        const r = parseFixAnswer(raw, sql);
        setRes(r);
        setSt(r.ok ? "proposed" : "none");
      } else setSt(next);
    };
    assistantSend(p.id, aiSettingsOf(s), (e) => {
      if (e.event === "token") raw += e.text;
      else if (e.event === "done") end("proposed");
      else if (e.event === "cancelled") end("idle");
      else if (e.kind === "unreachable") end("neterr", e.message);
      else if (e.kind === "setup") end("setup", e.message);
      else end("error", e.message);
    })
      .then(() => end(raw ? "proposed" : "error", raw ? "" : t("ai.fix.noReply")))
      .catch((err: unknown) => end("error", appErrorMessage(err, t("ai.err.send"))));
  };

  const start = () => {
    setSt("preparing");
    void loadSchema(handleId, schemaName);
    assistantPrepare(
      { handleId, schema: schemaName, kind: "fix", scope: [], sql, error, connectionId: conn.id },
      aiSettingsOf(s),
    )
      .then((p) => {
        setPrompt(p);
        if (s.aiReview || isProd) setSt("review");
        else send(p);
      })
      .catch((err: unknown) => {
        setMsg(appErrorMessage(err, t("ai.err.prepare")));
        setSt("error");
      });
  };

  const back = () => {
    if (prompt && st === "review") void assistantDiscard(prompt.id).catch(() => {});
    setSt("idle");
    setPeek(false);
  };

  if (st === "idle") {
    return (
      <div className="ai-fix-actions">
        {state === "on" ? (
          <button type="button" className="ai-ask-btn" onClick={start}>
            <Icon name="auto_awesome" size={14} /> {t("ai.fix.btn")}
          </button>
        ) : state === "locked" ? (
          <span className="ai-ask-btn lock" title={t("ai.fix.lockTitle")}>
            <Icon name="lock" size={14} /> {t("ai.fix.locked")}
          </span>
        ) : (
          <button
            type="button"
            className="ai-ask-btn off"
            onClick={openAiSettings}
            title={t("ai.fix.offTitle")}
          >
            <Icon name="auto_awesome" size={14} /> {t("ai.fix.btn")}
          </button>
        )}
      </div>
    );
  }

  const check = res && res.ok ? validate(res.sql, tables ?? [], engine) : null;
  return (
    <div className="ai-fix" aria-live="polite">
      {st === "preparing" ? (
        <div className="ai-note">
          <Icon name="progress_activity" size={15} className="ai-spin" /> {t("ai.preparing")}
        </div>
      ) : null}
      {st === "review" && prompt ? (
        <>
          <div className="ai-mini-t">
            <Icon name="build" size={15} /> {t("ai.fix.reviewTitle")}
          </div>
          <AiPromptSummary prompt={prompt} open={peek} onToggle={() => setPeek((v) => !v)} />
          {peek ? <AiPromptView prompt={prompt} /> : null}
          <div className="ai-row">
            <AiDest d={d} />
            <span className="ai-grow" />
            <Btn variant="text" small onClick={back}>
              {t("common.cancel")}
            </Btn>
            <Btn variant="filled" small icon="send" onClick={() => send(prompt)} autoFocus>
              {t("ai.fix.send")}
            </Btn>
          </div>
        </>
      ) : null}
      {st === "load" ? (
        <div className="ai-note">
          <Icon name="progress_activity" size={15} className="ai-spin" />{" "}
          {t("ai.fix.looking", { model: d.model || d.via })}
        </div>
      ) : null}
      {st === "neterr" ? (
        <div className="ai-row">
          <span className="ai-note warn">
            <Icon name="wifi_off" size={15} />{" "}
            {d.local
              ? t("ai.fix.netLocal", { host: d.host, via: d.via })
              : t("ai.fix.netOffline", { host: d.host })}
          </span>
          <span className="ai-grow" />
          <Btn variant="text" small onClick={back}>
            {t("ai.back")}
          </Btn>
        </div>
      ) : null}
      {st === "setup" || st === "error" ? (
        <div className="ai-row">
          <span className="ai-note warn">
            <Icon name={st === "setup" ? "link_off" : "error"} size={15} /> {msg}
            {st === "setup" ? (
              <button type="button" className="ai-link" onClick={openAiSettings}>
                {t("ai.setup.finish")}
              </button>
            ) : null}
          </span>
          <span className="ai-grow" />
          <Btn variant="text" small onClick={back}>
            {t("ai.back")}
          </Btn>
        </div>
      ) : null}
      {st === "none" && res ? (
        <div className="ai-row">
          <span className="ai-note">
            <Icon name="do_not_disturb_on" size={15} />{" "}
            <span>
              <AiRich text={res.note} />
            </span>
          </span>
          <span className="ai-grow" />
          <Btn variant="text" small onClick={back}>
            {t("ai.dismiss")}
          </Btn>
        </div>
      ) : null}
      {st === "proposed" && res && res.ok ? (
        <>
          <div className="ai-mini-t">
            <Icon name="auto_awesome" size={15} />{" "}
            {t("ai.fix.proposed", { count: res.lines.length })}
          </div>
          {res.note ? (
            <div className="ai-fix-note">
              <AiRich text={res.note} />
            </div>
          ) : null}
          <pre className="ai-code ai-diff">
            {res.lines.map((l) => (
              <span key={l.n} style={{ display: "contents" }}>
                <span className="ai-pl del">
                  <i>{l.n}</i>
                  <b>−</b>
                  <span dangerouslySetInnerHTML={{ __html: highlightSql(l.old) }} />
                </span>
                <span className="ai-pl add">
                  <i>{l.n}</i>
                  <b>+</b>
                  <span dangerouslySetInnerHTML={{ __html: highlightSql(l.now) }} />
                </span>
              </span>
            ))}
          </pre>
          <div className="ai-row">
            {check && !check.write && !check.parseError && !check.unknown.length ? (
              <span className="ai-valid">
                <Icon name="verified" size={15} /> {t("ai.fix.validOk", { schema: schemaName })}
              </span>
            ) : check?.write ? (
              <span className="ai-valid bad">
                <Icon name="edit" size={15} /> {t("ai.valid.write")}
              </span>
            ) : (
              <span className="ai-valid bad">
                <Icon name="warning" size={15} />{" "}
                {check?.unknown.length
                  ? t("ai.valid.unknown", { schema: schemaName, names: check.unknown.join(", ") })
                  : t("ai.fix.validBad", { schema: schemaName })}
              </span>
            )}
            <span className="ai-grow" />
            <Btn variant="text" small onClick={back}>
              {t("ai.discard")}
            </Btn>
            <Btn variant="tonal" small onClick={() => onApply(res.sql, false)}>
              {t("common.apply")}
            </Btn>
            <Btn variant="filled" small icon="play_arrow" onClick={() => onApply(res.sql, true)}>
              {t("ai.fix.applyRun")}
            </Btn>
          </div>
        </>
      ) : null}
    </div>
  );
}
