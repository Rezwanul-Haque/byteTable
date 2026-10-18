// Read-only badge — the one chip that says "this workspace cannot be written
// to", so the connect card, the workspace sidebar header and the status bar all
// say it the same way. Shaped like {@link EnvTag} (same pill geometry) but
// carries a lock glyph, because it is a capability rather than a label.

import { useT } from "../i18n/useT";

import { Icon } from "./Icon";
import "./ReadOnlyTag.css";

export function ReadOnlyTag({ compact = false }: { compact?: boolean }) {
  const t = useT();
  return (
    <span
      className={"ro-tag" + (compact ? " compact" : "")}
      title={t("ws.readOnly.title")}
      aria-label={t("ws.readOnly.title")}
    >
      <Icon name="lock" size={compact ? 11 : 12} />
      {compact ? null : <span>{t("ws.readOnly")}</span>}
    </span>
  );
}
