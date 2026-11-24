// Settings → Change history (M48 F5): whether to record, how long, how many,
// how large. Ported from the prototype's UndoSettingsPane.

import { useEffect, useState } from "react";

import { fmtNumber } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { SetRow, SetSeg, SetToggle } from "../../settings/components/SetControls";
import { useSettingsStore } from "../../settings/state";
import type { Settings } from "../../settings/api";
import { historyClear, historyPrune, historyTotals, limitsFrom, type Totals } from "../api";
import { useHistoryStore } from "../state";

export function HistorySettingsPane() {
  const t = useT();
  const toast = useToast();
  const settings = useSettingsStore((s) => s.settings);
  const setSettingRaw = useSettingsStore((s) => s.setSetting);
  const version = useHistoryStore((s) => s.version);
  const bump = useHistoryStore((s) => s.bump);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [arm, setArm] = useState(false);

  useEffect(() => {
    let live = true;
    historyTotals()
      .then((x) => live && setTotals(x))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [version]);

  // Lowering a limit removes what no longer fits straight away.
  const setLimit = <K extends "undoKeepDays" | "undoKeepEntries">(key: K, value: Settings[K]) => {
    setSettingRaw(key, value);
    const next = { ...settings, [key]: value };
    void historyPrune(limitsFrom(next)).then(bump);
  };

  const n = totals?.entries ?? 0;
  return (
    <>
      <div className="set-section-label">{t("history.set.recording")}</div>
      <SetRow label={t("history.set.record")} hint={t("history.set.recordHint")}>
        <SetToggle on={settings.undoRecord} onChange={(v) => setSettingRaw("undoRecord", v)} />
      </SetRow>
      <div className="set-section-label">{t("history.set.retention")}</div>
      <SetRow label={t("history.set.keepFor")} hint={t("history.set.keepForHint")}>
        <SetSeg
          value={settings.undoKeepDays}
          onChange={(v) => setLimit("undoKeepDays", v)}
          options={([1, 7, 30, 90] as const).map((d) => ({
            value: d,
            label: t("history.days", { count: d }),
          }))}
        />
      </SetRow>
      <SetRow label={t("history.set.keepAtMost")} hint={t("history.set.keepAtMostHint")}>
        <SetSeg
          value={settings.undoKeepEntries}
          onChange={(v) => setLimit("undoKeepEntries", v)}
          options={([100, 500, 2000] as const).map((v) => ({ value: v, label: fmtNumber(v) }))}
        />
      </SetRow>
      <SetRow label={t("history.set.maxRows")} hint={t("history.set.maxRowsHint")}>
        <SetSeg
          value={settings.undoMaxRows}
          onChange={(v) => setSettingRaw("undoMaxRows", v)}
          options={([100, 1000, 10000] as const).map((v) => ({
            value: v,
            label: t("history.rows", { count: v }),
          }))}
        />
      </SetRow>
      <div className="set-section-label">{t("history.set.stored")}</div>
      <SetRow
        label={
          n
            ? t("history.set.storedCount", {
                changes: t("history.changes", { count: n }),
                conns: t("history.connections", { count: totals?.connections ?? 0 }),
              })
            : t("history.set.nothing")
        }
        hint={t("history.set.storedHint")}
      >
        {arm ? (
          <span className="ul-set-arm">
            <Btn small variant="text" onClick={() => setArm(false)}>
              {t("history.cancel")}
            </Btn>
            <Btn
              small
              variant="tonal"
              className="btn-danger"
              icon="delete"
              onClick={() => {
                void historyClear(null).then(() => {
                  setArm(false);
                  bump();
                  toast(t("history.toast.clearedAll"), "ok");
                });
              }}
            >
              {t("history.set.clearGo")}
            </Btn>
          </span>
        ) : (
          <Btn small variant="tonal" icon="delete" disabled={!n} onClick={() => setArm(true)}>
            {t("history.set.clearAll")}
          </Btn>
        )}
      </SetRow>
      <div className="set-foot-note">
        <Icon name="laptop_mac" size={13} /> {t("history.set.note")}
      </div>
    </>
  );
}
