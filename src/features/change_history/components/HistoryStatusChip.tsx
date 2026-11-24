// Status bar: how many changes can still be undone, or "history paused"
// (M48 F2). Opens the Change history tab.

import { useEffect, useState } from "react";

import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { useSettingsStore } from "../../settings/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { historyList } from "../api";
import { undoable } from "../model";
import { useHistoryStore } from "../state";

export function HistoryStatusChip({ connectionId }: { connectionId: string }) {
  const t = useT();
  const on = useSettingsStore((s) => s.settings.undoRecord);
  const connOn = useHistoryStore((s) => s.recording[connectionId] ?? true);
  const loadRecording = useHistoryStore((s) => s.loadRecording);
  const version = useHistoryStore((s) => s.version);
  const openHistoryTab = useWorkspacesStore((s) => s.openHistoryTab);
  const [n, setN] = useState(0);

  useEffect(() => {
    void loadRecording(connectionId);
  }, [connectionId, loadRecording]);
  useEffect(() => {
    let live = true;
    historyList(connectionId)
      .then((list) => live && setN(list.filter(undoable).length))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connectionId, version]);

  const rec = on && connOn;
  return (
    <button
      type="button"
      className="status-btn"
      title={rec ? t("history.chip.hint", { count: n }) : t("history.chip.pausedHint")}
      onClick={() => openHistoryTab()}
    >
      <Icon name={rec ? "history" : "history_toggle_off"} size={13} />{" "}
      {rec ? t("history.chip", { n }) : t("history.chip.paused")}
    </button>
  );
}
