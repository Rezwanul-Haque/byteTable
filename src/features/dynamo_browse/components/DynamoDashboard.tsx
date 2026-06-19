// Tables dashboard (M17 §17.1): the default tab when a DynamoDB workspace
// opens. One row per table — Items / GSIs / Billing / Size — with left-aligned
// numeric cells (`.ddb-dash-num`). Ported from `DynamoDashboard` in
// `dynamo-shell.jsx`.

import { Icon } from "../../../shared/ui/Icon";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import type { TableDescriptor } from "../api";

interface DynamoDashboardProps {
  tables: TableDescriptor[];
  region: string;
  loading: boolean;
  error: string | null;
}

function Stat({ label, val }: { label: string; val: string | number }) {
  return (
    <div className="ddb-dash-stat">
      <div className="ddb-dash-stat-label">{label}</div>
      <div className="ddb-dash-stat-value">{val}</div>
    </div>
  );
}

export function DynamoDashboard({ tables, region, loading, error }: DynamoDashboardProps) {
  const totalItems = tables.reduce((a, t) => a + t.itemCount, 0);
  const totalSize = tables.reduce((a, t) => a + t.sizeBytes, 0);
  const totalGsi = tables.reduce((a, t) => a + t.gsis.length, 0);

  return (
    <div className="ddb-dash">
      <div className="ddb-dash-head">
        <EngineBadge engine="dynamodb" size={22} />
        <h2>Tables dashboard</h2>
        <span className="ddb-dash-sub">{region}</span>
      </div>

      <div className="ddb-dash-grid">
        <Stat label="Tables" val={tables.length} />
        <Stat label="Total items" val={totalItems.toLocaleString()} />
        <Stat label="Total size" val={(totalSize / 1024).toFixed(1) + " KB"} />
        <Stat label="GSIs" val={totalGsi} />
      </div>

      <div className="ddb-dash-panel">
        <h3>
          <Icon name="table_chart" size={15} /> Tables
        </h3>
        {error ? (
          <div className="ddb-tab-error">
            <Icon name="error" size={16} /> {error}
          </div>
        ) : loading && tables.length === 0 ? (
          <div className="ddb-dash-empty">Loading tables…</div>
        ) : (
          <table className="ddb-structure-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Keys</th>
                <th>Items</th>
                <th>GSIs</th>
                <th>Billing</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.name}>
                  <td className="ddb-st-name">{t.name}</td>
                  <td className="ddb-st-type">
                    {t.keySchema.pk}
                    {t.keySchema.sk ? " / " + t.keySchema.sk : ""}
                  </td>
                  <td className="ddb-dash-num">{t.itemCount.toLocaleString()}</td>
                  <td className="ddb-dash-num">{t.gsis.length}</td>
                  <td>{t.billing === "PAY_PER_REQUEST" ? "On-demand" : "Provisioned"}</td>
                  <td className="ddb-dash-num">{(t.sizeBytes / 1024).toFixed(1)} KB</td>
                </tr>
              ))}
              {!loading && tables.length === 0 ? (
                <tr>
                  <td colSpan={6} className="ddb-dash-empty">
                    No tables in this region.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
