// The model line under the message box: a switcher over the runtimes prompts
// can go to (Ollama, LM Studio, a custom URL, or a hosted vendor with the
// user's key), a switcher over the models that runtime reports, and where
// prompts go. Borderless text-and-chevron triggers, one line: the model and the
// host give way with an ellipsis rather than wrapping.
//
// Switching runtime writes the same keys the Settings tab does; URLs, model
// names and API keys stay in Settings. A runtime that isn't set up is still
// listed (flagged), and picking it says so under the row with a way into
// Settings — as does a runtime that doesn't answer. Switching to a remote one
// needs no confirm: the chip turns amber and every send is still reviewed.

import { useEffect, useMemo, useState } from "react";

import { useT } from "../../../shared/i18n/useT";
import { Select } from "../../../shared/ui/Select";
import { aiSettingsOf, keyInfo } from "../api";
import { useSettingsStore } from "../../settings/state";
import { useAssistant } from "../hooks/useAssistant";
import {
  modelKeyOf,
  RUNTIMES,
  runtimeKeys,
  runtimeOf,
  slot,
  type AiConn,
  type RuntimeId,
} from "../logic";
import { openAiSettings } from "../openSettings";
import { modelsKey, useAssistantStore } from "../state";
import { AiFill } from "./AiBits";

/** `open`: the drawer is open — the list is only fetched while it is. */
export function AiModelRow({ open, conn }: { open: boolean; conn: AiConn }) {
  const t = useT();
  const { s, setAi, d } = useAssistant(conn);
  const ai = useMemo(() => aiSettingsOf(s), [s]);
  const key = modelsKey(ai);
  const report = useAssistantStore((st) => st.models[key]);
  const loadModels = useAssistantStore((st) => st.loadModels);
  const runtime = runtimeOf(s);

  // The model list is re-read each time the drawer opens and when the endpoint
  // changes while it is open — fresh, so a model pulled a moment ago is there —
  // and again whenever the model dropdown opens. No refresh button. Nothing is
  // fetched while the drawer is closed (it stays mounted, off-screen).
  useEffect(() => {
    if (open) void loadModels(ai, conn.id, true);
    // Re-ask only when the endpoint changes, not on every model pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, loadModels]);

  // Which hosted vendors have a key saved — re-read when the drawer opens, when
  // the runtime changes, and when the Settings window closes, so a key just
  // added there is picked up. Only the masked tail crosses.
  const settingsOpen = useSettingsStore((st) => st.settingsTab !== null);
  const [hasKey, setHasKey] = useState<Partial<Record<"anthropic" | "openai", boolean>>>({});
  useEffect(() => {
    let live = true;
    for (const account of ["anthropic", "openai"] as const) {
      keyInfo(account)
        .then((i) => live && setHasKey((h) => ({ ...h, [account]: !!i.masked })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [runtime, open, settingsOpen]);

  const name = (id: RuntimeId): string =>
    id === "ollama"
      ? "Ollama"
      : id === "lmstudio"
        ? "LM Studio"
        : id === "custom"
          ? t("ai.set.customUrl")
          : id === "anthropic"
            ? "Anthropic"
            : t("ai.set.openaiCompat");
  /** Why a runtime can't be used yet, or null when it can. */
  const missing = (id: RuntimeId): string | null =>
    (id === "anthropic" || id === "openai") && hasKey[id] === false
      ? t("ai.model.noKey")
      : id === "custom" && !s.aiCustomModel.trim()
        ? t("ai.model.notSetUp")
        : null;
  const runtimeOptions = RUNTIMES.map((id) => {
    const why = missing(id);
    return { value: id, label: why ? t("ai.model.flagged", { name: name(id), why }) : name(id) };
  });

  const modelKey = modelKeyOf(runtime);

  const names = report?.models.map((m) => m.name) ?? [];
  const current = d.model;
  const options = (names.includes(current) || !current ? names : [current, ...names]).map((n) => ({
    value: n,
    label: n,
  }));
  const listed = names.length > 0;
  const down = report && !report.reachable && report.error?.kind === "unreachable";
  const notReady = missing(runtime) ?? (d.ready ? null : t("ai.model.notSetUp"));

  // The end of the line says where prompts go — or, when the runtime can't be
  // used, why not, with the way to fix it. Destination: accent for this
  // machine, amber when prompts leave it; the full sentence is the tooltip.
  const tail = notReady ? (
    <span className="ai-line-note warn">
      <AiFill
        text={t("ai.model.lineSetup", { why: notReady, link: slot("link") })}
        slots={{
          link: (
            <button type="button" className="ai-link" onClick={openAiSettings}>
              {t("ai.openSettings")}
            </button>
          ),
        }}
      />
    </span>
  ) : down ? (
    <span
      className="ai-line-note bad"
      title={t("ai.model.down", { via: name(runtime), host: d.host })}
    >
      <AiFill
        text={t("ai.model.lineDown", { link: slot("link") })}
        slots={{
          link: (
            <button
              type="button"
              className="ai-link"
              onClick={() => void loadModels(ai, conn.id, true)}
            >
              {t("ai.model.retry")}
            </button>
          ),
        }}
      />
    </span>
  ) : (
    <span
      className={"ai-line-dest " + (d.local ? "local" : "remote")}
      title={
        (d.local ? t("ai.dest.stays", { host: d.host }) : t("ai.dest.leaves", { host: d.host })) +
        " — " +
        (d.local ? t("ai.dest.localTitle") : t("ai.dest.remoteTitle", { host: d.host }))
      }
    >
      {d.host}
    </span>
  );

  return (
    <div className="ai-model-line">
      <Select<RuntimeId>
        className="ai-ghost-sel ai-rt-sel"
        mono={false}
        placement="up"
        value={runtime}
        options={runtimeOptions}
        onChange={(id) => {
          const k = runtimeKeys(id);
          if (k.aiProvider) setAi("aiProvider", k.aiProvider);
          if (k.aiRuntime) setAi("aiRuntime", k.aiRuntime);
          if (k.aiVendor) setAi("aiVendor", k.aiVendor);
        }}
        aria-label={t("ai.model.runtimeAria")}
        title={t("ai.model.runtimeTitle")}
      />
      {listed ? (
        <Select
          className="ai-ghost-sel ai-model-sel"
          placement="up"
          value={current}
          options={options}
          onChange={(v) => setAi(modelKey, v)}
          onOpen={() => void loadModels(ai, conn.id, true)}
          aria-label={t("ai.model.aria")}
          title={t("ai.model.switch")}
        />
      ) : (
        <span className="ai-line-model" title={t("ai.model.type")}>
          {current || t("ai.model.none")}
        </span>
      )}
      <span className="ai-line-sep" aria-hidden="true">
        ·
      </span>
      {tail}
    </div>
  );
}
