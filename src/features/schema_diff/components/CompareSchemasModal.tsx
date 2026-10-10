// "Compare schemas…" modal on the connect screen (M28, prototype connect.jsx):
// a compare-only Schema Diff with NO home connection, so both cards start
// unselected — you are not standing on a workspace here, you are picking any
// two SQL connections.
//
// Esc, the scrim, and the × close it. Nothing inside can mutate a database:
// compare-only hides the migration pane entirely.

import { useEffect } from "react";

import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { SchemaDiff } from "./SchemaDiff";
import "./SchemaDiff.css";

export function CompareSchemasModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="sd-compare-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sd-compare-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("sdiff.compare.title")}
      >
        <div className="sd-compare-head">
          <Icon name="difference" size={17} style={{ color: "var(--accent)" }} />
          <span className="sd-compare-title">{t("sdiff.compare.title")}</span>
          <span className="sd-compare-sub">{t("sdiff.compare.sub")}</span>
          <IconBtn icon="close" title={t("sdiff.closeEsc")} onClick={onClose} />
        </div>
        <SchemaDiff compareOnly />
      </div>
    </div>
  );
}
