// BINARY(n) / UUID cell editor modal — ported from the prototype's
// binary-cell.jsx onto the shared Modal primitive. Accepts a canonical UUID
// (16-byte columns) or `0x`-hex of exactly the column's byte length; shows the
// UUID + stored-bytes representations; "Generate" makes a random UUID. Empty
// saves NULL. The saved value is the UUID (16-byte) or `0x`-HEX string — the
// backend binds it as raw bytes for the binary column.

import { useEffect, useRef, useState } from "react";

import type { CellValue } from "../../../shared/api/engine";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions } from "../../../shared/ui/Modal";
import { binaryBytes, generateUuid, looksUuid, validateBinary } from "./binaryCell";
import "./CellEditors.css";

interface BinaryEditorModalProps {
  schemaName: string;
  table: string;
  column: string;
  type: string;
  value: CellValue;
  onSave: (next: string | null) => void;
  onClose: () => void;
}

export function BinaryEditorModal({
  schemaName,
  table,
  column,
  type,
  value,
  onSave,
  onClose,
}: BinaryEditorModalProps) {
  const expect = binaryBytes(type) ?? 16;
  const init = looksUuid(value) ? String(value).toLowerCase() : value == null ? "" : String(value);
  const [text, setText] = useState(init);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const res = validateBinary(text, type);
  const dirty = text.trim() !== init;

  const save = () => {
    if (!res.ok) return;
    if (res.empty) {
      onSave(null);
      return;
    }
    // Prefer the canonical UUID for 16-byte columns, else 0x-HEX.
    onSave(res.uuid ?? "0x" + res.hex.toUpperCase());
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") onClose();
  };

  const uuidRepr = res.ok && !res.empty ? (res.uuid ?? "—") : res.ok ? "∅" : "—";
  const bytesRepr = res.ok && !res.empty ? "0x" + res.hex.toUpperCase() : res.ok ? "NULL" : "—";

  return (
    <Modal className="binary-modal" width={460} label="Edit binary value" onClose={onClose}>
      <div className="modal-title">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="tag" size={17} style={{ color: "var(--accent)" }} />
          <span className="json-title-col">
            {schemaName}.{table}.<b>{column}</b>
          </span>
          <span className="json-type-tag">{type}</span>
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close (Esc)" />
      </div>

      <label className="binary-field">
        <span className="binary-label">
          Value <span className="binary-sub">UUID or 0x-hex · {expect} bytes</span>
        </span>
        <input
          ref={inputRef}
          className={"binary-input" + (res.ok ? "" : " err")}
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="b1e7a4c2-3f9d-4a1e-8c77-2d5f6a0b9e34"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
      </label>

      <div className="binary-repr">
        <div className="binary-repr-row">
          <span>UUID</span>
          <code>{uuidRepr}</code>
        </div>
        <div className="binary-repr-row">
          <span>Stored bytes</span>
          <code>{bytesRepr}</code>
        </div>
      </div>

      <div className={"json-status" + (res.ok ? " ok" : " err")}>
        <Icon name={res.ok ? "check_circle" : "error"} size={14} />
        <span>
          {res.ok
            ? res.empty
              ? "Empty → will save as NULL"
              : "Valid · " + expect + " bytes"
            : res.message}
        </span>
      </div>

      <ModalActions>
        <button
          type="button"
          className="json-tool"
          onClick={() => setText(generateUuid())}
          title="Generate a random UUID"
        >
          <Icon name="autorenew" size={14} /> Generate
        </button>
        <div style={{ flex: 1 }} />
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="filled" icon="check" onClick={save} disabled={!res.ok || !dirty}>
          Save
        </Btn>
      </ModalActions>
    </Modal>
  );
}
