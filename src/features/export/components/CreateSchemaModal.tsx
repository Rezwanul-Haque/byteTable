// Create-schema modal — ported from the prototype's `schema-import.jsx`
// `CreateSchemaModal`. Creates a new empty schema/database via the
// `create_schema` command (Postgres `CREATE SCHEMA`, MySQL `CREATE DATABASE`;
// SQLite is unsupported and surfaces the §5 error). The name is slugified
// (`\W+`→`_`, lowercased), duplicate-checked against the connection's schemas,
// and previewed as the `CREATE SCHEMA …;` it will run.

import { useState } from "react";

import { createSchema } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { useT } from "../../../shared/i18n/useT";
import "./CreateSchemaModal.css";

export function CreateSchemaModal({
  handleId,
  existing,
  onCreated,
  onClose,
}: {
  handleId: string;
  /** Existing schema names (for the duplicate check). */
  existing: string[];
  /** Called with the created schema's (cleaned) name after success. */
  onCreated: (name: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clean = name.trim().replace(/\W+/g, "_").toLowerCase();
  const dupe = clean !== "" && existing.includes(clean);
  const ok = clean !== "" && !dupe && !busy;

  const create = () => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await createSchema(handleId, clean);
      } catch (err) {
        setError(appErrorMessage(err, t("io.createSchemaFail")));
        setBusy(false);
        return;
      }
      toast(t("io.schemaCreated", { name: clean }), "ok");
      onCreated(clean);
      onClose();
    })();
  };

  const bad = dupe || error !== null;

  return (
    <Modal
      onClose={onClose}
      label={t("io.createSchema")}
      width={420}
      className="create-schema-modal"
    >
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="create_new_folder" size={17} style={{ color: "var(--accent)" }} />{" "}
          {t("io.createSchema")}
        </span>
        <IconBtn icon="close" onClick={onClose} title={t("common.close")} />
      </ModalTitle>

      <label className="cs-field">
        <span className="cs-label">{t("io.schemaName")}</span>
        <input
          className={"cs-input" + (bad ? " err" : "")}
          value={name}
          autoFocus
          spellCheck={false}
          placeholder="analytics"
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ok) create();
            if (e.key === "Escape") onClose();
          }}
        />
      </label>

      <div className={"cs-status" + (bad ? " err" : " ok")}>
        <Icon name={bad ? "error" : "check_circle"} size={14} />
        <span>
          {error
            ? error
            : dupe
              ? t("io.schemaExists", { name: clean })
              : clean
                ? "CREATE SCHEMA " + clean + ";"
                : t("io.enterName")}
        </span>
      </div>

      <ModalActions>
        <div style={{ flex: 1 }} />
        <Btn variant="text" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Btn>
        <Btn variant="filled" icon="add" disabled={!ok} onClick={create}>
          {busy ? t("io.creating") : t("io.create")}
        </Btn>
      </ModalActions>
    </Modal>
  );
}
