// Cassandra row editor modal (M19 §19.3, ported from cassandra.jsx CassRowModal):
// full-row / complex-type editing. Primary-key columns are locked on edit
// (changing a key = delete + re-insert); set/list/map edit as comma / k:v text.
// Save runs a full INSERT (new) or full-primary-key UPDATE (edit); Delete runs a
// full-primary-key DELETE. Writes to a production connection require confirmation.

import { useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import {
  cassDeleteRow,
  cassInsertRow,
  cassUpdateRow,
  keyColumns,
  keyMap,
  type TableDescriptor,
} from "../api";
import { baseType, cqlIsNumeric } from "../cqlTypes";

type Row = Record<string, unknown>;

interface CassRowModalProps {
  table: TableDescriptor;
  ks: string;
  handleId: string;
  row: Row;
  isNew?: boolean;
  isProduction?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function seedValue(type: string): unknown {
  const bt = baseType(type);
  if (bt === "set" || bt === "list") return [];
  if (bt === "map") return {};
  return "";
}

export function CassRowModal({
  table,
  ks,
  handleId,
  row,
  isNew,
  isProduction,
  onClose,
  onSaved,
}: CassRowModalProps) {
  const toast = useToast();
  const keyCols = new Set(keyColumns(table));
  const [draft, setDraft] = useState<Row>(() => {
    const o: Row = {};
    table.columns.forEach((c) => {
      o[c.name] = row[c.name] !== undefined ? row[c.name] : seedValue(c.type);
    });
    return o;
  });
  const [dirty, setDirty] = useState(!!isNew);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<null | "save" | "delete">(null);

  const setField = (name: string, val: unknown) => {
    setDraft((d) => ({ ...d, [name]: val }));
    setDirty(true);
  };

  const editForType = (cName: string, cType: string) => {
    const bt = baseType(cType);
    const locked = keyCols.has(cName) && !isNew;
    if (locked)
      return <input className="cass-field" value={String(draft[cName] ?? "")} readOnly disabled />;
    if (bt === "boolean")
      return (
        <select
          className="cass-field"
          value={String(draft[cName])}
          onChange={(e) => setField(cName, e.target.value === "true")}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    if (bt === "set" || bt === "list")
      return (
        <input
          className="cass-field mg-mono"
          value={(Array.isArray(draft[cName]) ? (draft[cName] as unknown[]) : []).join(", ")}
          placeholder="a, b, c"
          onChange={(e) =>
            setField(
              cName,
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      );
    if (bt === "map")
      return (
        <input
          className="cass-field mg-mono"
          value={Object.entries((draft[cName] as Record<string, unknown>) ?? {})
            .map(([k, v]) => k + ":" + v)
            .join(", ")}
          placeholder="k1:v1, k2:v2"
          onChange={(e) =>
            setField(
              cName,
              Object.fromEntries(
                e.target.value
                  .split(",")
                  .map((p) => p.split(":").map((x) => x.trim()))
                  .filter((p) => p[0]),
              ),
            )
          }
        />
      );
    const numeric = cqlIsNumeric(cType);
    return (
      <input
        className="cass-field mg-mono"
        type={numeric ? "number" : "text"}
        value={String(draft[cName] ?? "")}
        onChange={(e) =>
          setField(
            cName,
            numeric ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value,
          )
        }
      />
    );
  };

  const doSave = async () => {
    if (isProduction && confirming !== "save") {
      setConfirming("save");
      return;
    }
    setBusy(true);
    try {
      if (isNew) {
        const out: Row = {};
        table.columns.forEach((c) => {
          out[c.name] = draft[c.name];
        });
        await cassInsertRow(handleId, ks, table.name, out);
        toast("INSERT applied · " + ks + "." + table.name, "ok");
      } else {
        const set: Row = {};
        table.columns.forEach((c) => {
          if (!keyCols.has(c.name)) set[c.name] = draft[c.name];
        });
        await cassUpdateRow(handleId, ks, table.name, keyMap(table, row), set);
        toast("UPDATE applied · " + ks + "." + table.name, "ok");
      }
      onSaved();
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Write failed", "err");
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const doDelete = async () => {
    if (isProduction && confirming !== "delete") {
      setConfirming("delete");
      return;
    }
    setBusy(true);
    try {
      await cassDeleteRow(handleId, ks, table.name, keyMap(table, row));
      toast("DELETE applied · " + ks + "." + table.name, "ok");
      onSaved();
      onClose();
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Delete failed", "err");
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cass-row-modal">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name={isNew ? "add" : "edit"} size={16} style={{ color: "var(--accent)" }} />
            {isNew ? "Insert row" : "Edit row"} ·{" "}
            <span className="mg-mono" style={{ color: "var(--text-dim)" }}>
              {ks}.{table.name}
            </span>
            {dirty ? <span className="ddb-edit-dot" title="Unsaved changes" /> : null}
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>
        <div className="cass-row-form">
          {table.columns.map((c) => (
            <div key={c.name} className="cass-row-field">
              <label className="cass-row-label">
                <span className="cass-row-colname">{c.name}</span>
                <span className="cass-row-coltype">{c.type}</span>
                {keyCols.has(c.name) && !isNew ? (
                  <Icon
                    name="lock"
                    size={12}
                    style={{ color: "var(--text-faint)", marginLeft: "auto" }}
                  />
                ) : null}
              </label>
              {editForType(c.name, c.type)}
            </div>
          ))}
        </div>
        {isProduction && confirming ? (
          <div className="cass-warn" style={{ borderRadius: 8 }}>
            <Icon name="gpp_maybe" size={14} /> Production — click{" "}
            {confirming === "delete" ? "Delete" : "Save"} again to confirm this write.
          </div>
        ) : null}
        <div className="modal-actions ddb-item-actions">
          {!isNew ? (
            <button className="btn btn-danger-text" onClick={() => void doDelete()} disabled={busy}>
              <Icon name="delete" size={15} /> Delete
            </button>
          ) : null}
          <div style={{ flex: 1 }} />
          <Btn variant="text" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            variant="filled"
            icon="check"
            disabled={!dirty || busy}
            onClick={() => void doSave()}
          >
            {isNew ? "Insert" : "Save"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
