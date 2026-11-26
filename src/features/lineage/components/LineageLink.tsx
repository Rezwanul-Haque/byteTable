// Row inspector header: open the lineage of the row being inspected (M50 B2).
// Shown only when the table takes part in a declared foreign key, the row has
// a single-column key, and it is not a staged new row (the caller passes no
// key for one of those).

import type { CellValue } from "../../../shared/api/engine";
import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { useWorkspacesStore } from "../../workspaces/state";
import { useLineageTable } from "../hooks/useLineageTable";

export function LineageLink({
  handleId,
  schema,
  table,
  pk,
  keyVal,
}: {
  handleId: string;
  schema: string;
  table: string;
  pk: string[];
  keyVal: CellValue[];
}) {
  const t = useT();
  const linkedPk = useLineageTable(handleId, schema, table);
  const key = keyVal[0] ?? null;
  if (!linkedPk || pk.length !== 1 || pk[0] !== linkedPk || key === null) return null;
  return (
    <button
      type="button"
      className="ri-hist"
      title={t("lineage.inspectorHint")}
      onClick={() => useWorkspacesStore.getState().openLineageTab(schema, table, key)}
    >
      <Icon name="hub" size={14} /> {t("lineage.inspector")}
    </button>
  );
}
