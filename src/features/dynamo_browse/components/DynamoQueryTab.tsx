// Visual query-builder tab (the "+" tab) — opens empty, the user picks a table
// from the dropdown, then builds a Scan/Query (PK/SK condition, index,
// projection) against it. Once a table is chosen it reuses the full
// `DynamoTableTab` (key-condition row, projection picker, grid, paging) bound to
// that table; switching the dropdown rebinds it (the `key` resets its state).

import { Icon } from "../../../shared/ui/Icon";
import { Select } from "../../../shared/ui/Select";
import type { TableDescriptor } from "../api";
import { DynamoTableTab } from "./DynamoTableTab";

interface DynamoQueryTabProps {
  tables: TableDescriptor[];
  handleId: string;
  isProduction: boolean;
  version: number;
  /** Selected table name (persisted on the tab) — "" until the user picks one. */
  table: string;
  onTableChange: (name: string) => void;
  mode: "scan" | "query" | "structure";
  onModeChange: (mode: "scan" | "query" | "structure") => void;
  onExport: (table: string) => void;
  onImport: (table: string) => void;
}

export function DynamoQueryTab({
  tables,
  handleId,
  isProduction,
  version,
  table,
  onTableChange,
  mode,
  onModeChange,
  onExport,
  onImport,
}: DynamoQueryTabProps) {
  const desc = tables.find((t) => t.name === table);
  const options = [
    { value: "", label: "Select a table…" },
    ...tables.map((t) => ({ value: t.name, label: t.name })),
  ];

  return (
    <div className="ddb-qb">
      <div className="ddb-qb-head">
        <span className="ddb-proj-label">
          <Icon name="table_chart" size={13} /> Table
        </span>
        <Select
          className="ddb-q-select ddb-qb-select"
          value={table}
          options={options}
          onChange={onTableChange}
          aria-label="Query a table"
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
        />
      ) : (
        <div className="ddb-qb-empty">
          <Icon name="search" size={32} />
          <p>Pick a table above to build a Scan or Query.</p>
        </div>
      )}
    </div>
  );
}
