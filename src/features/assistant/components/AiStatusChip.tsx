// The status-bar chip (Task F1): `● {model} · local` (accent),
// `● {model} · {host}` (amber), "assistant off" (grey), "assistant locked"
// (red, lock). Click opens Settings on the AI tab. Live: it reads the settings
// store, so it changes as the settings do.

import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { useAssistant } from "../hooks/useAssistant";
import type { AiConn } from "../logic";
import { openAiSettings } from "../openSettings";
import "./Assistant.css";

export function AiStatusChip({ conn }: { conn: AiConn }) {
  const t = useT();
  const { state, d } = useAssistant(conn);
  const cls = state === "on" ? (d.local ? "local" : "remote") : state;
  return (
    <button
      type="button"
      className={"status-btn ai-status " + cls}
      onClick={openAiSettings}
      title={
        state === "off"
          ? t("ai.chip.offTitle")
          : state === "locked"
            ? t("ai.chip.lockedTitle")
            : t("ai.chip.onTitle", { host: d.host })
      }
    >
      {state === "locked" ? <Icon name="lock" size={11} /> : <span className="ai-status-dot" />}
      {state === "off"
        ? t("ai.chip.off")
        : state === "locked"
          ? t("ai.chip.locked")
          : t("ai.chip.on", {
              model: d.model || d.via,
              where: d.local ? t("ai.chip.local") : d.host,
            })}
    </button>
  );
}
