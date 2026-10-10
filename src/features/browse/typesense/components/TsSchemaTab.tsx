// Typesense schema tab (M30 Task 7, ported from typesense.jsx TsSchemaTab):
// head with document count / field count / default_sorting_field / memory, then
// the fields table with a type tag and check-or-dash flags for facet, sort,
// index and optional.
//
// Read-only by design: field removal is `PATCH /collections/{c}` with
// `{"drop": true}`, which the milestone defers until there is a confirm flow
// listing every query_by / facet_by / sort_by / curation rule that references
// the field.

import { useT } from "../../../../shared/i18n/useT";
import { Icon } from "../../../../shared/ui/Icon";
import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import type { CollectionDescriptor } from "../api";
import { tsBytes, tsCount } from "../format";
import { TsFlag, TsLoading, TsTypeTag } from "./TsBits";

export function TsSchemaTab({
  collection,
  loading,
}: {
  collection: CollectionDescriptor | null;
  loading: boolean;
}) {
  const t = useT();
  if (!collection) {
    return loading ? (
      <TsLoading what="tsx.whatSchema" />
    ) : (
      <div className="ts-empty">
        <Icon name="schema" size={26} style={{ color: "var(--text-faint)" }} />
        <p>{t("tsx.schema.noCollection")}</p>
        <span className="ts-empty-hint">{t("tsx.schema.noCollectionHint")}</span>
      </div>
    );
  }

  return (
    <div className="rdash" data-screen-label={"Typesense schema: " + collection.name}>
      <div className="rdash-head">
        <EngineBadge engine="typesense" size={22} />
        <h2>{t("tsx.schema.head", { name: collection.name })}</h2>
        <span className="structure-sub">
          {t("tsx.schema.sub", {
            docs: tsCount(collection.numDocuments),
            fields: collection.fields.length,
          })}
          {collection.defaultSortingField ? (
            <>
              {t("tsx.schema.defaultSort")}
              <b>{collection.defaultSortingField}</b>
            </>
          ) : null}
          {collection.memoryBytes !== undefined ? " · " + tsBytes(collection.memoryBytes) : ""}
        </span>
      </div>
      <div className="rdash-panel">
        <h3>
          <Icon name="schema" size={15} /> {t("tsx.schema.fields")}
        </h3>
        <div className="ts-tablewrap">
          <table className="structure-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>{t("tsx.schema.thField")}</th>
                <th>{t("tsx.schema.thType")}</th>
                <th>{t("tsx.schema.thFacet")}</th>
                <th>{t("tsx.schema.thSort")}</th>
                <th>{t("tsx.schema.thIndex")}</th>
                <th>{t("tsx.schema.thOptional")}</th>
              </tr>
            </thead>
            <tbody>
              {collection.fields.map((f) => (
                <tr key={f.name}>
                  <td className="st-name">{f.name}</td>
                  <td>
                    <TsTypeTag type={f.type} />
                  </td>
                  <td>
                    <TsFlag on={f.facet} />
                  </td>
                  <td>
                    <TsFlag on={f.sort} />
                  </td>
                  <td>
                    <TsFlag on={f.index} />
                  </td>
                  <td>
                    <TsFlag on={f.optional} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
