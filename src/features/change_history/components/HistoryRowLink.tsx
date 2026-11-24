// Row inspector header: how many recorded changes touched this row, opening
// the Change history filtered to it (M48 F3).

import { useEffect, useState } from "react";

import type { CellValue } from "../../../shared/api/engine";
import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { useWorkspacesStore } from "../../workspaces/state";
import { historyList } from "../api";
import { useHistoryStore } from "../state";

export function HistoryRowLink({
  connectionId,
  table,
  pk,
  keyVal,
}: {
  connectionId: string;
  table: string;
  pk: string[];
  keyVal: CellValue[];
}) {
  const t = useT();
  const version = useHistoryStore((s) => s.version);
  const openHistoryTab = useWorkspacesStore((s) => s.openHistoryTab);
  const [n, setN] = useState(0);
  const keyText = JSON.stringify(keyVal);

  useEffect(() => {
    let live = true;
    historyList(connectionId, { table, key: JSON.parse(keyText) as CellValue[] })
      .then((list) => live && setN(list.length))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connectionId, table, keyText, version]);

  return (
    <button
      type="button"
      className="ri-hist"
      disabled={!n}
      title={t(n ? "history.rowLink.hint" : "history.rowLink.none")}
      onClick={() => openHistoryTab({ filter: { table, key: keyVal, pk }, focus: "latest" })}
    >
      <Icon name="history" size={14} /> {n}
    </button>
  );
}
