// Settings → AI assistant (Tasks B1–B8) — ported from the prototype's
// `AiSettingsPane`, with the stand-ins replaced: the model list comes from the
// endpoint (`list_models`), the key row shows the keychain's masked tail, the
// Test button really calls the model, and the prompt log is the file on disk.
//
// While the master switch is off the rest of the pane is dimmed and inert, and
// no discovery call is made — the backend refuses one anyway.

import { useCallback, useEffect, useMemo, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { EngineMark } from "../../../shared/ui/EngineMark";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { useConnectionsStore } from "../../connections/state";
import { DEFAULTS, type AiRuntime, type AiSample, type AiVendor } from "../../settings/api";
import { SetRow, SetSeg, SetToggle } from "../../settings/components/SetControls";
import {
  aiSettingsOf,
  assistantModels,
  assistantTest,
  keyInfo,
  keyRemove,
  keySet,
  logClear,
  logRead,
  type KeyAccount,
  type KeyInfo,
  type LogPage,
  type ModelsReport,
  type TestReport,
} from "../api";
import { useAssistant } from "../hooks/useAssistant";
import { isAssistantEngine, slot } from "../logic";
import { AiFill } from "./AiBits";
import { AiUrlHelp } from "./AiUrlHelp";
import "./Assistant.css";

function gb(bytes: number | null): string {
  return bytes == null ? "" : (bytes / 1e9).toFixed(1) + " GB";
}

/** A key row: masked tail + keychain name, with Add / Replace / Remove. */
function KeyRow({
  account,
  optional,
  onChange,
}: {
  account: KeyAccount;
  optional?: boolean;
  onChange?: (has: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    let live = true;
    keyInfo(account)
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [account]);
  const keychain = info?.keychain ?? t("ai.set.keychainFallback");
  const save = () => {
    keySet(account, draft)
      .then((i) => {
        setInfo(i);
        setEditing(false);
        setDraft("");
        onChange?.(true);
        toast(t("ai.set.keySaved", { keychain: i.keychain }), "ok");
      })
      .catch((err: unknown) => toast(appErrorMessage(err, t("ai.set.keyFail")), "err"));
  };
  const remove = () => {
    keyRemove(account)
      .then((i) => {
        setInfo(i);
        onChange?.(false);
        toast(t("ai.set.keyRemoved", { keychain: i.keychain }), "ok");
      })
      .catch((err: unknown) => toast(appErrorMessage(err, t("ai.set.keyFail")), "err"));
  };
  if (editing) {
    return (
      <div className="ai-keyrow">
        <label className="ai-sr" htmlFor={"ai-key-" + account}>
          {t("ai.set.keyLabel")}
        </label>
        <input
          id={"ai-key-" + account}
          className="ai-inp plain ai-key-input"
          type="password"
          value={draft}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder={t("ai.set.keyPlaceholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) save();
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <Btn variant="text" small onClick={() => setEditing(false)}>
          {t("common.cancel")}
        </Btn>
        <Btn variant="filled" small disabled={!draft.trim()} onClick={save}>
          {t("common.save")}
        </Btn>
      </div>
    );
  }
  return (
    <div className="ai-keyrow">
      <Icon name="key" size={15} />
      {info?.masked ? (
        <>
          <span className="ai-mono">{info.masked}</span>
          <span className="ai-keychain">
            <Icon name="lock" size={12} /> {t("ai.set.inKeychain", { keychain })}
          </span>
        </>
      ) : (
        <span className="ai-nokey">{optional ? t("ai.set.noKeyOptional") : t("ai.set.noKey")}</span>
      )}
      <span className="ai-grow" />
      {info?.masked ? (
        <>
          <IconBtn
            icon="edit"
            size={15}
            title={t("ai.set.replace")}
            aria-label={t("ai.set.replace")}
            onClick={() => setEditing(true)}
          />
          <IconBtn
            icon="delete"
            size={15}
            danger
            title={t("ai.set.remove")}
            aria-label={t("ai.set.remove")}
            onClick={remove}
          />
        </>
      ) : (
        <Btn variant="text" small onClick={() => setEditing(true)}>
          {t("ai.set.addKey")}
        </Btn>
      )}
    </div>
  );
}

/** "Prompts leave this machine" — amber, and louder for plain http. */
function WarnBox({ host, url, provider }: { host: string; url?: string; provider?: boolean }) {
  const t = useT();
  const plain = !!url && /^http:\/\//i.test(url.trim());
  return (
    <div className="ai-warnbox">
      <Icon name="cloud_upload" size={16} />
      <span>
        <b>{t("ai.set.leaves")}</b>{" "}
        {provider
          ? t("ai.set.leavesProvider", { host })
          : plain
            ? t("ai.set.leavesHttp", { host })
            : t("ai.set.leavesHost", { host })}
      </span>
    </div>
  );
}

function testLabel(
  t: ReturnType<typeof useT>,
  test: TestReport | "run" | null,
  idle: string,
  key?: boolean,
): string {
  if (test === "run") return t("ai.set.testing");
  if (!test) return idle;
  if (test.ok)
    return key ? t("ai.set.keyWorks") : t("ai.set.replied", { s: (test.ms / 1000).toFixed(1) });
  if (test.error?.kind === "unreachable") return t("ai.set.noNetwork");
  if (test.error?.kind === "auth") return t("ai.set.keyRejected");
  return t("ai.set.failed");
}

export function AiSettingsPane() {
  const t = useT();
  const toast = useToast();
  // Where prompts go, and what each endpoint's URL says about its host, come
  // from the backend's rule. The switch is the ACTIVE workspace's: on/off is
  // remembered per saved connection, and with no workspace open it is off and
  // can't be turned on. The setup below is global and stays editable either
  // way; only what calls the endpoint (discovery, Test) waits for "on".
  const { s, setAi: setSetting, d, runtime: rt, custom, conn, enabled } = useAssistant(null);
  // Results are kept with the destination they were for, so changing the
  // endpoint shows a fresh button / status row without an effect resetting it.
  const destKey = [
    s.aiProvider,
    s.aiRuntime,
    s.aiVendor,
    s.aiCustomUrl,
    s.aiCustomModel,
    s.aiOllamaUrl,
    s.aiLmUrl,
    s.aiKeyModel,
  ].join("\u0000");
  const [testFor, setTestFor] = useState<{ key: string; r: TestReport | "run" } | null>(null);
  const test = testFor?.key === destKey ? testFor.r : null;
  const setTest = (r: TestReport | "run") => setTestFor({ key: destKey, r });
  const [modelsFor, setModelsFor] = useState<{ url: string; r: ModelsReport } | null>(null);
  const [log, setLog] = useState<LogPage | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const connections = useConnectionsStore((x) => x.savedConnections);

  const isLm = s.aiRuntime === "lmstudio";
  const rtKey = isLm ? "aiLmUrl" : "aiOllamaUrl";
  const rtDefault = isLm ? DEFAULTS.aiLmUrl : DEFAULTS.aiOllamaUrl;
  const rtName = isLm ? "LM Studio" : "Ollama";
  const rtUrl = s[rtKey];
  const local = s.aiProvider !== "key";

  // Live status of a named runtime: ask it for its models, debounced so typing
  // a port doesn't fire a request per keystroke. Nothing at all while off.
  const discoverUrl = local && s.aiRuntime !== "custom" && enabled && rt.ok ? rtUrl : null;
  const models = discoverUrl && modelsFor?.url === discoverUrl ? modelsFor.r : null;
  useEffect(() => {
    if (!discoverUrl) return;
    let live = true;
    const timer = setTimeout(() => {
      assistantModels(aiSettingsOf(s), conn?.id ?? null)
        .then((r) => live && setModelsFor({ url: discoverUrl, r }))
        .catch(
          () =>
            live &&
            setModelsFor({ url: discoverUrl, r: { reachable: false, models: [], error: null } }),
        );
    }, 450);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // Re-ask when the endpoint changes, not on every unrelated setting (`s` is
    // read for the keys the backend needs at that moment).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoverUrl, s.aiRuntime]);

  const refreshLog = useCallback(() => {
    logRead(20)
      .then(setLog)
      .catch(() => setLog({ total: 0, entries: [] }));
  }, []);
  useEffect(refreshLog, [refreshLog]);

  const runTest = () => {
    setTest("run");
    assistantTest(aiSettingsOf(s), conn?.id ?? null)
      .then((r) => {
        setTest(r);
        refreshLog();
      })
      .catch((err: unknown) =>
        setTest({ ok: false, ms: 0, error: { kind: "failed", message: appErrorMessage(err, "") } }),
      );
  };

  const prod = useMemo(
    () => connections.filter((c) => c.env === "production" && isAssistantEngine(c.engine)),
    [connections],
  );

  const runtimeRow = (() => {
    if (!rt.ok)
      return (
        <>
          <span className="ai-dot warn" />
          <span className="ai-warn-t">
            {rtUrl.trim() ? t("ai.set.notUrl") : t("ai.set.enterOrReset")}
          </span>
        </>
      );
    if (!rt.loopback)
      return (
        <>
          <span className="ai-dot warn" />
          <span>
            <AiFill
              text={t("ai.set.rtRemote", { name: rtName, host: slot("host") })}
              slots={{ host: <b className="ai-mono">{rt.host}</b> }}
            />
          </span>
        </>
      );
    if (models && !models.reachable)
      return (
        <>
          <span className="ai-dot bad" />
          <span className="ai-bad-t">
            <AiFill
              text={t("ai.set.rtDown", { name: rtName, host: slot("host") })}
              slots={{ host: <b className="ai-mono">{rt.host}</b> }}
            />
          </span>
        </>
      );
    if (!models)
      return (
        <>
          <span className="ai-dot idle" />
          <span>
            <AiFill
              text={t("ai.set.rtChecking", { name: rtName, host: slot("host") })}
              slots={{ host: <b className="ai-mono">{rt.host}</b> }}
            />
          </span>
        </>
      );
    return (
      <>
        <span className="ai-dot" />
        <span>
          <AiFill
            text={t("ai.set.rtUp", {
              name: rtName,
              host: slot("host"),
              count: models.models.length,
            })}
            slots={{ host: <b className="ai-mono">{rt.host}</b> }}
          />
        </span>
      </>
    );
  })();

  const selectedModel = isLm ? s.aiLmModel : s.aiLocalModel;
  const modelList = models?.models ?? [];

  return (
    <>
      <div className="ai-set-hero">
        <div>
          <div className="ai-set-title">
            {t("ai.set.title")}{" "}
            <span className={"ai-set-state" + (enabled ? " on" : "")}>
              {enabled ? t("ai.set.on") : t("ai.set.off")}
            </span>
          </div>
          <p>{t("ai.set.promise")}</p>
          <p className="ai-set-scope">
            <Icon name={conn ? "database" : "info"} size={13} />{" "}
            {conn ? t("ai.set.scopeFor", { name: conn.name }) : t("ai.set.noWorkspace")}
          </p>
        </div>
        <SetToggle
          on={enabled}
          disabled={!conn}
          label={conn ? t("ai.set.masterFor", { name: conn.name }) : t("ai.set.noWorkspace")}
          onChange={(v) => {
            if (!conn) return;
            setSetting("aiEnabledFor", { ...s.aiEnabledFor, [conn.id]: v });
            toast(
              v
                ? t("ai.set.toastOnFor", { name: conn.name })
                : t("ai.set.toastOffFor", { name: conn.name }),
              "ok",
            );
          }}
        />
      </div>

      {!enabled ? (
        <div className="ai-promises">
          <div className="ai-promise">
            <Icon name="lan" size={20} />
            <b>{t("ai.promise.local")}</b>
            <span>{t("ai.promise.localBody")}</span>
          </div>
          <div className="ai-promise">
            <Icon name="shield" size={20} />
            <b>{t("ai.promise.structure")}</b>
            <span>{t("ai.promise.structureBody")}</span>
          </div>
          <div className="ai-promise">
            <Icon name="visibility" size={20} />
            <b>{t("ai.promise.see")}</b>
            <span>{t("ai.promise.seeBody")}</span>
          </div>
        </div>
      ) : null}

      <div className="ai-set-rest">
        <div className="set-section-label">{t("ai.set.secModel")}</div>
        <div className="ai-prov" role="radiogroup" aria-label={t("ai.set.secModel")}>
          <button
            type="button"
            role="radio"
            className={"ai-prov-card" + (local ? " on" : "")}
            onClick={() => setSetting("aiProvider", "local")}
            aria-checked={local}
          >
            <span className="ai-prov-ic">
              <Icon name="memory" size={18} />
            </span>
            <span>
              <b>
                {t("ai.set.provLocal")} <i>{t("ai.set.recommended")}</i>
              </b>
              <span>{t("ai.set.provLocalBody")}</span>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            className={"ai-prov-card" + (!local ? " on" : "")}
            onClick={() => setSetting("aiProvider", "key")}
            aria-checked={!local}
          >
            <span className="ai-prov-ic">
              <Icon name="key" size={18} />
            </span>
            <span>
              <b>{t("ai.set.provKey")}</b>
              <span>{t("ai.set.provKeyBody")}</span>
            </span>
          </button>
        </div>

        {local ? (
          <>
            <SetRow
              label={t("ai.set.runtime")}
              hint={
                s.aiRuntime === "custom" ? t("ai.set.runtimeCustomHint") : t("ai.set.runtimeHint")
              }
            >
              <SetSeg<AiRuntime>
                value={s.aiRuntime}
                onChange={(v) => setSetting("aiRuntime", v)}
                options={[
                  { value: "ollama", label: "Ollama" },
                  { value: "lmstudio", label: "LM Studio" },
                  { value: "custom", label: t("ai.set.customUrl") },
                ]}
              />
            </SetRow>
            {s.aiRuntime === "custom" ? (
              <>
                <div className="ai-fields">
                  <div className="ai-field wide">
                    <label htmlFor="ai-cu-url">{t("ai.set.baseUrl")}</label>
                    <input
                      id="ai-cu-url"
                      className={"ai-inp plain" + (s.aiCustomUrl && !custom.ok ? " bad" : "")}
                      value={s.aiCustomUrl}
                      onChange={(e) => setSetting("aiCustomUrl", e.target.value)}
                      placeholder="https://your-gateway.example/v1"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                  <div className="ai-field">
                    <label htmlFor="ai-cu-model">{t("ai.set.model")}</label>
                    <input
                      id="ai-cu-model"
                      className="ai-inp plain"
                      value={s.aiCustomModel}
                      onChange={(e) => setSetting("aiCustomModel", e.target.value)}
                      placeholder={t("ai.set.modelPlaceholder")}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                  <div className="ai-field wide">
                    <span className="ai-field-l">
                      {t("ai.set.apiKey")} <span className="ai-opt">{t("ai.set.optional")}</span>
                    </span>
                    <KeyRow
                      account="custom"
                      optional
                      onChange={(has) => setSetting("aiCustomKey", has)}
                    />
                  </div>
                </div>
                <div className="ai-detect">
                  {!s.aiCustomUrl.trim() ? (
                    <>
                      <span className="ai-dot idle" />
                      <span>{t("ai.set.enterBase")}</span>
                    </>
                  ) : !custom.ok ? (
                    <>
                      <span className="ai-dot warn" />
                      <span className="ai-warn-t">{t("ai.set.notUrl")}</span>
                    </>
                  ) : custom.loopback ? (
                    <>
                      <span className="ai-dot" />
                      <span>
                        <AiFill
                          text={t("ai.set.isThis", { host: slot("host") })}
                          slots={{ host: <b className="ai-mono">{custom.host}</b> }}
                        />
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="ai-dot warn" />
                      <span>
                        <AiFill
                          text={t("ai.set.isOther", { host: slot("host") })}
                          slots={{ host: <b className="ai-mono">{custom.host}</b> }}
                        />
                      </span>
                    </>
                  )}
                  <span className="ai-grow" />
                  <Btn
                    variant="text"
                    small
                    onClick={runTest}
                    disabled={!enabled || !d.ready || test === "run"}
                  >
                    {testLabel(t, test, t("ai.set.testEndpoint"))}
                  </Btn>
                </div>
                {custom.ok && !custom.loopback ? (
                  <WarnBox host={custom.host} url={s.aiCustomUrl} />
                ) : null}
              </>
            ) : (
              <>
                <div className="ai-fields">
                  <div className="ai-field wide">
                    <label htmlFor="ai-rt-url">
                      {t("ai.set.endpoint")}{" "}
                      {rtUrl.trim() !== rtDefault ? (
                        <button
                          type="button"
                          className="ai-link ai-reset"
                          onClick={() => setSetting(rtKey, rtDefault)}
                        >
                          {t("ai.set.resetTo", { url: rtDefault })}
                        </button>
                      ) : (
                        <span className="ai-opt">{t("ai.set.default")}</span>
                      )}
                    </label>
                    <input
                      id="ai-rt-url"
                      className={"ai-inp plain" + (!rt.ok ? " bad" : "")}
                      value={rtUrl}
                      onChange={(e) => setSetting(rtKey, e.target.value)}
                      placeholder={rtDefault}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div className="ai-detect">
                  {runtimeRow}
                  <span className="ai-grow" />
                  <Btn
                    variant="text"
                    small
                    onClick={runTest}
                    disabled={!enabled || !rt.ok || !d.ready || test === "run"}
                  >
                    {testLabel(t, test, t("ai.set.testModel"))}
                  </Btn>
                </div>
                {rt.ok && !rt.loopback ? <WarnBox host={rt.host} url={rtUrl} /> : null}
                {modelList.length ? (
                  <div className="ai-models" role="radiogroup" aria-label={t("ai.set.model")}>
                    {modelList.map((m, i) => {
                      const on = selectedModel ? selectedModel === m.name : isLm && i === 0;
                      return (
                        <button
                          key={m.name}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          className={"ai-modelrow" + (on ? " on" : "")}
                          onClick={() => setSetting(isLm ? "aiLmModel" : "aiLocalModel", m.name)}
                        >
                          <span className="ai-radio" />
                          <span className="ai-mono">{m.name}</span>
                          {m.tag ? <span className="ai-tag">{m.tag}</span> : null}
                          <span className="ai-grow" />
                          <span className="ai-size">{gb(m.size)}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : models?.reachable ? (
                  <div className="ai-set-note">
                    {isLm ? t("ai.set.noModelsLm") : t("ai.set.noModels")}
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : (
          <>
            <SetRow label={t("ai.set.service")} hint={t("ai.set.serviceHint", { model: d.model })}>
              <SetSeg<AiVendor>
                value={s.aiVendor}
                onChange={(v) => setSetting("aiVendor", v)}
                options={[
                  { value: "anthropic", label: "Anthropic" },
                  { value: "openai", label: t("ai.set.openaiCompat") },
                ]}
              />
            </SetRow>
            <div className="ai-fields">
              {s.aiVendor === "openai" ? (
                // Any OpenAI-compatible service, not only OpenAI: the key goes
                // to whatever this points at, and the chip follows it.
                <div className="ai-field wide">
                  <div className="ai-label-row">
                    <label htmlFor="ai-key-url">{t("ai.set.baseUrl")}</label>
                    <AiUrlHelp onUse={(url) => setSetting("aiKeyUrl", url)} />
                    {s.aiKeyUrl.trim() !== DEFAULTS.aiKeyUrl ? (
                      <button
                        type="button"
                        className="ai-link ai-reset"
                        onClick={() => setSetting("aiKeyUrl", DEFAULTS.aiKeyUrl)}
                      >
                        {t("ai.set.resetTo", { url: DEFAULTS.aiKeyUrl })}
                      </button>
                    ) : (
                      <span className="ai-opt">{t("ai.set.default")}</span>
                    )}
                  </div>
                  <input
                    id="ai-key-url"
                    className={"ai-inp plain" + (d.ready ? "" : " bad")}
                    value={s.aiKeyUrl}
                    onChange={(e) => setSetting("aiKeyUrl", e.target.value)}
                    placeholder="https://api.groq.com/openai/v1"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <span className="ai-field-hint">{t("ai.set.keyUrlHint")}</span>
                </div>
              ) : null}
              <div className="ai-field">
                <label htmlFor="ai-key-model">{t("ai.set.model")}</label>
                <input
                  id="ai-key-model"
                  className="ai-inp plain"
                  value={s.aiKeyModel}
                  onChange={(e) => setSetting("aiKeyModel", e.target.value)}
                  placeholder={d.model}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="ai-field wide">
                <span className="ai-field-l">{t("ai.set.apiKey")}</span>
                <KeyRow
                  key={s.aiVendor}
                  account={s.aiVendor === "openai" ? "openai" : "anthropic"}
                />
              </div>
            </div>
            <div className="ai-detect">
              <Icon name="key" size={15} />
              <span>{t("ai.set.keyTestHint", { host: d.host })}</span>
              <span className="ai-grow" />
              <Btn variant="text" small onClick={runTest} disabled={!enabled || test === "run"}>
                {testLabel(t, test, t("ai.set.testKey"), true)}
              </Btn>
            </div>
            <WarnBox host={d.host} provider />
          </>
        )}

        <div className="set-section-label">{t("ai.set.secSent")}</div>
        <SetRow label={t("ai.set.structure")} hint={t("ai.set.structureHint")}>
          <span className="ai-always">
            <Icon name="check" size={13} /> {t("ai.set.always")}
          </span>
        </SetRow>
        <SetRow label={t("ai.set.comments")} hint={t("ai.set.commentsHint")}>
          <SetToggle
            on={s.aiComments}
            label={t("ai.set.comments")}
            onChange={(v) => setSetting("aiComments", v)}
          />
        </SetRow>
        <SetRow label={t("ai.set.rowData")} hint={t("ai.set.rowDataHint")}>
          <SetSeg<AiSample>
            value={s.aiSample}
            onChange={(v) => setSetting("aiSample", v)}
            options={[
              { value: 5, label: t("ai.set.rows5") },
              { value: 20, label: "20" },
              { value: 50, label: "50" },
            ]}
          />
        </SetRow>
        <SetRow label={t("ai.set.review")} hint={t("ai.set.reviewHint")}>
          <SetToggle
            on={s.aiReview}
            label={t("ai.set.review")}
            onChange={(v) => setSetting("aiReview", v)}
          />
        </SetRow>

        <div className="set-section-label">{t("ai.set.secProd")}</div>
        {prod.length ? (
          <div className="ai-wslist">
            {prod.map((c) => {
              const on = !!s.aiAllowed[c.id];
              return (
                <div key={c.id} className="ai-wsrow">
                  <EngineMark engine={c.engine} size={20} />
                  <span className="ai-mono">{c.name}</span>
                  <span className="ai-grow" />
                  {on ? (
                    <span className="ai-ws-on">{t("ai.set.wsAllowed")}</span>
                  ) : (
                    <span className="ai-ws-off">
                      <Icon name="lock" size={12} /> {t("ai.set.wsOff")}
                    </span>
                  )}
                  {on ? (
                    <Btn
                      variant="text"
                      small
                      onClick={() => {
                        const next = { ...s.aiAllowed };
                        delete next[c.id];
                        setSetting("aiAllowed", next);
                      }}
                    >
                      {t("ai.set.turnOff")}
                    </Btn>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="ai-set-note">{t("ai.set.noProd")}</div>
        )}
        <div className="ai-set-note">{t("ai.set.prodNote")}</div>

        <div className="set-section-label">{t("ai.set.secLog")}</div>
        <SetRow label={t("ai.set.log")} hint={t("ai.set.logHint", { count: log?.total ?? 0 })}>
          <span className="ai-row">
            <Btn
              variant="text"
              small
              onClick={() => setLogOpen((o) => !o)}
              disabled={!log?.total}
              aria-expanded={logOpen}
            >
              {logOpen ? t("ai.set.hide") : t("ai.set.open")}
            </Btn>
            <Btn
              variant="text"
              small
              disabled={!log?.total}
              onClick={() => {
                logClear()
                  .then(() => {
                    setLogOpen(false);
                    refreshLog();
                  })
                  .catch((err: unknown) => toast(appErrorMessage(err, t("ai.set.logFail")), "err"));
              }}
            >
              {t("ai.set.clear")}
            </Btn>
            <SetToggle
              on={s.aiLog}
              label={t("ai.set.log")}
              onChange={(v) => setSetting("aiLog", v)}
            />
          </span>
        </SetRow>
        {logOpen && log ? (
          <div className="ai-log">
            {log.entries.map((l, i) => (
              <details key={i}>
                <summary>
                  <span className="ai-mono">{new Date(l.time).toLocaleTimeString()}</span>
                  <b>{l.kind}</b>
                  <span>{t("ai.set.logTokens", { tokens: l.tokens.toLocaleString() })}</span>
                  <span className={l.rows ? "ai-warn-t" : ""}>
                    {l.rows ? t("ai.set.inclRows") : t("ai.set.structureOnly")}
                  </span>
                  <span className="ai-mono">{l.host}</span>
                </summary>
                <pre className="ai-prompt">{l.text}</pre>
              </details>
            ))}
          </div>
        ) : null}
      </div>

      <div className="set-foot-note">
        <Icon name="lock" size={13} /> {t("ai.set.foot")}
      </div>
    </>
  );
}
