// Cassandra destructive-DDL confirms: truncate a table, drop a table, empty a
// keyspace, drop a keyspace.
//
// Truncate is the light one and is gated accordingly: the table, its schema and
// its indexes survive, and Cassandra's default `auto_snapshot` keeps a
// `truncated-*` snapshot of the rows, so an operator can get them back. It asks
// for a typed name only on a production connection (and only when the "Confirm
// writes on production" setting is on), exactly like the SQL TruncateModal it
// mirrors. The three structural dialogs below always require the typed name.
//
// Empty vs drop is the same distinction the SQL sidebar draws between "Empty
// schema" and "Delete schema": emptying removes every table and leaves the
// keyspace — and its replication settings — standing, so you can rebuild into
// it; dropping takes the keyspace itself.
//
// The SQL side has the same pair (DropTableModal / DeleteSchemaModal) and this
// follows their contract deliberately — same shared Modal + `.truncate-*`
// chrome, the name always typed to arm the button, the env tag escalating the
// visual weight on production, and backend errors surfaced INSIDE the dialog so
// it stays open on a refusal (the server rejects a system keyspace, a table
// still referenced by a materialized view, …).
//
// Cassandra needs its own pair rather than reusing the SQL ones: those call the
// `sql` engine commands and drive the SQL introspection cache, neither of which
// exists for a wide-column connection.
//
// "Always type the name" is not belt-and-braces here. `DROP KEYSPACE` in
// Cassandra takes the tables, the data and the replication settings with it,
// and there is no transaction to roll back.

import { useRef, useState, type RefObject } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { InfoHint } from "../../../../shared/ui/InfoHint";
import { Modal, ModalActions, ModalTitle } from "../../../../shared/ui/Modal";
import { ENV_COLOR } from "../../../../shared/ui/envColors";
import { useToast } from "../../../../shared/ui/toastContext";
import { normalizeEnv } from "../../../../shared/types";
import { useT } from "../../../../shared/i18n/useT";
import { useSettingsStore } from "../../../settings/state";
import {
  cassDropKeyspace,
  cassDropTable,
  cassEmptyKeyspace,
  cassTruncateTable,
  type TableDescriptor,
} from "../api";
import "../../../export/components/TruncateModal.css";

const DANGER = "#e06c75";

/** The type-to-confirm field + production tag, shared by the dialogs below. */
function ConfirmName({
  name,
  env,
  typed,
  onTyped,
  inputRef,
}: {
  name: string;
  env: string;
  typed: string;
  onTyped: (v: string) => void;
  /** Handed to `Modal`'s `initialFocusRef` so the caret starts here. */
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const t = useT();
  const normEnv = normalizeEnv(env);
  const envColor = ENV_COLOR[normEnv];
  return (
    <div className="truncate-prod">
      {normEnv === "production" ? (
        <div
          className="truncate-prod-tag"
          style={{ color: envColor, borderColor: envColor + "66", background: envColor + "14" }}
        >
          <Icon name="public" size={13} /> {t("cass.drop.production")}
        </div>
      ) : null}
      <label>
        {t("cass.drop.typeToConfirm", { name })}
        {/* No `autoFocus`: Modal focuses the first tabbable element in its own
            effect, which runs AFTER a child's and would overwrite it — hence
            `initialFocusRef` (documented on Modal). */}
        <input
          ref={inputRef}
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          placeholder={name}
          spellCheck="false"
          aria-label={t("cass.drop.typeToConfirm", { name })}
        />
      </label>
    </div>
  );
}

export function CassTruncateTableModal({
  handleId,
  ks,
  table,
  env,
  onClose,
  onTruncated,
}: {
  handleId: string;
  ks: string;
  table: TableDescriptor;
  /** Connection deployment env; `production` gates + escalates the confirm. */
  env: string;
  onClose: () => void;
  /** Called after a successful truncate so the caller can reload the grid. */
  onTruncated: (table: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirmProd = useSettingsStore((s) => s.settings.confirmProd);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Production gate only — the rows are snapshotted and the table survives, so
  // a typed name everywhere would be friction out of proportion to the risk.
  const isProd = normalizeEnv(env) === "production" && confirmProd;
  const armed = !isProd || typed.trim() === table.name;
  // Off production there is no name field, so aim the dialog's initial focus at
  // Cancel — the safe button — rather than letting Modal fall through to the
  // first tabbable element, which here is the info chip.
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await cassTruncateTable(handleId, ks, table.name);
        toast(t("cass.drop.truncated", { name: table.name }), "ok");
        onTruncated(table.name);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("cass.drop.truncateFailed")));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("cass.drop.truncateTitle")}
      width={480}
      className="truncate-modal"
      initialFocusRef={isProd ? nameRef : cancelRef}
    >
      <ModalTitle>
        <Icon name="delete_sweep" size={18} style={{ color: DANGER }} />{" "}
        {t("cass.drop.truncateTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>{t("cass.drop.truncateBody", { table: table.name })}</p>
        <pre className="truncate-sql">
          TRUNCATE TABLE {ks}.{table.name};
        </pre>
        {/* The caveats are real but long, and a 480px dialog is the wrong place
            to spend six lines on them — they live in the hint bubble. */}
        <p className="cass-create-note">
          <code>ALL</code> {t("cass.drop.truncateAll")}{" "}
          <InfoHint text={t("cass.drop.truncateAll")} />
        </p>
        {isProd ? (
          <ConfirmName
            name={table.name}
            env={env}
            typed={typed}
            onTyped={setTyped}
            inputRef={nameRef}
          />
        ) : null}
        {error ? <div className="truncate-error">{error}</div> : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onClose} disabled={busy} ref={cancelRef}>
          {t("cass.drop.cancel")}
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy ? "" : " disabled")}
          disabled={!armed || busy}
          onClick={confirm}
        >
          <Icon name="delete_sweep" size={16} />
          <span>{busy ? t("cass.drop.truncating") : t("cass.drop.truncateTitle")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}

export function CassDropTableModal({
  handleId,
  ks,
  table,
  env,
  onClose,
  onDropped,
}: {
  handleId: string;
  ks: string;
  table: TableDescriptor;
  /** Connection deployment env; `production` escalates the visual weight. */
  env: string;
  onClose: () => void;
  /** Called after a successful drop so the caller can refresh + close tabs. */
  onDropped: (dropped: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [dropViews, setDropViews] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const armed = typed.trim() === table.name;

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await cassDropTable(handleId, ks, table.name, dropViews);
        toast(t("cass.drop.droppedTable", { name: table.name }), "ok");
        onDropped(table.name);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("cass.drop.dropTableFailed")));
        setBusy(false);
      }
    })();
  };

  // Two very different dependents. Secondary indexes are removed by the DROP
  // itself — nothing to decide. Materialized views BLOCK it: Cassandra has no
  // CASCADE, so taking them down is an explicit choice (the checkbox below),
  // mirroring how the SQL drop modal handles referencing foreign keys.
  const views = table.mvs;
  const indexes = table.indexes;
  const cql =
    (dropViews
      ? views.map((m) => "DROP MATERIALIZED VIEW " + ks + "." + m.name + ";\n").join("")
      : "") +
    "DROP TABLE " +
    ks +
    "." +
    table.name +
    ";";

  return (
    <Modal
      onClose={onClose}
      label={t("cass.drop.dropTableTitle")}
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> {t("cass.drop.dropTableTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>{t("cass.drop.dropTableBody", { table: table.name, count: indexes.length })}</p>
        <pre className="truncate-sql">{cql}</pre>
        {views.length ? (
          <div className="schema-import-list">
            {views.map((m) => (
              <div key={m.name} className="schema-import-row">
                <Icon name="dvr" size={14} style={{ color: "var(--text-faint)" }} />
                <span className="schema-import-name">{m.name}</span>
                <span className="schema-import-rows">{t("cass.drop.mvWord")}</span>
              </div>
            ))}
          </div>
        ) : null}
        {views.length ? (
          <label className={"truncate-fk" + (dropViews ? " on" : "")}>
            <input
              type="checkbox"
              checked={dropViews}
              onChange={(e) => setDropViews(e.target.checked)}
              disabled={busy}
            />
            <span className="truncate-fk-text">
              <span className="truncate-fk-label">
                {t("cass.drop.alsoDropMvs", { count: views.length })}
              </span>
              <span className="truncate-fk-hint">{t("cass.drop.mvReason")}</span>
            </span>
          </label>
        ) : null}
        <ConfirmName
          name={table.name}
          env={env}
          typed={typed}
          onTyped={setTyped}
          inputRef={nameRef}
        />
        {error ? <div className="truncate-error">{error}</div> : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          {t("cass.drop.cancel")}
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy ? "" : " disabled")}
          disabled={!armed || busy}
          onClick={confirm}
        >
          <Icon name="delete_forever" size={16} />
          <span>{busy ? t("cass.drop.dropping") : t("cass.drop.dropTableBtn")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}

export function CassEmptyKeyspaceModal({
  handleId,
  ks,
  tables,
  env,
  onClose,
  onEmptied,
}: {
  handleId: string;
  ks: string;
  /** The keyspace's current tables (for the list + count). */
  tables: TableDescriptor[];
  env: string;
  onClose: () => void;
  /** Called after a successful empty so the caller can refresh + close tabs. */
  onEmptied: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const armed = typed.trim() === ks;

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const dropped = await cassEmptyKeyspace(handleId, ks);
        toast(t("cass.drop.emptied", { ks, count: dropped }), "ok");
        onEmptied();
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("cass.drop.emptyFailed")));
        setBusy(false);
      }
    })();
  };

  const mvCount = tables.reduce((n, t) => n + t.mvs.length, 0);

  return (
    <Modal
      onClose={onClose}
      label={t("cass.drop.emptyTitle")}
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> {t("cass.drop.emptyTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>{t("cass.drop.emptyBody", { ks, tables: tables.length, mvs: mvCount })}</p>
        <pre className="truncate-sql">
          {tables.length
            ? tables.map((t) => "DROP TABLE " + ks + "." + t.name + ";").join("\n")
            : t("cass.drop.noTablesToDrop")}
        </pre>
        {tables.length ? (
          <div className="schema-import-list">
            {tables.map((t) => (
              <div key={t.name} className="schema-import-row">
                <Icon name="table_chart" size={14} style={{ color: "var(--text-faint)" }} />
                <span className="schema-import-name">{t.name}</span>
                <span className="schema-import-rows">{t.primaryKey}</span>
              </div>
            ))}
          </div>
        ) : null}
        <ConfirmName name={ks} env={env} typed={typed} onTyped={setTyped} inputRef={nameRef} />
        {error ? <div className="truncate-error">{error}</div> : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          {t("cass.drop.cancel")}
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy && tables.length ? "" : " disabled")}
          disabled={!armed || busy || !tables.length}
          onClick={confirm}
        >
          <Icon name="delete_sweep" size={16} />
          <span>{busy ? t("cass.drop.dropping") : t("cass.drop.emptyBtn")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}

export function CassDropKeyspaceModal({
  handleId,
  ks,
  tables,
  env,
  onClose,
  onDropped,
}: {
  handleId: string;
  ks: string;
  /** The keyspace's current tables (for the list + count). */
  tables: TableDescriptor[];
  env: string;
  onClose: () => void;
  /** Called after a successful drop so the caller can switch keyspace. */
  onDropped: (dropped: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const armed = typed.trim() === ks;

  const confirm = () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await cassDropKeyspace(handleId, ks);
        toast(t("cass.drop.droppedKs", { name: ks }), "ok");
        onDropped(ks);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("cass.drop.dropKsFailed")));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("cass.drop.dropKsTitle")}
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> {t("cass.drop.dropKsTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>{t("cass.drop.dropKsBody", { ks, count: tables.length })}</p>
        <pre className="truncate-sql">DROP KEYSPACE {ks};</pre>
        {tables.length ? (
          <div className="schema-import-list">
            {tables.map((t) => (
              <div key={t.name} className="schema-import-row">
                <Icon name="table_chart" size={14} style={{ color: "var(--text-faint)" }} />
                <span className="schema-import-name">{t.name}</span>
                <span className="schema-import-rows">{t.primaryKey}</span>
              </div>
            ))}
          </div>
        ) : null}
        <ConfirmName name={ks} env={env} typed={typed} onTyped={setTyped} inputRef={nameRef} />
        {error ? <div className="truncate-error">{error}</div> : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onClose} disabled={busy}>
          {t("cass.drop.cancel")}
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy ? "" : " disabled")}
          disabled={!armed || busy}
          onClick={confirm}
        >
          <Icon name="delete_forever" size={16} />
          <span>{busy ? t("cass.drop.dropping") : t("cass.drop.dropKsBtn")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
