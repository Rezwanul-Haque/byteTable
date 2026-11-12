// The drawer's chat history: this workspace's sessions, newest first. Each is
// titled by its first message, with how many messages it holds and when it
// was last used. Picking one makes it the active thread; the trash icon drops
// it (stopping its answer if one is still streaming).

import { fmtTime } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useAssistantStore, type Thread } from "../state";

function titleOf(th: Thread | undefined): string | null {
  const first = th?.msgs.find((m) => m.role === "user");
  return first && first.role === "user" ? first.text : (th?.pending?.say ?? null);
}

export function AiSessionList({ wsKey, onPick }: { wsKey: string; onPick: () => void }) {
  const t = useT();
  const list = useAssistantStore((st) => st.sessions[wsKey]);
  const threads = useAssistantStore((st) => st.threads);
  const switchSession = useAssistantStore((st) => st.switchSession);
  const deleteSession = useAssistantStore((st) => st.deleteSession);
  const ids = list?.ids ?? [];

  return (
    <div className="ai-panel-body ai-sessions" role="list" aria-label={t("ai.sessions.title")}>
      <div className="ai-sec">{t("ai.sessions.title")}</div>
      {ids.length === 0 ? <div className="ai-sessions-empty">{t("ai.sessions.empty")}</div> : null}
      {ids.map((id) => {
        const th = threads[id];
        const title = titleOf(th);
        const count = th?.msgs.filter((m) => m.role === "user").length ?? 0;
        const active = list?.active === id;
        return (
          <div key={id} className={"ai-session" + (active ? " active" : "")} role="listitem">
            <button
              type="button"
              className="ai-session-main"
              aria-current={active ? "true" : undefined}
              onClick={() => {
                switchSession(wsKey, id);
                onPick();
              }}
            >
              <Icon name={th?.streaming ? "progress_activity" : "chat_bubble"} size={15} />
              <span className="ai-session-text">
                <span className="ai-session-t">{title ?? t("ai.sessions.untitled")}</span>
                <span className="ai-session-m">
                  {t(active ? "ai.sessions.metaCurrent" : "ai.sessions.meta", {
                    count,
                    time: th?.updatedAt ? fmtTime(th.updatedAt) : "",
                  })}
                </span>
              </span>
            </button>
            <IconBtn
              icon="delete"
              size={15}
              className="ai-session-del"
              title={t("ai.sessions.delete")}
              aria-label={t("ai.sessions.delete")}
              onClick={() => deleteSession(wsKey, id)}
            />
          </div>
        );
      })}
    </div>
  );
}
