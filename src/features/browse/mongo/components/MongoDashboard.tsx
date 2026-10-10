// MongoDB database dashboard (M18 §18.1): stat tiles (Collections / Documents /
// Size / Indexes) + a per-collection table (docs, avg doc, indexes, validation,
// size). The default tab when a MongoDB workspace opens. Ported from the
// prototype's MongoDashboard; reads real CollectionDescriptor[].

import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { Icon } from "../../../../shared/ui/Icon";
import { useT } from "../../../../shared/i18n/useT";
import type { CollectionDescriptor } from "../api";

export function MongoDashboard({
  db,
  collections,
  serverVersion,
  loading,
  error,
}: {
  db: string;
  collections: CollectionDescriptor[];
  serverVersion: string;
  loading: boolean;
  error: string | null;
}) {
  const totalDocs = collections.reduce((a, c) => a + c.count, 0);
  const totalSize = collections.reduce((a, c) => a + c.storageBytes, 0);
  const totalIdx = collections.reduce((a, c) => a + c.indexes.length, 0);
  const t = useT();

  return (
    <div className="rdash">
      <div className="rdash-head">
        <EngineBadge engine="mongodb" size={22} />
        <h2>{t("mongo.dashTitle", { db })}</h2>
        <span className="structure-sub">{serverVersion}</span>
      </div>
      <div className="rdash-grid">
        <div className="rdash-stat">
          <div className="rdash-stat-label">{t("mongo.statCollections")}</div>
          <div className="rdash-stat-value">{collections.length}</div>
        </div>
        <div className="rdash-stat">
          <div className="rdash-stat-label">{t("mongo.statDocuments")}</div>
          <div className="rdash-stat-value">{totalDocs.toLocaleString()}</div>
        </div>
        <div className="rdash-stat">
          <div className="rdash-stat-label">{t("mongo.statDataSize")}</div>
          <div className="rdash-stat-value">{(totalSize / 1024).toFixed(1)} KB</div>
        </div>
        <div className="rdash-stat">
          <div className="rdash-stat-label">{t("mongo.statIndexes")}</div>
          <div className="rdash-stat-value">{totalIdx}</div>
        </div>
      </div>
      <div className="rdash-panel">
        <h3>
          <Icon name="folder_special" size={15} /> {t("mongo.statCollections")}
        </h3>
        {error ? (
          <div className="sql-error-msg">{error}</div>
        ) : loading ? (
          <div className="grid-empty">{t("ws.sb.loading")}</div>
        ) : (
          <table className="structure-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>{t("mongo.colName")}</th>
                <th>{t("mongo.colDocuments")}</th>
                <th>{t("mongo.colAvgDoc")}</th>
                <th>{t("mongo.colIndexes")}</th>
                <th>{t("mongo.colValidation")}</th>
                <th>{t("mongo.colSize")}</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((c) => (
                <tr key={c.name}>
                  <td className="st-name">{c.name}</td>
                  <td className="ddb-dash-num">{c.count.toLocaleString()}</td>
                  <td className="ddb-dash-num">{c.avgDocBytes} B</td>
                  <td className="ddb-dash-num">{c.indexes.length}</td>
                  <td>
                    {c.validator ? (
                      <span className="mg-yes">
                        <Icon name="verified" size={13} /> $jsonSchema
                      </span>
                    ) : (
                      <span className="mg-no">—</span>
                    )}
                  </td>
                  <td className="ddb-dash-num">{(c.storageBytes / 1024).toFixed(1)} KB</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
