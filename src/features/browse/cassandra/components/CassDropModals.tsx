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
  const normEnv = normalizeEnv(env);
  const envColor = ENV_COLOR[normEnv];
  return (
    <div className="truncate-prod">
      {normEnv === "production" ? (
        <div
          className="truncate-prod-tag"
          style={{ color: envColor, borderColor: envColor + "66", background: envColor + "14" }}
        >
          <Icon name="public" size={13} /> production
        </div>
      ) : null}
      <label>
        Type <b>{name}</b> to confirm
        {/* No `autoFocus`: Modal focuses the first tabbable element in its own
            effect, which runs AFTER a child's and would overwrite it — hence
            `initialFocusRef` (documented on Modal). */}
        <input
          ref={inputRef}
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          placeholder={name}
          spellCheck="false"
          aria-label={"Type " + name + " to confirm"}
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
        toast("TRUNCATE " + table.name + " — applied", "ok");
        onTruncated(table.name);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not truncate the table."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Truncate table"
      width={480}
      className="truncate-modal"
      initialFocusRef={isProd ? nameRef : cancelRef}
    >
      <ModalTitle>
        <Icon name="delete_sweep" size={18} style={{ color: DANGER }} /> Truncate table
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This removes <b>every row</b> from <code>{table.name}</code>. The table, its columns and
          its indexes stay
          {table.mvs.length ? (
            <>
              , and the{" "}
              <b>
                {table.mvs.length} materialized view{table.mvs.length === 1 ? "" : "s"}
              </b>{" "}
              built on it are emptied with it
            </>
          ) : null}
          .
        </p>
        <pre className="truncate-sql">
          TRUNCATE TABLE {ks}.{table.name};
        </pre>
        {/* The caveats are real but long, and a 480px dialog is the wrong place
            to spend six lines on them — they live in the hint bubble. */}
        <p className="cass-create-note">
          Runs at consistency <code>ALL</code> and leaves a snapshot behind{" "}
          <InfoHint text="Cassandra truncates at consistency ALL: every replica must be reachable, or the statement fails — a single node down is enough. With the default auto_snapshot the rows are kept in a truncated-* snapshot, so the disk is not freed until an operator clears it (nodetool clearsnapshot)." />
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
          Cancel
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy ? "" : " disabled")}
          disabled={!armed || busy}
          onClick={confirm}
        >
          <Icon name="delete_sweep" size={16} />
          <span>{busy ? "Truncating…" : "Truncate table"}</span>
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
        toast("DROP TABLE " + table.name + " — applied", "ok");
        onDropped(table.name);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not drop the table."));
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
      label="Drop table"
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> Drop table
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This removes the table <code>{table.name}</code> and every row in it
          {indexes.length ? (
            <>
              , along with its{" "}
              <b>
                {indexes.length} secondary index{indexes.length === 1 ? "" : "es"}
              </b>
            </>
          ) : null}
          . This cannot be undone.
        </p>
        <pre className="truncate-sql">{cql}</pre>
        {views.length ? (
          <div className="schema-import-list">
            {views.map((m) => (
              <div key={m.name} className="schema-import-row">
                <Icon name="dvr" size={14} style={{ color: "var(--text-faint)" }} />
                <span className="schema-import-name">{m.name}</span>
                <span className="schema-import-rows">materialized view</span>
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
                Also drop the {views.length} materialized view
                {views.length === 1 ? "" : "s"} built on this table
              </span>
              <span className="truncate-fk-hint">
                Cassandra refuses to drop a table while a view depends on it, and has no CASCADE.
                Without this the drop fails and the table stays.
              </span>
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
          Cancel
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy ? "" : " disabled")}
          disabled={!armed || busy}
          onClick={confirm}
        >
          <Icon name="delete_forever" size={16} />
          <span>{busy ? "Dropping…" : "Drop table"}</span>
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
        toast(
          "Emptied " + ks + " — " + dropped + " table" + (dropped === 1 ? "" : "s") + " dropped",
          "ok",
        );
        onEmptied();
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not empty the keyspace."));
        setBusy(false);
      }
    })();
  };

  const mvCount = tables.reduce((n, t) => n + t.mvs.length, 0);

  return (
    <Modal
      onClose={onClose}
      label="Empty keyspace"
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> Empty keyspace
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This drops{" "}
          <b>
            all {tables.length} table{tables.length === 1 ? "" : "s"}
          </b>{" "}
          in <code>{ks}</code> and their data
          {mvCount ? (
            <>
              , plus the{" "}
              <b>
                {mvCount} materialized view{mvCount === 1 ? "" : "s"}
              </b>{" "}
              built on them
            </>
          ) : null}
          . The keyspace itself stays, with its replication settings, so you can rebuild into it.
          This cannot be undone.
        </p>
        <pre className="truncate-sql">
          {tables.length
            ? tables.map((t) => "DROP TABLE " + ks + "." + t.name + ";").join("\n")
            : "-- no tables to drop"}
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
          Cancel
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy && tables.length ? "" : " disabled")}
          disabled={!armed || busy || !tables.length}
          onClick={confirm}
        >
          <Icon name="delete_sweep" size={16} />
          <span>{busy ? "Dropping…" : "Empty keyspace"}</span>
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
        toast("DROP KEYSPACE " + ks + " — applied", "ok");
        onDropped(ks);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not drop the keyspace."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Drop keyspace"
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="warning" size={18} style={{ color: DANGER }} /> Drop keyspace
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This removes the keyspace <code>{ks}</code> itself
          {tables.length ? (
            <>
              , along with{" "}
              <b>
                all {tables.length} table{tables.length === 1 ? "" : "s"}
              </b>{" "}
              in it and their data
            </>
          ) : null}
          , plus its replication settings. Nothing is left to re-import into. This cannot be undone.
        </p>
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
          Cancel
        </Btn>
        <button
          type="button"
          className={"btn btn-danger" + (armed && !busy ? "" : " disabled")}
          disabled={!armed || busy}
          onClick={confirm}
        >
          <Icon name="delete_forever" size={16} />
          <span>{busy ? "Dropping…" : "Drop keyspace"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
