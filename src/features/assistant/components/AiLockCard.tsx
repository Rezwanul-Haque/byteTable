// The production lock (Task E2): the drawer's card for a production workspace
// the user has not allowed, with the type-the-name gate that allows it.

import { useState } from "react";

import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { useAssistant } from "../hooks/useAssistant";
import { slot, type AiConn } from "../logic";
import { AiFill } from "./AiBits";

export function AiLockCard({ conn }: { conn: AiConn }) {
  const t = useT();
  const toast = useToast();
  const { s, setAi } = useAssistant(conn);
  const [gate, setGate] = useState(false);
  const [typed, setTyped] = useState("");
  const name = conn.name;
  return (
    <div className="ai-lock">
      <div className="ai-lock-ring">
        <Icon name="lock" size={19} />
      </div>
      <div className="ai-lock-t">{t("ai.lock.title")}</div>
      <p>
        <AiFill
          text={t("ai.lock.body", { name: slot("name"), env: slot("env") })}
          slots={{
            name: <b className="ai-mono">{name}</b>,
            env: <b className="ai-danger">production</b>,
          }}
        />
      </p>
      {!gate ? (
        <Btn
          variant="text"
          small
          onClick={() => setGate(true)}
          style={{ marginTop: 10, marginLeft: -8 }}
        >
          {t("ai.lock.allow")}
        </Btn>
      ) : (
        <div className="ai-gate">
          <label htmlFor="ai-gate-in">
            <AiFill
              text={t("ai.lock.type", { name: slot("name") })}
              slots={{ name: <code>{name}</code> }}
            />
          </label>
          <input
            id="ai-gate-in"
            className="ai-inp"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={name}
            spellCheck={false}
            autoComplete="off"
            ref={(el) => {
              if (el && !el.dataset.f) {
                el.dataset.f = "1";
                el.focus({ preventScroll: true });
              }
            }}
          />
          <div className="ai-gate-terms">
            <Icon name="shield" size={14} /> {t("ai.lock.terms")}
          </div>
          <div className="ai-row">
            <Btn
              variant="text"
              small
              onClick={() => {
                setGate(false);
                setTyped("");
              }}
            >
              {t("common.cancel")}
            </Btn>
            <button
              type="button"
              className="btn btn-small ai-btn-danger"
              disabled={typed !== name}
              onClick={() => {
                setAi("aiAllowed", { ...s.aiAllowed, [conn.id]: true });
                toast(t("ai.lock.allowed", { name }), "ok");
              }}
            >
              {t("ai.lock.allowBtn")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
