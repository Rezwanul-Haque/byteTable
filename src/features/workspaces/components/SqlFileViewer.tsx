// Read-only viewer for a `.sql` file the OS asked ByteTable to open while no
// workspace was open.
//
// WHY THIS EXISTS: a script is text, but ByteTable's SQL editor is per-workspace
// — it belongs to a connection, because running is the point of it. Opening a
// script with nothing connected therefore has no tab to live in. The previous
// answer was to HOLD the file until the user connected, which left a double
// click doing nothing visible and a toast promising something later.
//
// So: show it. A modal can mount over the connect screen, needs no connection,
// and answers the actual question a double-click asks — "what is in this file".
// Deliberately NOT an editor: there is nothing to run it against, and a buffer
// you cannot execute, cannot save back to disk, and would lose on close is a
// worse lie than a plain read-only view. Copy is offered instead, so the text
// can go somewhere that can use it.
//
// With a SQL workspace open the script still opens as a real editor tab (see
// osFileOpen) — that one can run, so it should. A workspace whose engine has no
// SQL (DynamoDB, Redis, MongoDB, Cassandra, Typesense) lands here instead: its
// shell would render a `sql` tab as a blank pane, and the script is no more
// runnable there than with nothing connected.

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalTitle } from "../../../shared/ui/Modal";
import { highlightSql } from "../../browse/shared/highlightSql";
import { useT } from "../../../shared/i18n/useT";
import { useToast } from "../../../shared/ui/toastContext";
import "./SqlFileViewer.css";

interface SqlFileViewerProps {
  /** Leaf file name, shown as the title. */
  name: string;
  /** The script's text, as read from disk. */
  sql: string;
  /** Display name of the open workspace's engine when that engine cannot run
   *  SQL (DynamoDB, Redis, …); absent when no workspace is open. Only the
   *  footer differs — "connect" and "connect to a SQL database" are different
   *  instructions, and the second one is useless if we do not say which engine
   *  is in the way. */
  engine?: string;
  onClose: () => void;
}

export function SqlFileViewer({ name, sql, engine, onClose }: SqlFileViewerProps) {
  const t = useT();
  const toast = useToast();

  const copy = () => {
    void navigator.clipboard.writeText(sql).then(
      () => toast(t("shell.sqlView.copied"), "ok"),
      () => toast(t("shell.sqlView.copyFailed"), "err"),
    );
  };

  return (
    <Modal onClose={onClose} className="sqlview-modal" label={name}>
      <ModalTitle>
        <span className="sqlview-title">
          <Icon name="code" size={17} style={{ color: "var(--accent)" }} />
          {name}
          {/* Says plainly what this is, so nobody types into it expecting a
              buffer or hunts for a Run button. */}
          <span className="tag">{t("shell.sqlView.readOnly")}</span>
        </span>
        <span className="sqlview-actions">
          <Btn icon="content_copy" variant="tonal" small onClick={copy}>
            {t("stv.copy")}
          </Btn>
          <IconBtn icon="close" onClick={onClose} title={t("common.close")} />
        </span>
      </ModalTitle>
      {/* Static markup, not CodeMirror: there is nothing to edit here, and an
          interactive editor is the wrong tool for display (see highlightSql). */}
      <pre
        className="sqlview-block"
        tabIndex={0}
        dangerouslySetInnerHTML={{ __html: highlightSql(sql) }}
      />
      <div className="sqlview-foot">
        <Icon name="info" size={13} />{" "}
        {engine ? t("shell.sqlView.notSqlEngine", { engine }) : t("shell.sqlView.connectToRun")}
      </div>
    </Modal>
  );
}
