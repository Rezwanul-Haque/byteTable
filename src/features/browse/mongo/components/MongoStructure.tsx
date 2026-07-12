// MongoDB Structure surface (M18 §18.5): Inferred schema (field union with type
// chips + presence bars), Indexes (key pattern + unique/sparse + Create index),
// and Validation ($jsonSchema validator, pretty-printed, or an empty state with
// an add affordance). Ported from the prototype's MongoStructure; reads real
// introspection (`mongo_infer_schema` / `mongo_list_indexes`) and writes via
// `mongo_create_index` / `mongo_set_validator`.

import { useEffect, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
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
  const [tab, setTab] = useState<"schema" | "indexes" | "validation">("schema");
  const [schema, setSchema] = useState<SchemaField[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [keysText, setKeysText] = useState('{ "field": 1 }');
  const [unique, setUnique] = useState(false);
  const [editingValidator, setEditingValidator] = useState(false);
  const [validatorText, setValidatorText] = useState("");

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
      toast("Invalid key pattern JSON: " + (e instanceof Error ? e.message : ""), "err");
      return;
    }
    try {
      await mongoCreateIndex(handleId, db, coll, { keys, unique: unique || undefined });
      toast("Index created on " + coll, "ok");
      setCreating(false);
      setReload((r) => r + 1);
      onChanged();
    } catch (e) {
      toast(appErrorMessage(e, "Could not create index"), "err");
    }
  };

  const saveValidator = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(validatorText);
    } catch (e) {
      toast("Invalid validator JSON: " + (e instanceof Error ? e.message : ""), "err");
      return;
    }
    try {
      await mongoSetValidator(handleId, db, coll, parsed);
      toast("Validator updated on " + coll, "ok");
      setEditingValidator(false);
      onChanged();
    } catch (e) {
      toast(appErrorMessage(e, "Could not update validator"), "err");
    }
  };

  return (
    <div className="mg-structure">
      <div className="mg-struct-tabs">
        <button
          className={"mg-struct-tab" + (tab === "schema" ? " active" : "")}
          onClick={() => setTab("schema")}
        >
          <Icon name="schema" size={14} /> Inferred schema{" "}
          <span className="rail-count">{schema.length}</span>
        </button>
        <button
          className={"mg-struct-tab" + (tab === "indexes" ? " active" : "")}
          onClick={() => setTab("indexes")}
        >
          <Icon name="bolt" size={14} /> Indexes{" "}
          <span className="rail-count">{indexes.length}</span>
        </button>
        <button
          className={"mg-struct-tab" + (tab === "validation" ? " active" : "")}
          onClick={() => setTab("validation")}
        >
          <Icon name="verified" size={14} /> Validation{" "}
          {validator ? <span className="mg-dot-on" /> : null}
        </button>
      </div>
      <div className="mg-struct-body">
        {tab === "schema" ? (
          <table className="structure-table mg-schema-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Type(s)</th>
                <th>Presence</th>
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
        ) : tab === "indexes" ? (
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
                  {idx.unique ? <span className="tag">unique</span> : null}
                  {idx.sparse ? <span className="tag">sparse</span> : null}
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
                  <input
                    type="checkbox"
                    checked={unique}
                    onChange={(e) => setUnique(e.target.checked)}
                  />{" "}
                  unique
                </label>
                <Btn variant="filled" small icon="check" onClick={() => void createIndex()}>
                  Create
                </Btn>
                <Btn variant="text" small onClick={() => setCreating(false)}>
                  Cancel
                </Btn>
              </div>
            ) : (
              <div className="mg-add-index">
                <Btn icon="add" variant="tonal" small onClick={() => setCreating(true)}>
                  Create index…
                </Btn>
              </div>
            )}
          </div>
        ) : (
          <div className="mg-validation">
            {editingValidator ? (
              <>
                <div className="mg-val-head">
                  <Icon name="verified" size={15} style={{ color: "var(--accent)" }} /> Edit
                  $jsonSchema validator
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
                    Cancel
                  </Btn>
                  <Btn variant="filled" small icon="save" onClick={() => void saveValidator()}>
                    Save validator
                  </Btn>
                </div>
              </>
            ) : validator ? (
              <>
                <div className="mg-val-head">
                  <Icon name="verified" size={15} style={{ color: "var(--accent)" }} /> JSON Schema
                  validator <span className="mg-val-level">strict · error</span>
                  <div style={{ flex: 1 }} />
                  <Btn
                    icon="edit"
                    variant="text"
                    small
                    onClick={() => {
                      setValidatorText(JSON.stringify(validator, null, 2));
                      setEditingValidator(true);
                    }}
                  >
                    Edit
                  </Btn>
                </div>
                <pre className="ddl-block">{JSON.stringify(validator, null, 2)}</pre>
              </>
            ) : (
              <div className="mg-no-validation">
                <Icon name="rule" size={26} style={{ color: "var(--text-faint)" }} />
                <div>
                  No schema validation on <b>{coll}</b>
                </div>
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
                  Add $jsonSchema validator…
                </Btn>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
