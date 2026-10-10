// Typesense API keys tab (M30 Task 7, ported from typesense-shell.jsx
// TsKeysTab): id, description, `prefix••••••••`, action chips (`*` tinted warn),
// collection scope, expiry (`never` when unset), plus the aliases table.
//
// Security: Typesense returns only a key's `value_prefix` — the full key is
// unretrievable after creation by design, and the wire type has no field for
// one. Nothing here can display or store a full key.

import { useCallback, useEffect, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Icon } from "../../../../shared/ui/Icon";
import { typesenseApiKeys, type AliasInfo, type ApiKeyInfo } from "../api";
import { tsDate } from "../format";
import { TsAdminRequired, TsError, TsLoading } from "./TsBits";

export function TsKeysTab({
  handleId,
  adminKey,
  aliases,
}: {
  handleId: string;
  adminKey: boolean;
  aliases: AliasInfo[];
}) {
  const t = useT();
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!adminKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setKeys(await typesenseApiKeys(handleId));
    } catch (e) {
      setError(isAppErrorPayload(e) ? e.message : t("tsx.keys.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [handleId, adminKey, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!adminKey) return <TsAdminRequired what="tsx.whatApiKeys" />;
  if (loading) return <TsLoading what="tsx.whatApiKeys" />;
  if (error) return <TsError message={error} />;

  return (
    <div className="rdash" data-screen-label="Typesense API keys">
      <div className="rdash-head">
        <Icon name="key" size={20} style={{ color: "var(--accent)" }} />
        <h2>{t("tsx.keys.head")}</h2>
        <span className="structure-sub">{t("tsx.keys.sub", { count: keys.length })}</span>
      </div>

      <div className="rdash-panel">
        {keys.length === 0 ? (
          <div className="ts-facet-none">{t("tsx.keys.none")}</div>
        ) : (
          <div className="ts-tablewrap">
            <table className="structure-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>{t("tsx.keys.thId")}</th>
                  <th>{t("tsx.keys.thDescription")}</th>
                  <th>{t("tsx.keys.thPrefix")}</th>
                  <th>{t("tsx.keys.thActions")}</th>
                  <th>{t("tsx.keys.thCollections")}</th>
                  <th>{t("tsx.keys.thExpires")}</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td className="cass-dash-num">{k.id}</td>
                    <td className="st-name">{k.description || "—"}</td>
                    <td className="mg-mono">
                      {k.valuePrefix}
                      <span className="ts-key-mask">••••••••</span>
                    </td>
                    <td>
                      {k.actions.map((a) => (
                        <span key={a} className={"ts-syn-chip" + (a === "*" ? " admin" : "")}>
                          {a}
                        </span>
                      ))}
                    </td>
                    <td className="mg-mono cass-dash-key">{k.collections.join(", ") || "—"}</td>
                    <td>{k.expiresAt ? tsDate(k.expiresAt) : t("tsx.keys.never")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rdash-panel" style={{ marginTop: 16 }}>
        <h3>
          <Icon name="link" size={15} /> {t("tsx.keys.aliases")}
        </h3>
        {aliases.length === 0 ? (
          <div className="ts-facet-none">{t("tsx.keys.noAliases")}</div>
        ) : (
          <div className="ts-tablewrap">
            <table className="structure-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>{t("tsx.keys.thAlias")}</th>
                  <th>{t("tsx.keys.thTarget")}</th>
                </tr>
              </thead>
              <tbody>
                {aliases.map((a) => (
                  <tr key={a.name}>
                    <td className="st-name">{a.name}</td>
                    <td className="mg-mono cass-dash-key">{a.collectionName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
