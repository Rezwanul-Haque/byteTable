// Import connection — the dialog behind the connect modal's "Import URL"
// button. Paste a connection string, see what it was recognised as while you
// type, then "Fill the form" hands the parsed fields to the connect modal.
//
// Nothing here saves or connects: it only fills in the form the user is already
// looking at, which is why the detection line is a preview rather than a
// verdict, and why an unrecognised string simply disables the action instead of
// raising an error.

import { useMemo, useState, type KeyboardEvent } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { ENGINE_META } from "../../../shared/ui/engineMeta";
import { parseConnectionUrl, type ImportedConnection } from "../urlImport";
import "./ImportConnectionModal.css";

/**
 * The shapes the parser understands, as the user would type them. Shown as
 * chips so "what can I paste here?" is answered without a docs trip — and so
 * the absence of an engine (DynamoDB has no connection string) is visible.
 */
const RECOGNISED = [
  "postgres://",
  "mysql://",
  "sqlserver://",
  "clickhouse://",
  "redis://",
  "mongodb+srv://",
  "cassandra://",
  "sqlite:",
  "jdbc:…",
  "Server=…;",
];

interface ImportConnectionModalProps {
  onClose: () => void;
  /** Hand the parsed fields to the connect form (the modal closes itself). */
  onApply: (parsed: ImportedConnection) => void;
}

export function ImportConnectionModal({ onClose, onApply }: ImportConnectionModalProps) {
  const [text, setText] = useState("");
  const parsed = useMemo(() => parseConnectionUrl(text), [text]);
  const typed = text.trim() !== "";

  const apply = () => {
    if (!parsed) return;
    onApply(parsed);
    onClose();
  };

  // Enter submits rather than inserting a newline: no connection string spans
  // lines, and the textarea is only multi-line so a long URL stays readable.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    apply();
  };

  return (
    <Modal label="Import connection" onClose={onClose} className="import-modal">
      <ModalTitle>
        <span>Import connection</span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </ModalTitle>

      <p className="import-lede">
        Paste a connection URL or an ODBC-style connection string. Everything ByteTable can map is
        filled into the form — nothing is saved until you do.
      </p>

      <div className={"import-box" + (typed && !parsed ? " bad" : "")}>
        <textarea
          autoFocus
          rows={3}
          value={text}
          spellCheck={false}
          aria-label="Connection string"
          placeholder="postgres://user:password@host:5432/dbname?sslmode=require"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="import-status" aria-live="polite">
          {!typed ? (
            <span className="import-status-idle">Waiting for a URL…</span>
          ) : parsed ? (
            <>
              <EngineBadge engine={parsed.engine} size={16} />
              <span className="import-status-ok">{ENGINE_META[parsed.engine].label}</span>
              <span className="import-status-detail">{summarise(parsed)}</span>
            </>
          ) : (
            <>
              <Icon name="error" size={14} />
              <span className="import-status-bad">
                Not a connection string ByteTable recognises
              </span>
            </>
          )}
        </div>
      </div>

      <div className="import-recognised">
        <span className="form-section-label">Recognised</span>
        <div className="import-chips">
          {RECOGNISED.map((scheme) => (
            <code key={scheme} className="import-chip">
              {scheme}
            </code>
          ))}
        </div>
      </div>

      <ModalActions>
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="filled" disabled={!parsed} onClick={apply}>
          Fill the form
        </Btn>
      </ModalActions>
    </Modal>
  );
}

/** One line naming what the paste resolved to — the same shape as a saved
 *  connection's detail line ("host:port · database"). */
function summarise(parsed: ImportedConnection): string {
  if (parsed.file) return parsed.file;
  if (parsed.mongoUri) return parsed.mongoUri;
  const target =
    (parsed.user ? parsed.user + "@" : "") +
    (parsed.host ?? "") +
    (parsed.port ? ":" + parsed.port : "");
  return parsed.db ? target + " · " + parsed.db : target;
}
