// Drop-confirm modal (design Prompt 6). Always a centered modal with a
// backdrop, rendered via createPortal to document.body — the ObjectViewer lives
// inside a transformed tab container, so a non-portaled fixed scrim would be
// clipped. Shows the exact DROP; on a production connection a type-the-object-
// name input arms the red Drop button. Mirrors the Truncate / Schema-commit
// prod gates.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useT } from "../../../shared/i18n/useT";
import type { StringKey } from "../../../shared/i18n";
import type { Engine, Env } from "../../../shared/types";
import type { DbObjectKind } from "../api";
import { dropPrefix } from "../ddl";

/** Object kind → its translated singular noun (for the drop copy). */
const KIND_KEY: Record<DbObjectKind, StringKey> = {
  view: "obj.kind.view",
  materialized_view: "obj.kind.materializedView",
  function: "obj.kind.function",
  procedure: "obj.kind.procedure",
  trigger: "obj.kind.trigger",
};

export function ObjectDropModal({
  engine,
  env,
  envColor,
  schema,
  kind,
  name,
  detail,
  busy,
  onConfirm,
  onClose,
}: {
  engine: Engine;
  env: Env;
  envColor: string;
  schema: string;
  kind: DbObjectKind;
  name: string;
  detail: string | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const t = useT();
  const isProd = env === "production";
  const clsLabel = t(KIND_KEY[kind]);
  const stmt = dropPrefix(engine, kind, schema, name, detail);
  const armed = (!isProd || typed.trim() === name) && !busy;

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal truncate-modal" role="dialog" aria-modal="true">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="warning" size={18} style={{ color: "var(--danger)" }} />{" "}
            {t("obj.dropOne.title", { type: clsLabel })}
          </span>
          <IconBtn icon="close" onClick={onClose} title={t("common.close")} />
        </div>
        <div className="truncate-body">
          <p>{t("obj.dropOne.body", { type: clsLabel, name: `${schema}.${name}` })}</p>
          <pre className="truncate-sql obj-drop-sql">{stmt}</pre>
          {isProd ? (
            <div className="truncate-prod">
              <div
                className="truncate-prod-tag"
                style={{
                  color: envColor,
                  borderColor: envColor + "66",
                  background: envColor + "14",
                }}
              >
                <Icon name="public" size={13} /> {t("uix.bulkDelete.prodTag")}
              </div>
              <label>
                {t("uix.bulkDelete.typePre")} <b>{name}</b> {t("uix.bulkDelete.typePost")}
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={name}
                  aria-label={t("uix.bulkDelete.typeAria", { target: name })}
                  spellCheck={false}
                  autoFocus
                />
              </label>
            </div>
          ) : null}
        </div>
        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <Btn variant="text" onClick={onClose}>
            {t("common.cancel")}
          </Btn>
          <Btn
            variant="filled"
            icon={busy ? "hourglass_top" : "delete_forever"}
            className="obj-drop-confirm"
            disabled={!armed}
            onClick={() => armed && onConfirm()}
          >
            {t("obj.dropOne.btn", { type: clsLabel })}
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}
