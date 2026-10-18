// MongoDB Structure surface (M18 §18.5): Inferred schema (field union with type
// chips + presence bars), Indexes (key pattern + unique/sparse + Create index),
// and Validation ($jsonSchema validator, pretty-printed, or an empty state with
// an add affordance). Ported from the prototype's MongoStructure; reads real
// introspection (`mongo_infer_schema` / `mongo_list_indexes`) and writes via
// `mongo_create_index` / `mongo_set_validator`.

import { useEffect, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { useReadOnly } from "../../../../shared/ui/readOnlyContext";
import { Checkbox } from "../../../../shared/ui/Checkbox";
import { Icon } from "../../../../shared/ui/Icon";
import { useToast } from "../../../../shared/ui/toastContext";
import {
  mongoCreateIndex,
  mongoInferSchema,
  mongoListIndexes,
  mongoSetValidator,
  type IndexInfo,
  type SchemaField,
} from "../api";
import { MONGO_TYPE_COLOR, type MongoType } from "../helpers";

export function MongoStructure({
  handleId,
  db,
  coll,
  validator,
  onChanged,
}: {
  handleId: string;
  db: string;
  coll: string;
  validator?: unknown;
  onChanged: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [tab, setTab] = useState<"schema" | "indexes" | "validation">("schema");
  const [schema, setSchema] = useState<SchemaField[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [keysText, setKeysText] = useState('{ "field": 1 }');
  const [unique, setUnique] = useState(false);
  const [editingValidator, setEditingValidator] = useState(false);
  const [validatorText, setValidatorText] = useState("");
  // Read-only workspace: the schema/index/validation views stay readable;
  // creating an index and writing a validator do not.
  const readOnly = useReadOnly();

  useEffect(() => {
    let live = true;
    mongoInferSchema(handleId, db, coll)
      .then((s) => live && setSchema(s))
      .catch(() => live && setSchema([]));
    mongoListIndexes(handleId, db, coll)
      .then((i) => live && setIndexes(i))
      .catch(() => live && setIndexes([]));
    return () => {
      live = false;
    };
  }, [handleId, db, coll, reload]);

  const createIndex = async () => {
    let keys: Record<string, number>;
    try {
      keys = JSON.parse(keysText);
    } catch (e) {
      toast(t("mongo.keysJsonFail", { err: e instanceof Error ? e.message : String(e) }), "err");
      return;
    }
    try {
      await mongoCreateIndex(handleId, db, coll, { keys, unique: unique || undefined });
      toast(t("mongo.indexCreated", { coll }), "ok");
      setCreating(false);
      setReload((r) => r + 1);
      onChanged();
    } catch (e) {
      toast(appErrorMessage(e, t("mongo.indexFail")), "err");
    }
  };

  const saveValidator = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(validatorText);
    } catch (e) {
      toast(
        t("mongo.validatorJsonFail", { err: e instanceof Error ? e.message : String(e) }),
        "err",
      );
      return;
    }
    try {
      await mongoSetValidator(handleId, db, coll, parsed);
      toast(t("mongo.validatorSaved", { coll }), "ok");
      setEditingValidator(false);
      onChanged();
    } catch (e) {
      toast(appErrorMessage(e, t("mongo.validatorFail")), "err");
    }
  };

  return (
    <div className="mg-structure">
      <div className="mg-struct-tabs">
        <button
          className={"mg-struct-tab" + (tab === "schema" ? " active" : "")}
          onClick={() => setTab("schema")}
        >
          <Icon name="schema" size={14} /> {t("mongo.tabSchema")}{" "}
          <span className="rail-count">{schema.length}</span>
        </button>
        <button
          className={"mg-struct-tab" + (tab === "indexes" ? " active" : "")}
          onClick={() => setTab("indexes")}
        >
          <Icon name="bolt" size={14} /> {t("mongo.statIndexes")}{" "}
          <span className="rail-count">{indexes.length}</span>
        </button>
        <button
          className={"mg-struct-tab" + (tab === "validation" ? " active" : "")}
          onClick={() => setTab("validation")}
        >
          <Icon name="verified" size={14} /> {t("mongo.tabValidation")}{" "}
          {validator ? <span className="mg-dot-on" /> : null}
        </button>
      </div>
      <div className="mg-struct-body">
        {tab === "schema" && schema.length > 0 ? (
          <table className="structure-table mg-schema-table">
            <thead>
              <tr>
                <th>{t("mongo.hField")}</th>
                <th>{t("mongo.hTypes")}</th>
                <th>{t("mongo.hPresence")}</th>
              </tr>
            </thead>
            <tbody>
              {schema.map((f) => {
                const leaf =
                  f.path
                    .split(/\.|\[\]/)
                    .filter(Boolean)
                    .pop() || f.path;
                return (
                  <tr key={f.path}>
                    <td className="st-name" style={{ paddingLeft: 12 + f.depth * 16 }}>
                      {f.depth ? <span className="mg-field-dot">└</span> : null}
                      {leaf}
                      {/\[\]$/.test(f.path) ? <span className="mg-arr-tag">[]</span> : null}
                    </td>
                    <td>
                      {f.types.map((t) => (
                        <span
                          key={t}
                          className="mg-type-chip"
                          style={{
                            color: MONGO_TYPE_COLOR[t as MongoType] ?? "var(--text-dim)",
                            borderColor: (MONGO_TYPE_COLOR[t as MongoType] ?? "#888") + "55",
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </td>
                    <td>
                      <span className="mg-presence">
                        <span className="mg-presence-bar">
                          <span
                            className="mg-presence-fill"
                            style={{
                              width: f.presence + "%",
                              background: f.presence === 100 ? "var(--accent)" : "#e2b340",
                            }}
                          />
                        </span>
                        <span className="mg-presence-num">{f.presence}%</span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {/* MongoDB is schemaless: this table is INFERRED by sampling documents,
            so a collection with none has nothing to infer and renders as bare
            column headers. Say that instead — an empty grid reads as a failure,
            and "0 fields" on a brand-new collection is the correct answer, not
            a missing one. */}
        {tab === "schema" && schema.length === 0 ? (
          <div className="mg-schema-empty">
            <Icon name="schema" size={22} style={{ color: "var(--text-faint)" }} />
            <b>{t("mongo.schemaEmptyTitle")}</b>
            <span>
              {t("mongo.schemaEmptyPre")}
              <code>{coll}</code>
              {t("mongo.schemaEmptyPost")}
            </span>
          </div>
        ) : null}
        {tab === "indexes" ? (
          <div className="mg-indexes">
            {indexes.map((idx) => (
              <div key={idx.name} className="structure-card">
                <div className="structure-card-name">
                  <Icon
                    name={idx.name === "_id_" ? "key" : "bolt"}
                    size={14}
                    style={{ color: idx.name === "_id_" ? "var(--accent)" : "#e2b340" }}
                  />
                  {idx.name}
                  {idx.unique ? <span className="tag">{t("mongo.flagUnique")}</span> : null}
                  {idx.sparse ? <span className="tag">{t("mongo.flagSparse")}</span> : null}
                </div>
                <div className="structure-card-detail mg-idx-keys-row">
                  {Object.entries(idx.keys).map(([k, dir]) => (
                    <span key={k} className="mg-idx-key">
                      <span className="mg-idx-field">{k}</span>
                      <Icon name={dir === 1 ? "arrow_upward" : "arrow_downward"} size={11} />
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {creating ? (
              <div className="structure-card mg-create-index">
                <input
                  className="where-input mg-mono"
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                  placeholder='{ "field": 1 }'
                  spellCheck={false}
                />
                <label className="mg-idx-unique">
                  <Checkbox checked={unique} onChange={(e) => setUnique(e.target.checked)} /> unique
                </label>
                <Btn variant="filled" small icon="check" onClick={() => void createIndex()}>
                  {t("mongo.create")}
                </Btn>
                <Btn variant="text" small onClick={() => setCreating(false)}>
                  {t("common.cancel")}
                </Btn>
              </div>
            ) : (
              <div className="mg-add-index" hidden={readOnly}>
                <Btn icon="add" variant="tonal" small onClick={() => setCreating(true)}>
                  {t("mongo.createIndex")}
                </Btn>
              </div>
            )}
          </div>
        ) : null}
        {tab === "validation" ? (
          <div className="mg-validation">
            {editingValidator ? (
              <>
                <div className="mg-val-head">
                  <Icon name="verified" size={15} style={{ color: "var(--accent)" }} />{" "}
                  {t("mongo.editValidator")}
                </div>
                <textarea
                  className="mg-doc-editor"
                  spellCheck={false}
                  value={validatorText}
                  onChange={(e) => setValidatorText(e.target.value)}
                />
                <div className="modal-actions">
                  <div style={{ flex: 1 }} />
                  <Btn variant="text" small onClick={() => setEditingValidator(false)}>
                    {t("common.cancel")}
                  </Btn>
                  <Btn variant="filled" small icon="save" onClick={() => void saveValidator()}>
                    {t("mongo.saveValidator")}
                  </Btn>
                </div>
              </>
            ) : validator ? (
              <>
                <div className="mg-val-head">
                  <Icon name="verified" size={15} style={{ color: "var(--accent)" }} />{" "}
                  {t("mongo.validatorLabel")} <span className="mg-val-level">strict · error</span>
                  <div style={{ flex: 1 }} />
                  {readOnly ? null : (
                    <Btn
                      icon="edit"
                      variant="text"
                      small
                      onClick={() => {
                        setValidatorText(JSON.stringify(validator, null, 2));
                        setEditingValidator(true);
                      }}
                    >
                      {t("mongo.edit")}
                    </Btn>
                  )}
                </div>
                <pre className="ddl-block">{JSON.stringify(validator, null, 2)}</pre>
              </>
            ) : (
              <div className="mg-no-validation">
                <Icon name="rule" size={26} style={{ color: "var(--text-faint)" }} />
                <div>
                  {t("mongo.noValidationPre")}
                  <b>{coll}</b>
                </div>
                {readOnly ? null : (
                  <Btn
                    icon="add"
                    variant="tonal"
                    small
                    onClick={() => {
                      setValidatorText(
                        '{\n  "$jsonSchema": {\n    "bsonType": "object",\n    "required": [],\n    "properties": {}\n  }\n}',
                      );
                      setEditingValidator(true);
                    }}
                  >
                    {t("mongo.addValidator")}
                  </Btn>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
