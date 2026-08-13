// Import connection sheet (M34) — ported from the prototype's `ImportUrlSheet`
// (connect.jsx). Paste a connection URL or an ODBC-style string, see exactly
// what ByteTable understood, then fill the form in one click.
//
// It is a second overlay above the connect modal rather than a field inside it:
// an import is a step, not a setting. (An inline collapsible panel above the
// Name field was tried and rejected — it read as an odd banner and pushed the
// real fields down.) Escape closes only this sheet: `Modal` keeps a stack and
// dismisses the top-most one, so the connection form behind keeps its state.
//
// Nothing here saves or connects. It only fills the form the user is already
// looking at, which is why an unreadable string simply disables the action.

import { Fragment, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { ENGINE_META } from "../../../shared/ui/engineMeta";
import { IMP_DBLABEL, isImportError, parseConnUri, type ImportedConnection } from "../urlImport";
import "./ImportUrlSheet.css";

/**
 * The prefixes the parser accepts, shown before anything is typed. This is the
 * discoverability — "what can I paste here?" answered without a docs trip — so
 * it lists only what this build can actually import.
 */
const RECOGNISED = [
  "postgres://",
  "mysql://",
  "sqlserver://",
  "clickhouse://",
  "redis://",
  "mongodb+srv://",
  "cassandra://",
  "http:// (Typesense)",
  "sqlite://",
  "jdbc:…",
  "Server=…;",
];

/** Secrets are shown as bullets, never as the value that was pasted. */
const MASK = "••••••••••";

interface ImportUrlSheetProps {
  onClose: () => void;
  /** Hand the parsed fields to the connect form (the sheet closes itself). */
  onApply: (parsed: ImportedConnection) => void;
}

export function ImportUrlSheet({ onClose, onApply }: ImportUrlSheetProps) {
  const [text, setText] = useState("");
  // The sheet exists to receive a paste, so the caret belongs here on open —
  // not on the close button, which is what `Modal` would focus by default.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Re-parsed on every keystroke, so the parser must never throw.
  const result = useMemo(() => parseConnUri(text), [text]);
  const parsed = result && !isImportError(result) ? result : null;
  const error = result && isImportError(result) ? result.error : null;

  const submit = () => {
    if (!parsed) return;
    onApply(parsed);
    onClose();
  };

  // ⌘/Ctrl-Enter submits. A bare Enter inserts a newline: a pasted URI can wrap,
  // and swallowing Enter would make the textarea lie about being multi-line.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Modal
      label="Import connection"
      onClose={onClose}
      className="imp-sheet"
      initialFocusRef={inputRef}
    >
      <ModalTitle>
        <span>Import connection</span>
        <IconBtn icon="close" onClick={onClose} title="Close (Esc)" />
      </ModalTitle>

      <div className="imp-body">
        <p className="imp-lede">
          Paste a connection URL or an ODBC-style connection string. Everything ByteTable can map is
          filled into the form — nothing is saved until you do.
        </p>

        <div className={"imp-field" + (error ? " bad" : parsed ? " good" : "")}>
          <textarea
            ref={inputRef}
            rows={3}
            value={text}
            spellCheck={false}
            aria-label="Connection URL or connection string"
            placeholder="postgres://user:password@host:5432/dbname?sslmode=require"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="imp-field-foot" aria-live="polite">
            {parsed ? (
              <span className="imp-detect">
                <span
                  className="imp-eng-dot"
                  style={{ background: ENGINE_META[parsed.engine].color }}
                />
                {ENGINE_META[parsed.engine].label}
                <code>{parsed.scheme + (parsed.kv ? "" : "://")}</code>
                {parsed.confident ? null : <em>best guess — confirm the engine</em>}
              </span>
            ) : error ? (
              <span className="imp-detect err">
                <Icon name="error" size={12} /> {error}
              </span>
            ) : (
              <span className="imp-detect idle">Waiting for a URL…</span>
            )}
            {text ? (
              <button type="button" className="imp-clear" onClick={() => setText("")}>
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {parsed ? (
          <div className="imp-map">
            <div className="imp-map-head">
              <Icon name="south" size={13} /> Fields to fill
            </div>
            <dl className="imp-dl">
              {mapRows(parsed).map(([label, value, cls]) => (
                <Fragment key={label}>
                  <dt>{label}</dt>
                  <dd className={cls ?? ""}>{value}</dd>
                </Fragment>
              ))}
            </dl>
            {parsed.opts.length ? (
              <div className="imp-extra">
                <span className="imp-extra-lbl">Driver options carried over</span>
                <div className="imp-tags">
                  {parsed.opts.map((o) => (
                    <code key={o.k}>{o.k + "=" + o.v}</code>
                  ))}
                </div>
              </div>
            ) : null}
            {parsed.warnings.map((w) => (
              <div className="imp-warn" key={w}>
                <Icon name={/password/i.test(w) ? "key" : "info"} size={13} /> <span>{w}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="imp-support">
            <span className="imp-extra-lbl">Recognised</span>
            <div className="imp-tags">
              {RECOGNISED.map((prefix) => (
                <code key={prefix}>{prefix}</code>
              ))}
            </div>
          </div>
        )}
      </div>

      <ModalActions>
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="filled" disabled={!parsed} onClick={submit}>
          Fill the form
        </Btn>
      </ModalActions>
    </Modal>
  );
}

/** `[label, value, className?]` for each field the paste will fill. */
type MapRow = [string, string, string?];

/**
 * The rows of the "Fields to fill" list, in the order the form reads. Only what
 * was actually parsed appears — a row for an absent field would imply the
 * import is about to blank it.
 */
function mapRows(parsed: ImportedConnection): MapRow[] {
  const rows: MapRow[] = [];
  const dbLabel = IMP_DBLABEL[parsed.engine] ?? "Database";
  if (parsed.host) {
    rows.push([
      "Host",
      parsed.host + (parsed.extraHosts ? "  +" + parsed.extraHosts + " more" : ""),
    ]);
  }
  if (parsed.port) rows.push(["Port", parsed.port]);
  if (parsed.db) rows.push([dbLabel, parsed.db]);
  if (parsed.file) rows.push(["File", parsed.file]);
  if (parsed.user) rows.push(["User", parsed.user]);
  if (parsed.password) rows.push(["Password", MASK, "secret"]);
  if (parsed.apiKey) rows.push(["API key", MASK, "secret"]);
  if (parsed.tls) {
    rows.push(
      parsed.engine === "typesense" ? ["Protocol", parsed.scheme] : ["TLS mode", parsed.tls],
    );
  }
  if (parsed.datacenter) rows.push(["Datacenter", parsed.datacenter]);
  return rows;
}
