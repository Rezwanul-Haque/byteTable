// Settings → Masking (M49 F): the switch, the four categories, the custom
// column list, a live preview and what masking does not cover. Ported from the
// prototype's MaskSettingsPane.

import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { SetRow, SetToggle } from "../../settings/components/SetControls";
import { useSettingsStore } from "../../settings/state";
import { kindOf, render } from "../mask";
import "./Masking.css";

/** Fixed sample rows: column, value. */
const SAMPLE: [string, string][] = [
  ["email", "grace.rossi@fastmail.com"],
  ["customer_phone", "+31 20 555 0142"],
  ["api_token", "sk_live_9fQ2xLr8TzB1mVe7"],
  ["full_name", "Grace Rossi"],
  ["country", "DE"],
];

export function MaskSettingsPane() {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const toggle = (
    key: "maskOn" | "maskEmail" | "maskPhone" | "maskSecret" | "maskPerson",
    label: string,
    hint: string,
  ) => (
    <SetRow label={label} hint={hint}>
      <SetToggle on={settings[key]} onChange={(v) => setSetting(key, v)} label={label} />
    </SetRow>
  );
  return (
    <>
      <div className="set-section-label">{t("mask.set.section")}</div>
      {toggle("maskOn", t("mask.set.on"), t("mask.set.onHint"))}
      <div className="set-section-label">{t("mask.set.what")}</div>
      {toggle("maskEmail", t("mask.set.email"), t("mask.set.emailHint"))}
      {toggle("maskPhone", t("mask.set.phone"), t("mask.set.phoneHint"))}
      {toggle("maskSecret", t("mask.set.secret"), t("mask.set.secretHint"))}
      {toggle("maskPerson", t("mask.set.person"), t("mask.set.personHint"))}
      <SetRow label={t("mask.set.custom")} hint={t("mask.set.customHint")}>
        <input
          className="mask-input"
          value={settings.maskCustom}
          spellCheck={false}
          placeholder="salary, *_note"
          aria-label={t("mask.set.customAria")}
          onChange={(e) => setSetting("maskCustom", e.target.value)}
        />
      </SetRow>
      <div className="set-section-label">{t("mask.set.preview")}</div>
      {/* The preview shows the categories in force whether or not the switch
          is on: it is how values WILL look. */}
      <div className="mask-preview" role="table" aria-label={t("mask.set.previewAria")}>
        {SAMPLE.map(([col, v]) => {
          const kind = kindOf(v, col, settings);
          return (
            <div key={col} className="mask-preview-row" role="row">
              <span className="mask-preview-col" role="cell">
                {col}
              </span>
              <span role="cell">{v}</span>
              <Icon name="arrow_forward" size={13} />
              {kind ? (
                <span role="cell" className="cell-mask">
                  {render(v, kind)}
                </span>
              ) : (
                <span role="cell" className="same">
                  {t("mask.set.same")}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="set-foot-note">
        <Icon name="info" size={13} /> {t("mask.set.note")}
      </div>
    </>
  );
}
