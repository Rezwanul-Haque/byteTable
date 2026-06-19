// Item editor modal (M17 §17.3): PK/SK shown locked (immutable — changing
// identity = delete+recreate, out of scope), every other attribute editable
// with a type selector (S/N/BOOL/NULL/L/M), add/remove attribute, live raw-JSON
// preview, and a manual Save (enabled only when dirty) that issues a real
// `PutItem`. Production connections confirm before the write. Ported from the
// prototype's `DynamoItemModal` in `dynamo.jsx`.

import { useMemo, useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { Select } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import { dynamoPutItem, type DynamoItem, type TableDescriptor } from "../api";
import { ddbCoerce, ddbRawOf, ddbType, DDB_TYPES } from "../helpers";

interface AttrRow {
  name: string;
  type: string;
  raw: string;
}

interface DynamoItemModalProps {
  item: DynamoItem;
  table: TableDescriptor;
  handleId: string;
  isProduction: boolean;
  onClose: () => void;
  /** Called after a successful PutItem so the grid can refetch. */
  onSaved: () => void;
}

export function DynamoItemModal({
  item,
  table,
  handleId,
  isProduction,
  onClose,
  onSaved,
}: DynamoItemModalProps) {
  const keyAttrs = [table.keySchema.pk, table.keySchema.sk].filter(Boolean) as string[];
  const isKey = (k: string) => keyAttrs.includes(k);

  const [rows, setRows] = useState<AttrRow[]>(() =>
    Object.keys(item).map((k) => ({ name: k, type: ddbType(item[k]), raw: ddbRawOf(item[k]) })),
  );
  const [dirty, setDirty] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const setRow = (i: number, patch: Partial<AttrRow>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const removeRow = (i: number) => {
    setRows((rs) => rs.filter((_, j) => j !== i));
    setDirty(true);
  };
  const changeType = (i: number, type: string) => {
    const cur = rows[i];
    if (!cur) return;
    setRow(i, {
      type,
      raw:
        type === "BOOL"
          ? cur.raw === "true"
            ? "true"
            : "false"
          : type === "NULL"
            ? ""
            : type === "M"
              ? "{\n  \n}"
              : type === "L"
                ? "[\n  \n]"
                : cur.raw,
    });
  };
  const addAttr = () => {
    const nm = newName.trim();
    if (!nm) {
      toast("Enter an attribute name", "err");
      return;
    }
    if (rows.some((r) => r.name === nm)) {
      toast("Attribute “" + nm + "” already exists", "err");
      return;
    }
    setRows((rs) => [...rs, { name: nm, type: "S", raw: "" }]);
    setNewName("");
    setDirty(true);
  };

  // Validate + build the draft item (invalid = the first attr whose JSON fails).
  const { draft, invalid, json } = useMemo(() => {
    let invalidName: string | null = null;
    const d: DynamoItem = {};
    for (const r of rows) {
      try {
        d[r.name] = ddbCoerce(r.type, r.raw);
      } catch {
        invalidName = r.name;
        d[r.name] = r.raw;
      }
    }
    return { draft: d, invalid: invalidName, json: JSON.stringify(d, null, 2) };
  }, [rows]);

  const save = async () => {
    if (invalid) {
      toast("Invalid JSON in attribute “" + invalid + "”", "err");
      return;
    }
    if (isProduction) {
      const ok = window.confirm(
        "This connection is a PRODUCTION environment.\n\nPutItem will overwrite this item in " +
          table.name +
          ". Continue?",
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      await dynamoPutItem(handleId, table.name, draft);
    } catch (error) {
      if (isAppErrorPayload(error)) toast(error.message, "err");
      else toast("Saving items requires the desktop app", "info");
      setSaving(false);
      return;
    }
    toast(
      "PutItem on " + table.name + " — " + Object.keys(draft).length + " attributes saved",
      "ok",
    );
    setSaving(false);
    setDirty(false);
    onSaved();
    onClose();
  };

  return (
    <Modal label={"Edit item"} onClose={onClose} className="ddb-json-modal">
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="data_object" size={17} style={{ color: "var(--accent)" }} /> Edit item
          <span className="ddb-json-type-tag">{table.name}</span>
          {dirty ? <span className="ddb-edit-dot" title="Unsaved changes" /> : null}
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </ModalTitle>

      <div className="ddb-item-attrs ddb-item-edit">
        {rows.map((r, i) => {
          const locked = isKey(r.name);
          const badge =
            r.name === table.keySchema.pk ? "pk" : r.name === table.keySchema.sk ? "sk" : null;
          const isJson = r.type === "M" || r.type === "L";
          const rowInvalid = invalid === r.name;
          return (
            <div
              className={
                "ddb-attr-row" + (locked ? " locked" : "") + (rowInvalid ? " invalid" : "")
              }
              key={r.name}
            >
              {locked ? (
                <span className="ddb-attr-type" title={r.type}>
                  {r.type}
                </span>
              ) : (
                <Select
                  className="ddb-type-sel"
                  title="Attribute type"
                  aria-label="Attribute type"
                  value={r.type}
                  options={DDB_TYPES.map((ty) => ({ value: ty, label: ty }))}
                  onChange={(v) => changeType(i, v)}
                />
              )}
              <span className="ddb-attr-name">
                {badge ? (
                  <span className={"ddb-key-badge " + badge}>{badge.toUpperCase()}</span>
                ) : null}
                <span className="ddb-attr-nametext">{r.name}</span>
                {locked ? <Icon name="lock" size={12} className="ddb-lock" /> : null}
              </span>
              <span className="ddb-attr-val">
                {locked ? (
                  <input
                    className="ddb-val-input locked"
                    value={r.raw}
                    readOnly
                    title="Primary key — immutable. Delete & recreate the item to change it."
                  />
                ) : r.type === "NULL" ? (
                  <input className="ddb-val-input" value="null" readOnly disabled />
                ) : r.type === "BOOL" ? (
                  <Select
                    className="ddb-val-select"
                    aria-label="Boolean value"
                    mono={false}
                    value={r.raw === "true" ? "true" : "false"}
                    options={[
                      { value: "true", label: "true" },
                      { value: "false", label: "false" },
                    ]}
                    onChange={(v) => setRow(i, { raw: v })}
                  />
                ) : isJson ? (
                  <textarea
                    className="ddb-val-input ddb-val-json"
                    rows={Math.min(6, r.raw.split("\n").length)}
                    value={r.raw}
                    onChange={(e) => setRow(i, { raw: e.target.value })}
                    spellCheck={false}
                  />
                ) : (
                  <input
                    className="ddb-val-input"
                    value={r.raw}
                    onChange={(e) => setRow(i, { raw: e.target.value })}
                    spellCheck={false}
                    inputMode={r.type === "N" ? "decimal" : "text"}
                  />
                )}
              </span>
              {locked ? (
                <span className="ddb-attr-act" />
              ) : (
                <button
                  type="button"
                  className="ddb-attr-act ddb-attr-del"
                  onClick={() => removeRow(i)}
                  title="Remove attribute"
                >
                  <Icon name="close" size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="ddb-add-attr">
        <input
          className="ddb-val-input"
          placeholder="new attribute name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addAttr();
          }}
          spellCheck={false}
        />
        <Btn icon="add" variant="tonal" small onClick={addAttr}>
          Add attribute
        </Btn>
      </div>

      <div className="ddb-ddl-label">
        Raw JSON{" "}
        {invalid ? <span className="ddb-json-err">· invalid JSON in “{invalid}”</span> : null}
      </div>
      <pre className={"ddb-ddl-block" + (invalid ? " invalid" : "")} style={{ maxHeight: 150 }}>
        {json}
      </pre>

      <ModalActions>
        <span className="ddb-keys-hint">
          <Icon name="lock" size={12} /> PK / SK are immutable
        </span>
        <div style={{ flex: 1 }} />
        <Btn variant="text" small onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          icon="save"
          variant="filled"
          small
          disabled={!dirty || !!invalid || saving}
          onClick={() => void save()}
        >
          Save changes
        </Btn>
      </ModalActions>
    </Modal>
  );
}
