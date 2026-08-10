// Typesense schema tab (M30 Task 7, ported from typesense.jsx TsSchemaTab):
// head with document count / field count / default_sorting_field / memory, then
// the fields table with a type tag and check-or-dash flags for facet, sort,
// index and optional.
//
// Read-only by design: field removal is `PATCH /collections/{c}` with
// `{"drop": true}`, which the milestone defers until there is a confirm flow
// listing every query_by / facet_by / sort_by / curation rule that references
// the field.

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
  if (!collection) {
    return loading ? (
      <TsLoading what="the schema" />
    ) : (
      <div className="ts-empty">
        <Icon name="schema" size={26} style={{ color: "var(--text-faint)" }} />
        <p>No collection selected.</p>
        <span className="ts-empty-hint">Pick a collection in the sidebar to see its schema.</span>
      </div>
    );
  }

  return (
    <div className="rdash" data-screen-label={"Typesense schema: " + collection.name}>
      <div className="rdash-head">
        <EngineBadge engine="typesense" size={22} />
        <h2>{collection.name} · schema</h2>
        <span className="structure-sub">
          {tsCount(collection.numDocuments)} documents · {collection.fields.length} fields
          {collection.defaultSortingField ? (
            <>
              {" · default_sorting_field "}
              <b>{collection.defaultSortingField}</b>
            </>
          ) : null}
          {collection.memoryBytes !== undefined ? " · " + tsBytes(collection.memoryBytes) : ""}
        </span>
      </div>
      <div className="rdash-panel">
        <h3>
          <Icon name="schema" size={15} /> Fields
        </h3>
        <div className="ts-tablewrap">
          <table className="structure-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Facet</th>
                <th>Sort</th>
                <th>Index</th>
                <th>Optional</th>
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
