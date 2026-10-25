// Create or drop a user / role / server login (M39 Phase 2).
//
// This owns its own preview + apply rather than routing through the matrix's
// staged-ops bar, and that is deliberate: a new account's PASSWORD would
// otherwise have to live in the tab's shared state, where it would survive
// every re-render and sit beside data that gets logged and toasted. Here it
// lives in one component, for as long as the dialog is open.
//
// The password never reaches the screen. The backend returns statements with
// it replaced by MASKED_SECRET, and the panel says so in as many words — a
// narrow, labelled exception to "the preview is exactly what runs", which is
// better than either printing the secret or silently lying about the SQL.

import { useEffect, useMemo, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useT } from "../../../shared/i18n/useT";
import type { StringKey } from "../../../shared/i18n";
import type { Engine } from "../../../shared/types";
import { useSettingsStore } from "../../settings/state";
import {
  carriesSecret,
  privilegeApply,
  privilegePreview,
  type GrantOp,
  type Principal,
  type PrincipalKind,
} from "../api";

/** Creating something new, or dropping the principal that was selected. */
export type PrincipalModalMode = { kind: "create" } | { kind: "drop"; principal: Principal };

const KIND_LABEL: Record<PrincipalKind, StringKey> = {
  user: "priv.new.kindUser",
  role: "priv.new.kindRole",
  login: "priv.new.kindLogin",
};

export function PrincipalModal({
  handleId,
  engine,
  mode,
  env,
  envColor,
  onDone,
  onClose,
}: {
  handleId: string;
  engine: Engine;
  mode: PrincipalModalMode;
  env: string;
  envColor: string;
  onDone: (statements: string[]) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const confirmProd = useSettingsStore((s) => s.settings.confirmProd);

  const dropping = mode.kind === "drop";
  // Only SQL Server has a second principal space; offering "server login"
  // elsewhere would stage SQL the engine cannot run.
  const kinds: PrincipalKind[] = engine === "mssql" ? ["user", "role", "login"] : ["user", "role"];

  const [name, setName] = useState("");
  const [principalKind, setPrincipalKind] = useState<PrincipalKind>("user");
  const [password, setPassword] = useState("");
  const [statements, setStatements] = useState<string[] | null>(null);
  const [armText, setArmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ops: GrantOp[] = useMemo(() => {
    if (dropping) {
      const p = mode.principal;
      return [
        {
          kind: "dropPrincipal",
          name: p.name,
          principalKind: p.kind,
          scope: p.scope,
        },
      ];
    }
    if (!name.trim()) return [];
    return [
      {
        kind: "createPrincipal",
        name: name.trim(),
        principalKind,
        scope: principalKind === "login" ? "server" : "database",
        // A role has no password, and an empty box means "no password" rather
        // than an empty one.
        password: principalKind === "role" || !password ? undefined : password,
      },
    ];
  }, [dropping, mode, name, principalKind, password]);

  // Dropping an account is destructive; creating one is not.
  const isProd = env === "production" && confirmProd && dropping;
  const armed = !isProd || armText.trim() === "drop";
  const masked = carriesSecret(ops);

  // Preview comes from the backend, so the SQL shown is the SQL that runs —
  // except the password, which is masked there and labelled here.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Clearing inside the async body, not the effect's synchronous part:
      // a synchronous setState here re-renders before paint and the lint
      // rightly flags it as a cascading-render risk.
      if (!ops.length) {
        if (!cancelled) setStatements(null);
        return;
      }
      try {
        const result = await privilegePreview(handleId, ops);
        if (!cancelled) {
          setStatements(result.statements);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setStatements(null);
          setError(appErrorMessage(err, tr("priv.err.preview")));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleId, ops, tr]);

  const confirm = () => {
    if (!armed || busy || !statements?.length) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const result = await privilegeApply(handleId, ops);
        onDone(result.statements);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, tr("priv.err.apply")));
        setBusy(false);
      }
    })();
  };

  const title = dropping
    ? tr("priv.drop.title", { name: mode.principal.name })
    : tr("priv.new.title");

  return (
    <Modal onClose={onClose} label={title} width={520}>
      <ModalTitle>
        <Icon
          name={dropping ? "person_remove" : "person_add"}
          size={20}
          style={{ color: dropping ? "var(--danger, var(--error))" : "var(--accent)" }}
        />
        <span className="modal-title-text">{title}</span>
        <span
          className="env-tag"
          style={{ color: envColor, borderColor: envColor + "66", background: envColor + "14" }}
        >
          {env}
        </span>
      </ModalTitle>

      {dropping ? (
        <p className="modal-desc">{tr("priv.drop.desc")}</p>
      ) : (
        <div className="priv-form">
          <label>
            <span>{tr("priv.new.kind")}</span>
            <div className="priv-seg priv-form-seg">
              {kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={principalKind === k ? "on" : ""}
                  onClick={() => setPrincipalKind(k)}
                >
                  {tr(KIND_LABEL[k])}
                </button>
              ))}
            </div>
          </label>
          <label>
            <span>{tr("priv.new.name")}</span>
            <input
              value={name}
              autoFocus
              spellCheck="false"
              placeholder={engine === "mysql" ? "app@%" : "app"}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {principalKind === "role" ? null : (
            <label>
              <span>{tr("priv.new.password")}</span>
              <input
                type="password"
                value={password}
                spellCheck="false"
                placeholder={tr("priv.new.passwordHint")}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
        </div>
      )}

      {error ? <div className="priv-review-error">{error}</div> : null}

      <pre className="priv-review-sql">
        {!ops.length
          ? tr("priv.new.needName")
          : statements === null
            ? tr("priv.review.loading")
            : statements.join(";\n") + ";"}
      </pre>

      {/* The one place the preview is not literally what runs — said plainly
          rather than left for someone to discover. */}
      {masked ? (
        <div className="priv-atomic warn">
          <Icon name="key_off" size={14} />
          <span>{tr("priv.new.masked")}</span>
        </div>
      ) : null}

      {isProd ? (
        <label className="proc-arm">
          <span>
            {tr("priv.arm.prefix")} <b style={{ color: envColor }}>{tr("priv.arm.production")}</b>.{" "}
            {tr("priv.arm.type")} <code>drop</code>.
          </span>
          <input
            value={armText}
            autoFocus
            spellCheck="false"
            placeholder="drop"
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
            (dropping ? "btn-danger" : "btn-filled") +
            (armed && !busy && statements?.length ? "" : " disabled")
          }
          disabled={!armed || busy || !statements?.length}
          onClick={confirm}
        >
          <Icon name={dropping ? "person_remove" : "check"} size={16} />
          <span>
            {busy
              ? tr("priv.review.applying")
              : dropping
                ? tr("priv.drop.confirm")
                : tr("priv.new.confirm")}
          </span>
        </button>
      </ModalActions>
    </Modal>
  );
}
