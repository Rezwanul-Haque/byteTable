// The Ask button for a non-SQL workspace's tab-bar tools — beside the shell
// toggle, styled by the host's own tool class. Off opens Settings on the AI
// tab; locked or on toggles the drawer (which explains a lock itself).

import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import type { Workspace } from "../../workspaces/types";
import { useAssistant } from "../hooks/useAssistant";
import { openAiSettings } from "../openSettings";
import { hostKey, useAssistantStore } from "../state";

export function AiAskTool({ workspace, className }: { workspace: Workspace; className: string }) {
  const t = useT();
  const key = hostKey(workspace.id);
  const { state } = useAssistant({
    id: workspace.saved.id,
    env: workspace.saved.env,
    name: workspace.saved.name,
  });
  const open = useAssistantStore((s) => !!s.open[key]);
  const setOpen = useAssistantStore((s) => s.setOpen);
  return (
    <button
      type="button"
      className={
        className + (open ? " active" : "") + (state === "locked" ? " ai-tool-locked" : "")
      }
      aria-pressed={open}
      onClick={() => (state === "off" && !open ? openAiSettings() : setOpen(key, !open))}
      title={
        state === "on"
          ? t("ai.ask.btnTitle")
          : state === "locked"
            ? t("ai.ask.btnLocked")
            : t("ai.ask.btnOff")
      }
    >
      <Icon name={state === "locked" ? "lock" : "auto_awesome"} size={15} /> {t("ai.ask.btn")}
    </button>
  );
}
