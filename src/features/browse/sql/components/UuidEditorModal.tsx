// UUID / GUID cell editor modal — for text UUID columns (Postgres `uuid`,
// SQL Server `uniqueidentifier`). Shows the value, validates the canonical
// 8-4-4-4-12 form, and generates a fresh id in a chosen version (v7 default —
// time-ordered, best for keys — plus v4 random and v1). Empty saves NULL. A
// UUID stored as `binary(16)` uses BinaryEditorModal instead.
//
// On a FOREIGN-key column (`fk`) there is nothing to generate: the value must
// be a key that exists in the parent table. The generator is replaced by the
// reference + existence check of {@link FkTargetNote}.

import { useEffect, useRef, useState } from "react";

import type { CellValue, FkRef } from "../../../../shared/api/engine";
import { Btn } from "../../../../shared/ui/Btn";
import { CopyButton } from "../../../../shared/ui/CopyButton";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Modal, ModalActions } from "../../../../shared/ui/Modal";
import { Select } from "../../../../shared/ui/Select";
import { useT } from "../../../../shared/i18n/useT";
import {
  generateUuidVersion,
  looksUuid,
  uuidVersions,
  type UuidVersion,
} from "../../shared/binaryCell";
import { FkTargetNote } from "./FkTargetNote";
import "../../shared/styles/CellEditors.css";

interface UuidEditorModalProps {
  schemaName: string;
  table: string;
  column: string;
  type: string;
  value: CellValue;
  onSave: (next: string | null) => void;
  onClose: () => void;
  /** View-only (e.g. a UUID primary key): no editing, generate, or save. */
  readOnly?: boolean;
  /** The column's foreign-key target, when it has one: swaps the generator for
   *  the reference + an existence check of what is in the input. */
  fk?: FkRef | null;
  /** Connection for that check. Without it only the reference is shown. */
  handleId?: string;
}

/** SQL Server calls it GUID; everything else UUID. */
function uuidLabel(type: string): string {
  return /uniqueidentifier|guid/i.test(type) ? "GUID" : "UUID";
}

export function UuidEditorModal({
  schemaName,
  table,
  column,
  type,
  value,
  onSave,
  onClose,
  readOnly = false,
  fk = null,
  handleId,
}: UuidEditorModalProps) {
  const label = uuidLabel(type);
  const init = value == null ? "" : String(value);
  const [text, setText] = useState(init);
  const t = useT();
  // Default the generator to v7; remember the last choice across opens.
  const [version, setVersion] = useState<UuidVersion>(
    () => (localStorage.getItem("bt.uuidGenVersion") as UuidVersion) || "v7",
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = text.trim();
  const empty = trimmed === "";
  const valid = empty || looksUuid(trimmed);
  const dirty = trimmed !== init.trim();

  const save = () => {
    if (!valid) return;
    onSave(empty ? null : trimmed.toLowerCase());
  };

  const generate = (v: UuidVersion) => {
    setVersion(v);
    localStorage.setItem("bt.uuidGenVersion", v);
    setText(generateUuidVersion(v));
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!readOnly && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") onClose();
  };

  return (
    <Modal
      className="binary-modal"
      width={460}
      label={readOnly ? t("grid.viewValueTitle", { label }) : t("grid.editValueTitle", { label })}
      onClose={onClose}
    >
      <div className="modal-title">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="fingerprint" size={17} style={{ color: "var(--accent)" }} />
          <span className="json-title-col">
            {schemaName}.{table}.<b>{column}</b>
          </span>
          <span className="json-type-tag">{type}</span>
        </span>
        <IconBtn icon="close" onClick={onClose} title={t("grid.closeEsc")} />
      </div>

      <label className="binary-field">
        <span className="binary-label">
          {t("grid.valueLabel")} <span className="binary-sub">{t("grid.uuidSub", { label })}</span>
        </span>
        {/* A button inside a <label> is interactive content, so clicking it
            copies without the label forwarding the click to the input. */}
        <span className="binary-input-wrap">
          <input
            ref={inputRef}
            className={"binary-input" + (valid ? "" : " err")}
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            readOnly={readOnly}
            placeholder="b1e7a4c2-3f9d-4a1e-8c77-2d5f6a0b9e34"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          {empty ? null : (
            <CopyButton
              className="binary-copy"
              label={"Copy " + column + " value"}
              text={trimmed}
            />
          )}
        </span>
      </label>

      {fk ? (
        <FkTargetNote
          handleId={handleId}
          refSchema={schemaName}
          fk={fk}
          value={valid && !empty ? trimmed.toLowerCase() : null}
        />
      ) : null}

      <div className={"json-status" + (valid ? " ok" : " err")}>
        <Icon name={valid ? "check_circle" : "error"} size={14} />
        <span>
          {valid
            ? empty
              ? t("grid.emptySavesNull")
              : t("grid.validLabel", { label })
            : t("grid.invalidLabel", { label })}
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
            {/* A foreign key has nothing to generate — it has to be a key the
                parent table already holds, so the generator is left out rather
                than offering a value that cannot be right. The note above says
                so, which keeps this row from wrapping in a narrow panel. */}
            {fk ? null : (
              <>
                <button
                  type="button"
                  className="json-tool"
                  onClick={() => generate(version)}
                  title={t("grid.genBtnTitle", { version: version.toUpperCase(), label })}
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
              </>
            )}
            <div style={{ flex: 1 }} />
            <Btn variant="text" onClick={onClose}>
              {t("common.cancel")}
            </Btn>
            <Btn variant="filled" icon="check" onClick={save} disabled={!valid || !dirty}>
              {t("common.save")}
            </Btn>
          </>
        )}
      </ModalActions>
    </Modal>
  );
}
