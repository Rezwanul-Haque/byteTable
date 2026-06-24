// SchemaCommitModal — final review + production gate for a staged schema
// migration (Schema_Visual_Edit.md View 7 / schema-edit.jsx).
//
// Shows every staged statement (SQL-highlighted, destructive ones flagged), a
// destructive-count warning banner when any exist, and — on a production
// connection — a typed-phrase gate: the Commit button stays disabled until the
// user types `apply to <schema>`.

import { useState } from "react";

import { highlightSql } from "../../browse/highlightSql";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import type { Env } from "../../../shared/types";
import { isDestructive } from "../editModel";

export function SchemaCommitModal({
  schemaName,
  env,
  envColor,
  statements,
  busy,
  onConfirm,
  onClose,
}: {
  schemaName: string;
  env: Env;
  envColor: string;
  statements: string[];
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const isProd = env === "production";
  const destructive = statements.filter(isDestructive);
  const phrase = "apply to " + schemaName;
  const armed =
    (!isProd || typed.trim().toLowerCase() === phrase) && statements.length > 0 && !busy;

  return (
    <Modal onClose={onClose} className="commit-modal" label="Commit schema changes" width={580}>
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="published_with_changes" size={18} style={{ color: "var(--accent)" }} />
          Commit schema changes
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </ModalTitle>
      <div className="commit-body">
        <p>
          ByteTable will run{" "}
          <b>
            {statements.length} statement{statements.length === 1 ? "" : "s"}
          </b>{" "}
          on <code>{schemaName}</code> in a single transaction. Review the migration below.
        </p>
        <div className="commit-sql-list">
          {statements.map((sql, i) => (
            <div key={i} className={"commit-sql-row" + (isDestructive(sql) ? " destructive" : "")}>
              {isDestructive(sql) ? (
                <Icon name="warning" size={13} style={{ color: "#e06c75" }} />
              ) : (
                <Icon name="check_circle" size={13} style={{ color: "var(--accent)" }} />
              )}
              <pre dangerouslySetInnerHTML={{ __html: highlightSql(sql) }} />
            </div>
          ))}
        </div>
        {destructive.length > 0 ? (
          <div className="commit-warn">
            <Icon name="gpp_maybe" size={15} />
            <span>
              <b>
                {destructive.length} destructive change{destructive.length === 1 ? "" : "s"}
              </b>{" "}
              — dropping or retyping columns/tables can lose data and is not reversible.
            </span>
          </div>
        ) : null}
        {isProd ? (
          <div className="commit-prod">
            <div
              className="commit-prod-tag"
              style={{
                color: envColor,
                borderColor: envColor + "66",
                background: envColor + "14",
              }}
            >
              <Icon name="public" size={13} /> production
            </div>
            <label>
              Type <b>{phrase}</b> to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={phrase}
                spellCheck={false}
                autoFocus
              />
            </label>
          </div>
        ) : null}
      </div>
      <ModalActions>
        <div style={{ flex: 1 }} />
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          variant="filled"
          icon={busy ? "hourglass_top" : "check"}
          disabled={!armed}
          onClick={() => armed && onConfirm()}
        >
          Commit {statements.length}
        </Btn>
      </ModalActions>
    </Modal>
  );
}
