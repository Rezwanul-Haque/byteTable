// Review SQL + apply, for the grant editor (M39 Phase 2). Same shape as
// KillProcessModal: shared Modal, a preview of the exact statements, and the
// production type-to-arm gate — reused here because removing someone's access
// in production deserves the confirmation killing their session already needs.
//
// Two things this modal says that the structure editor's does not:
//
//   - whether the batch is ATOMIC. Postgres and SQL Server roll back; MySQL's
//     GRANT forces an implicit commit and ClickHouse has no DCL transaction, so
//     a failure there leaves earlier statements applied. The user is told
//     before committing, not after.
//   - the statements come from the BACKEND's preview, not a client-side guess,
//     so what is shown is what will run.

import { useEffect, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useT } from "../../../shared/i18n/useT";
import { useSettingsStore } from "../../settings/state";
import {
  privilegeApply,
  privilegePreview,
  removesAccess,
  type GrantCapabilities,
  type GrantOp,
} from "../api";

export function GrantReviewModal({
  handleId,
  ops,
  capabilities,
  env,
  envColor,
  onApplied,
  onClose,
}: {
  handleId: string;
  ops: GrantOp[];
  capabilities: GrantCapabilities;
  env: string;
  envColor: string;
  /** Called after the batch applies, so the tab can refresh and toast. */
  onApplied: (statements: string[]) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const confirmProd = useSettingsStore((s) => s.settings.confirmProd);

  const [statements, setStatements] = useState<string[] | null>(null);
  const [armText, setArmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Any op that takes access away arms the production gate — granting more
  // cannot lock anyone out.
  const destructive = ops.some(removesAccess);
  const isProd = env === "production" && confirmProd && destructive;
  const armed = !isProd || armText.trim() === "apply " + ops.length;

  // Preview comes from the backend so the SQL shown is the SQL that runs.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await privilegePreview(handleId, ops);
        if (!cancelled) setStatements(result.statements);
      } catch (err) {
        if (!cancelled) setError(appErrorMessage(err, tr("priv.err.preview")));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleId, ops, tr]);

  const confirm = () => {
    if (!armed || busy || !statements) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const result = await privilegeApply(handleId, ops);
        onApplied(result.statements);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, tr("priv.err.apply")));
        setBusy(false);
      }
    })();
  };

  const title = tr("priv.review.title", { count: ops.length });

  return (
    <Modal onClose={onClose} label={title} width={560}>
      <ModalTitle>
        <Icon name="admin_panel_settings" size={20} style={{ color: "var(--accent)" }} />
        <span className="modal-title-text">{title}</span>
        <span
          className="env-tag"
          style={{ color: envColor, borderColor: envColor + "66", background: envColor + "14" }}
        >
          {env}
        </span>
      </ModalTitle>

      <p className="modal-desc">{tr("priv.review.desc")}</p>

      {/* The atomicity promise, stated before the user commits to the batch. */}
      <div className={"priv-atomic" + (capabilities.atomic ? " ok" : " warn")}>
        <Icon name={capabilities.atomic ? "shield" : "warning"} size={14} />
        <span>{capabilities.atomic ? tr("priv.atomic.yes") : tr("priv.atomic.no")}</span>
      </div>

      {error ? <div className="priv-review-error">{error}</div> : null}

      <pre className="priv-review-sql">
        {statements === null
          ? tr("priv.review.loading")
          : statements.length === 0
            ? tr("priv.review.empty")
            : statements.join(";\n") + ";"}
      </pre>

      {isProd ? (
        <label className="proc-arm">
          <span>
            {tr("priv.arm.prefix")} <b style={{ color: envColor }}>{tr("priv.arm.production")}</b>.{" "}
            {tr("priv.arm.type")} <code>apply {ops.length}</code>.
          </span>
          <input
            value={armText}
            autoFocus
            spellCheck="false"
            placeholder={"apply " + ops.length}
            onChange={(e) => setArmText(e.target.value)}
          />
        </label>
      ) : null}

      <ModalActions>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          {tr("common.cancel")}
        </Btn>
        <button
          type="button"
          className={
            "btn " +
            (destructive ? "btn-danger" : "btn-filled") +
            (armed && !busy && statements?.length ? "" : " disabled")
          }
          disabled={!armed || busy || !statements?.length}
          onClick={confirm}
        >
          <Icon name={destructive ? "dangerous" : "check"} size={16} />
          <span>{busy ? tr("priv.review.applying") : tr("priv.review.apply")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
