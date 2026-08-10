// Typesense API keys tab (M30 Task 7, ported from typesense-shell.jsx
// TsKeysTab): id, description, `prefix••••••••`, action chips (`*` tinted warn),
// collection scope, expiry (`never` when unset), plus the aliases table.
//
// Security: Typesense returns only a key's `value_prefix` — the full key is
// unretrievable after creation by design, and the wire type has no field for
// one. Nothing here can display or store a full key.

import { useCallback, useEffect, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
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
      setError(isAppErrorPayload(e) ? e.message : "Could not load API keys.");
    } finally {
      setLoading(false);
    }
  }, [handleId, adminKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!adminKey) return <TsAdminRequired what="API keys" />;
  if (loading) return <TsLoading what="API keys" />;
  if (error) return <TsError message={error} />;

  return (
    <div className="rdash" data-screen-label="Typesense API keys">
      <div className="rdash-head">
        <Icon name="key" size={20} style={{ color: "var(--accent)" }} />
        <h2>API keys</h2>
        <span className="structure-sub">
          {keys.length} {keys.length === 1 ? "key" : "keys"} · only prefixes are retrievable after
          creation
        </span>
      </div>

      <div className="rdash-panel">
        {keys.length === 0 ? (
          <div className="ts-facet-none">this cluster has no API keys beyond the bootstrap key</div>
        ) : (
          <div className="ts-tablewrap">
            <table className="structure-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>id</th>
                  <th>Description</th>
                  <th>Prefix</th>
                  <th>Actions</th>
                  <th>Collections</th>
                  <th>Expires</th>
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
                    <td>{k.expiresAt ? tsDate(k.expiresAt) : "never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rdash-panel" style={{ marginTop: 16 }}>
        <h3>
          <Icon name="link" size={15} /> Aliases
        </h3>
        {aliases.length === 0 ? (
          <div className="ts-facet-none">no aliases are defined on this cluster</div>
        ) : (
          <div className="ts-tablewrap">
            <table className="structure-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Alias</th>
                  <th>Target collection</th>
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
