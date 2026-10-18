// Tables dashboard (M17 §17.1): the default tab when a DynamoDB workspace
// opens. One row per table — Items / GSIs / Billing / Size — with left-aligned
// numeric cells (`.ddb-dash-num`). Ported from `DynamoDashboard` in
// `dynamo-shell.jsx`.

import { useT } from "../../../../shared/i18n/useT";
import { Icon } from "../../../../shared/ui/Icon";
import { EngineMark } from "../../../../shared/ui/EngineMark";
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
  const t = useT();
  const totalItems = tables.reduce((a, t) => a + t.itemCount, 0);
  const totalSize = tables.reduce((a, t) => a + t.sizeBytes, 0);
  const totalGsi = tables.reduce((a, t) => a + t.gsis.length, 0);

  return (
    <div className="ddb-dash">
      <div className="ddb-dash-head">
        <EngineMark engine="dynamodb" size={22} />
        <h2>{t("dyn.dash.title")}</h2>
        <span className="ddb-dash-sub">{region}</span>
      </div>

      <div className="ddb-dash-grid">
        <Stat label={t("dyn.dash.tables")} val={tables.length} />
        <Stat label={t("dyn.dash.totalItems")} val={totalItems.toLocaleString()} />
        <Stat
          label={t("dyn.dash.totalSize")}
          val={t("dyn.kb", { count: (totalSize / 1024).toFixed(1) })}
        />
        <Stat label="GSIs" val={totalGsi} />
      </div>

      <div className="ddb-dash-panel">
        <h3>
          <Icon name="table_chart" size={15} /> {t("dyn.dash.tables")}
        </h3>
        {error ? (
          <div className="ddb-tab-error">
            <Icon name="error" size={16} /> {error}
          </div>
        ) : loading && tables.length === 0 ? (
          <div className="ddb-dash-empty">{t("dyn.dash.loading")}</div>
        ) : (
          <table className="ddb-structure-table">
            <thead>
              <tr>
                <th>{t("dyn.dash.colName")}</th>
                <th>{t("dyn.dash.colKeys")}</th>
                <th>{t("dyn.dash.colItems")}</th>
                <th>{t("dyn.dash.colGsis")}</th>
                <th>{t("dyn.dash.colBilling")}</th>
                <th>{t("dyn.dash.colSize")}</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((ty) => (
                <tr key={ty.name}>
                  <td className="ddb-st-name">{ty.name}</td>
                  <td className="ddb-st-type">
                    {ty.keySchema.pk}
                    {ty.keySchema.sk ? " / " + ty.keySchema.sk : ""}
                  </td>
                  <td className="ddb-dash-num">{ty.itemCount.toLocaleString()}</td>
                  <td className="ddb-dash-num">{ty.gsis.length}</td>
                  <td>
                    {ty.billing === "PAY_PER_REQUEST"
                      ? t("dyn.billing.onDemand")
                      : t("dyn.billing.provisioned")}
                  </td>
                  <td className="ddb-dash-num">
                    {t("dyn.kb", { count: (ty.sizeBytes / 1024).toFixed(1) })}
                  </td>
                </tr>
              ))}
              {!loading && tables.length === 0 ? (
                <tr>
                  <td colSpan={6} className="ddb-dash-empty">
                    {t("dyn.dash.noTables")}
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
