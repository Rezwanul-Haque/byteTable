// Typesense curation tab (M30 Task 7, ported from typesense-shell.jsx
// TsCurationTab): the synonym table (id, one-way/multi-way, root, synonym chips)
// and the curation-rule table (id, `q <match> "query"`, pins with positions,
// hides), each row with a "try in playground" button that seeds the query.
//
// Read-only: this view explains the pins and hides the playground is applying,
// which is what makes an otherwise inexplicable result order legible. Editing
// curation is not in scope for this milestone.
//
// Both reads need an admin key. On v30+ they come from the top-level
// `/synonym_sets` and `/curation_sets`; below that, from the per-collection
// endpoints. The adapter picks; this component sees one shape either way.

import { useCallback, useEffect, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Icon } from "../../../../shared/ui/Icon";
import { typesenseCurations, typesenseSynonyms, type CurationInfo, type SynonymInfo } from "../api";
import { TsAdminRequired, TsError, TsLoading } from "./TsBits";

interface TsCurationTabProps {
  handleId: string;
  collection: string;
  adminKey: boolean;
  onOpenSearch: (coll: string, seedQuery?: string) => void;
}

export function TsCurationTab({
  handleId,
  collection,
  adminKey,
  onOpenSearch,
}: TsCurationTabProps) {
  const t = useT();
  const [synonyms, setSynonyms] = useState<SynonymInfo[]>([]);
  const [curations, setCurations] = useState<CurationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!collection || !adminKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [syn, cur] = await Promise.all([
        typesenseSynonyms(handleId, collection),
        typesenseCurations(handleId, collection),
      ]);
      setSynonyms(syn);
      setCurations(cur);
    } catch (e) {
      setError(isAppErrorPayload(e) ? e.message : t("tsx.curation.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [handleId, collection, adminKey, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!adminKey) return <TsAdminRequired what="tsx.whatSynonyms" />;
  if (!collection) {
    return (
      <div className="ts-empty">
        <Icon name="tune" size={26} style={{ color: "var(--text-faint)" }} />
        <p>{t("tsx.curation.noCollection")}</p>
      </div>
    );
  }
  if (loading) return <TsLoading what="tsx.whatCuration" />;
  if (error) return <TsError message={error} />;

  return (
    <div className="rdash" data-screen-label={"Typesense curation: " + collection}>
      <div className="rdash-head">
        <Icon name="tune" size={20} style={{ color: "var(--accent)" }} />
        <h2>{t("tsx.curation.head", { name: collection })}</h2>
        <span className="structure-sub">
          {t("tsx.curation.sub", { synonyms: synonyms.length, rules: curations.length })}
        </span>
      </div>

      <div className="rdash-panel" style={{ marginBottom: 16 }}>
        <h3>
          <Icon name="swap_calls" size={15} /> {t("tsx.curation.synonyms")}
        </h3>
        {synonyms.length === 0 ? (
          <div className="ts-facet-none">{t("tsx.curation.noSynonyms")}</div>
        ) : (
          <div className="ts-tablewrap">
            <table className="structure-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>{t("tsx.curation.thId")}</th>
                  <th>{t("tsx.curation.thType")}</th>
                  <th>{t("tsx.curation.thRoot")}</th>
                  <th>{t("tsx.curation.thSynonyms")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {synonyms.map((s) => (
                  <tr key={s.id}>
                    <td className="st-name">{s.id}</td>
                    {/* A root makes it one-way (root → synonyms); without one every
                      term is interchangeable. */}
                    <td>{s.root ? t("tsx.curation.oneWay") : t("tsx.curation.multiWay")}</td>
                    <td className="mg-mono cass-dash-key">{s.root ?? "—"}</td>
                    <td>
                      {s.synonyms.map((w) => (
                        <span key={w} className="ts-syn-chip">
                          {w}
                        </span>
                      ))}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="ts-row-act"
                        title={t("tsx.curation.tryInPlayground")}
                        onClick={() => onOpenSearch(collection, s.root ?? s.synonyms[0] ?? "")}
                      >
                        <Icon name="search" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rdash-panel">
        <h3>
          <Icon name="push_pin" size={15} /> {t("tsx.curation.rulesHead")}
        </h3>
        {curations.length === 0 ? (
          <div className="ts-facet-none">{t("tsx.curation.noRules")}</div>
        ) : (
          <div className="ts-tablewrap">
            <table className="structure-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>{t("tsx.curation.thId")}</th>
                  <th>{t("tsx.curation.thRule")}</th>
                  <th>{t("tsx.curation.thPins")}</th>
                  <th>{t("tsx.curation.thHides")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {curations.map((o) => (
                  <tr key={o.id}>
                    <td className="st-name">{o.id}</td>
                    <td className="mg-mono cass-dash-key">
                      q {o.ruleMatch} “{o.ruleQuery}”
                    </td>
                    <td>
                      {o.includes.length
                        ? o.includes.map((i) => (
                            <span key={i.id} className="ts-syn-chip">
                              {i.id} @{i.position}
                            </span>
                          ))
                        : "—"}
                    </td>
                    <td>
                      {o.excludes.length
                        ? o.excludes.map((id) => (
                            <span key={id} className="ts-syn-chip hide">
                              {id}
                            </span>
                          ))
                        : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="ts-row-act"
                        title={t("tsx.curation.tryInPlayground")}
                        onClick={() =>
                          onOpenSearch(collection, o.ruleQuery === "*" ? "" : o.ruleQuery)
                        }
                      >
                        <Icon name="search" size={13} />
                      </button>
                    </td>
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
