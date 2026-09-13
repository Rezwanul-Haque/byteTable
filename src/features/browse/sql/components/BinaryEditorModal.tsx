// BINARY(n) / UUID cell editor modal — ported from the prototype's
// binary-cell.jsx onto the shared Modal primitive. Accepts a canonical UUID
// (16-byte columns) or `0x`-hex of exactly the column's byte length; shows the
// UUID + stored-bytes representations; "Generate" makes a random UUID. Empty
// saves NULL. The saved value is the UUID (16-byte) or `0x`-HEX string — the
// backend binds it as raw bytes for the binary column.

import { useEffect, useRef, useState } from "react";

import type { CellValue } from "../../../../shared/api/engine";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Modal, ModalActions } from "../../../../shared/ui/Modal";
import { Select } from "../../../../shared/ui/Select";
import { useT } from "../../../../shared/i18n/useT";
import {
  binaryBytes,
  generateUuidVersion,
  looksUuid,
  uuidVersions,
  validateBinary,
  type UuidVersion,
} from "../../shared/binaryCell";
import "../../shared/styles/CellEditors.css";

interface BinaryEditorModalProps {
  schemaName: string;
  table: string;
  column: string;
  type: string;
  value: CellValue;
  onSave: (next: string | null) => void;
  onClose: () => void;
  /** View-only (e.g. a binary primary key): no editing, generate, or save. */
  readOnly?: boolean;
}

export function BinaryEditorModal({
  schemaName,
  table,
  column,
  type,
  value,
  onSave,
  onClose,
  readOnly = false,
}: BinaryEditorModalProps) {
  const expect = binaryBytes(type) ?? 16;
  const init = looksUuid(value) ? String(value).toLowerCase() : value == null ? "" : String(value);
  const [text, setText] = useState(init);
  const t = useT();
  // UUID generator version (16-byte columns). Defaults to v7; shared with the
  // text-UUID editor via the same localStorage key.
  const [version, setVersion] = useState<UuidVersion>(
    () => (localStorage.getItem("bt.uuidGenVersion") as UuidVersion) || "v7",
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  const generate = (v: UuidVersion) => {
    setVersion(v);
    localStorage.setItem("bt.uuidGenVersion", v);
    setText(generateUuidVersion(v));
  };

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
    if (!readOnly && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") onClose();
  };

  const uuidRepr = res.ok && !res.empty ? (res.uuid ?? "—") : res.ok ? "∅" : "—";
  const bytesRepr = res.ok && !res.empty ? "0x" + res.hex.toUpperCase() : res.ok ? "NULL" : "—";

  return (
    <Modal
      className="binary-modal"
      width={460}
      label={readOnly ? t("grid.viewBinValue") : t("grid.editBinValue")}
      onClose={onClose}
    >
      <div className="modal-title">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="tag" size={17} style={{ color: "var(--accent)" }} />
          <span className="json-title-col">
            {schemaName}.{table}.<b>{column}</b>
          </span>
          <span className="json-type-tag">{type}</span>
        </span>
        <IconBtn icon="close" onClick={onClose} title={t("grid.closeEsc")} />
      </div>

      <label className="binary-field">
        <span className="binary-label">
          {t("grid.valueLabel")}{" "}
          <span className="binary-sub">{t("grid.binSub", { count: expect })}</span>
        </span>
        <input
          ref={inputRef}
          className={"binary-input" + (res.ok ? "" : " err")}
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          readOnly={readOnly}
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
          <span>{t("grid.storedBytes")}</span>
          <code>{bytesRepr}</code>
        </div>
      </div>

      <div className={"json-status" + (res.ok ? " ok" : " err")}>
        <Icon name={res.ok ? "check_circle" : "error"} size={14} />
        <span>
          {res.ok
            ? res.empty
              ? t("grid.emptySavesNull")
              : t("grid.validBytes", { count: expect })
            : res.message}
        </span>
      </div>

      <ModalActions>
        {readOnly ? (
          <>
            <div style={{ flex: 1 }} />
            <Btn variant="filled" onClick={onClose}>
              {t("common.close")}
            </Btn>
          </>
        ) : (
          <>
            <button
              type="button"
              className="json-tool"
              onClick={() => generate(version)}
              title={t("grid.genBtnTitle", { version: version.toUpperCase(), label: "UUID" })}
            >
              <Icon name="autorenew" size={14} /> {t("grid.generate")}
            </button>
            <Select
              className="uuid-ver-select"
              value={version}
              options={uuidVersions().map((v) => ({ value: v.id, label: v.label }))}
              onChange={(v) => generate(v as UuidVersion)}
              title={t("grid.uuidVerTitle")}
              aria-label={t("grid.uuidVerTitle")}
            />
            <div style={{ flex: 1 }} />
            <Btn variant="text" onClick={onClose}>
              {t("common.cancel")}
            </Btn>
            <Btn variant="filled" icon="check" onClick={save} disabled={!res.ok || !dirty}>
              {t("common.save")}
            </Btn>
          </>
        )}
      </ModalActions>
    </Modal>
  );
}
