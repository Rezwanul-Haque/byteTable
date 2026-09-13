// Visual query-builder tab (the "+" tab) — opens empty, the user picks a table
// from the dropdown, then builds a Scan/Query (PK/SK condition, index,
// projection) against it. Once a table is chosen it reuses the full
// `DynamoTableTab` (key-condition row, projection picker, grid, paging) bound to
// that table; switching the dropdown rebinds it (the `key` resets its state).

import { useT } from "../../../../shared/i18n/useT";
import { Icon } from "../../../../shared/ui/Icon";
import { Select } from "../../../../shared/ui/Select";
import type { TableDescriptor } from "../api";
import { DynamoTableTab } from "./DynamoTableTab";

interface DynamoQueryTabProps {
  tables: TableDescriptor[];
  handleId: string;
  isProduction: boolean;
  version: number;
  /** Selected table name (persisted on the tab) — "" until the user picks one. */
  table: string;
  /** Open the table picker straight away — set for a tab the user just opened,
   *  which has nothing to show until a table is chosen. */
  pickTable?: boolean;
  onTableChange: (name: string) => void;
  mode: "scan" | "query" | "structure";
  onModeChange: (mode: "scan" | "query" | "structure") => void;
  onExport: (table: string) => void;
  onImport: (table: string) => void;
  onTruncate: (table: string) => void;
  onDelete: (table: string) => void;
  /** Whether this tab is the visible one — forwarded to the table tab. */
  active: boolean;
}

export function DynamoQueryTab({
  tables,
  handleId,
  isProduction,
  version,
  table,
  pickTable = false,
  onTableChange,
  mode,
  onModeChange,
  onExport,
  onImport,
  onTruncate,
  onDelete,
  active,
}: DynamoQueryTabProps) {
  const t = useT();
  const desc = tables.find((tb) => tb.name === table);
  const options = [
    { value: "", label: t("dyn.qt.selectPh") },
    ...tables.map((tb) => ({ value: tb.name, label: tb.name })),
  ];

  return (
    <div className="ddb-qb">
      <div className="ddb-qb-head">
        <span className="ddb-proj-label">
          <Icon name="table_chart" size={13} /> {t("dyn.qt.table")}
        </span>
        <Select
          className="ddb-q-select ddb-qb-select"
          value={table}
          options={options}
          onChange={onTableChange}
          autoOpen={pickTable && !table}
          aria-label={t("dyn.qt.aria")}
        />
        {desc ? (
          <span className="ddb-qb-keys">
            <span className="ddb-tag ddb-tag-pk">PK {desc.keySchema.pk}</span>
            {desc.keySchema.sk ? (
              <span className="ddb-tag ddb-tag-sk">SK {desc.keySchema.sk}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      {desc ? (
        <DynamoTableTab
          key={desc.name}
          table={desc}
          handleId={handleId}
          isProduction={isProduction}
          mode={mode === "structure" ? "structure" : mode}
          onModeChange={onModeChange}
          version={version}
          onExport={onExport}
          onImport={onImport}
          onTruncate={onTruncate}
          onDelete={onDelete}
          active={active}
        />
      ) : (
        <div className="ddb-qb-empty">
          <Icon name="search" size={32} />
          <p>{t("dyn.qt.hint")}</p>
        </div>
      )}
    </div>
  );
}
