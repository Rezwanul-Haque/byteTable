// Generate-data modal (M16). One modal owns the whole flow:
//
//   pick size → preview the plan → run (live per-table progress) → summary
//
// The user only picks a target size; the backend introspects the schema,
// figures out table structure + relationships, and APPENDS realistic fake data
// (parents before children, FKs wired, uniques honored). Non-destructive.

import { useMemo, useState } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { normalizeEnv } from "../../../shared/types";
import { type GenerateSize, type TableRole } from "../api";
import { useGenerateStore } from "../state";
import "./GenerateModal.css";

const SIZES: { id: GenerateSize; label: string }[] = [
  { id: "1k", label: "1K" },
  { id: "10k", label: "10K" },
  { id: "100k", label: "100K" },
  { id: "1m", label: "1M" },
];

const ROLE_ICON: Record<TableRole, string> = {
  lookup: "list",
  junction: "hub",
  entity: "table",
};

function fmt(n: number): string {
  return n.toLocaleString();
}

/** Mount once at the app shell; renders only when the store is open. */
export function GenerateModal() {
  const {
    open,
    schema,
    env,
    size,
    plan,
    status,
    progress,
    summary,
    error,
    setSize,
    run,
    cancel,
    close,
  } = useGenerateStore();

  const [typed, setTyped] = useState("");

  const normEnv = normalizeEnv(env);
  const isProd = normEnv === "production";
  const envColor = ENV_COLOR[normEnv];
  // Production gate: must type the schema name to arm "Generate". Else armed.
  const armed = !isProd || typed.trim() === schema;

  const totals = useMemo(() => {
    if (!plan) return { tables: 0, rows: 0 };
    return {
      tables: plan.order.length,
      rows: plan.order.reduce((acc, t) => acc + t.rowCount, 0),
    };
  }, [plan]);

  if (!open) return null;

  return (
    <Modal onClose={close} label="Generate data" width={640} className="gen-modal">
      <ModalTitle>
        <Icon name="auto_awesome" /> Generate data
        {schema ? <span className="gen-schema">· {schema}</span> : null}
      </ModalTitle>

      {/* Step 1: size picker */}
      <div className="gen-sizes">
        <span className="gen-label">Target size</span>
        <div className="gen-size-row">
          {SIZES.map((s) => (
            <Btn
              key={s.id}
              variant={size === s.id ? "filled" : "tonal"}
              onClick={() => void setSize(s.id)}
              disabled={status === "running"}
            >
              {s.label}
            </Btn>
          ))}
        </div>
        <p className="gen-hint">
          Base row count for entity tables. Lookup tables stay small; join tables scale up. Data is
          appended — nothing is deleted.
        </p>
      </div>

      {status === "previewing" ? <p className="gen-muted">Analyzing schema…</p> : null}

      {/* Step 2: preview */}
      {plan && status !== "running" && status !== "done" ? (
        <div className="gen-preview">
          <div className="gen-summary-line">
            {totals.tables} tables · ~{fmt(totals.rows)} rows
          </div>
          {plan.warnings.length > 0 ? (
            <ul className="gen-warnings">
              {plan.warnings.map((w, i) => (
                <li key={i}>
                  <Icon name="warning" size={14} /> {w}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="gen-table-list">
            {plan.order.map((t) => (
              <details key={t.table} className="gen-table">
                <summary>
                  <Icon name={ROLE_ICON[t.role]} size={16} />
                  <span className="gen-table-name">{t.table}</span>
                  <span className="gen-role">{t.role}</span>
                  <span className="gen-count">{fmt(t.rowCount)} rows</span>
                </summary>
                <table className="gen-cols">
                  <tbody>
                    {t.columns.map((c) => (
                      <tr key={c.name} className={c.omit ? "gen-omit" : ""}>
                        <td>{c.name}</td>
                        <td>{c.omit ? "—" : c.generator}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </div>

          {/* Production gate: writing fake data to a prod DB needs the same
              type-to-confirm rigor as truncate/drop. */}
          {isProd ? (
            <div className="gen-prod">
              <div
                className="gen-prod-tag"
                style={{
                  color: envColor,
                  borderColor: envColor + "66",
                  background: envColor + "14",
                }}
              >
                <Icon name="public" size={13} /> production
              </div>
              <label>
                <span className="gen-prod-text">
                  This appends data to a <b>production</b> database. Type <b>{schema}</b> to
                  confirm.
                </span>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={schema ?? ""}
                  spellCheck="false"
                  autoFocus
                  aria-label={"Type " + (schema ?? "") + " to confirm"}
                />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Step 3: running */}
      {status === "running" ? (
        <div className="gen-progress">
          {plan?.order.map((t) => {
            const p = progress[t.table];
            const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
            return (
              <div key={t.table} className="gen-prow">
                <span className="gen-prow-name">{t.table}</span>
                <div className="gen-bar">
                  <div className="gen-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="gen-prow-pct">
                  {p ? `${fmt(p.done)}/${fmt(p.total)}` : "queued"}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Step 4: summary */}
      {status === "done" && summary ? (
        <div className="gen-done">
          <p>
            <Icon name={summary.cancelled ? "cancel" : "check_circle"} />{" "}
            {summary.cancelled ? "Cancelled — " : "Done — "}
            {fmt(summary.totalInserted)} rows inserted
          </p>
          <table className="gen-cols">
            <tbody>
              {summary.tables.map((r) => (
                <tr key={r.table} className={r.error ? "gen-omit" : ""}>
                  <td>{r.table}</td>
                  <td>{r.error ? `error: ${r.error}` : `${fmt(r.inserted)} rows`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {status === "error" && error ? <p className="gen-error">{error}</p> : null}

      <ModalActions>
        {status === "running" ? (
          <Btn variant="tonal" icon="stop" onClick={() => void cancel()}>
            Cancel
          </Btn>
        ) : (
          <Btn variant="text" onClick={close}>
            {status === "done" ? "Close" : "Cancel"}
          </Btn>
        )}
        {plan && (status === "idle" || status === "error") ? (
          <Btn
            variant="filled"
            icon="bolt"
            onClick={() => void run()}
            disabled={!armed}
            title={armed ? undefined : "Type the schema name to confirm"}
          >
            Generate
          </Btn>
        ) : null}
      </ModalActions>
    </Modal>
  );
}
