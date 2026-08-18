// DynamoDB table lifecycle: create a table, and the two destructive confirms —
// empty a table (delete every item) and delete the table itself.
//
// Same contract as the Mongo (`MongoDdlModals`) and Cassandra (`CassDropModals`)
// dialogs before them: the shared Modal + `.truncate-*` chrome, the name typed
// to arm the button, the env tag escalating the visual weight on production, and
// backend errors surfaced INSIDE the dialog so it stays open on a refusal.
//
// Two things are DynamoDB-specific and are said out loud in the dialogs rather
// than hidden:
//
//   • A table's primary key is fixed at creation and cannot be changed
//     afterwards — so the create dialog is a key-schema decision, not a name.
//   • DynamoDB has no TRUNCATE. "Empty table" scans the keys and batch-deletes
//     them, which costs one write unit per item and takes time proportional to
//     the item count. The cheap alternative (delete the table and recreate it)
//     would silently lose every GSI, LSI, TTL setting and tag, so it is not what
//     this does — but on a big table, deleting and recreating by hand is the
//     faster path, and the dialog says so.

import { useRef, useState, type RefObject } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../../shared/ui/Modal";
import { Select } from "../../../../shared/ui/Select";
import { ENV_COLOR } from "../../../../shared/ui/envColors";
import { useToast } from "../../../../shared/ui/toastContext";
import { normalizeEnv } from "../../../../shared/types";
import { useSettingsStore } from "../../../settings/state";
import {
  dynamoCreateTable,
  dynamoDeleteTable,
  dynamoTruncateTable,
  type KeyAttrType,
  type TableDescriptor,
} from "../api";
import "../../../export/components/TruncateModal.css";

const DANGER = "#e06c75";

const KEY_TYPES: readonly { value: KeyAttrType; label: string }[] = [
  { value: "S", label: "String (S)" },
  { value: "N", label: "Number (N)" },
  { value: "B", label: "Binary (B)" },
];

const BILLING = [
  { value: "PAY_PER_REQUEST" as const, label: "On-demand" },
  { value: "PROVISIONED" as const, label: "Provisioned" },
];

/**
 * DynamoDB's table naming rules, checked before the round trip so a typo gets an
 * answer immediately rather than a `ValidationException`. Returns the problem,
 * or null when the name is usable.
 */
function tableNameError(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (n === "") return null; // nothing typed yet — not an error, just not ready
  if (n.length < 3) return "A table name must be at least 3 characters.";
  if (n.length > 255) return "A table name is limited to 255 characters.";
  if (!/^[A-Za-z0-9_.-]+$/.test(n))
    return "A table name may only contain letters, numbers, and _ . -";
  if (existing.includes(n)) return "A table called “" + n + "” already exists.";
  return null;
}

/** Key attribute names are 1–255 characters; everything else is allowed. */
function attrNameError(name: string, role: string): string | null {
  const n = name.trim();
  if (n === "") return null;
  if (n.length > 255) return "The " + role + " attribute name is limited to 255 characters.";
  return null;
}

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

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function DynamoCreateTableModal({
  handleId,
  existing,
  onClose,
  onCreated,
}: {
  handleId: string;
  /** Existing table names, so a clash is caught before the round trip. */
  existing: string[];
  onClose: () => void;
  /** Called after a successful create so the caller can refresh + open it. */
  onCreated: (table: TableDescriptor) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [pk, setPk] = useState("");
  const [pkType, setPkType] = useState<KeyAttrType>("S");
  const [withSk, setWithSk] = useState(false);
  const [sk, setSk] = useState("");
  const [skType, setSkType] = useState<KeyAttrType>("S");
  const [billing, setBilling] = useState<"PAY_PER_REQUEST" | "PROVISIONED">("PAY_PER_REQUEST");
  const [rcu, setRcu] = useState("5");
  const [wcu, setWcu] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const nameInvalid = tableNameError(name, existing);
  const pkInvalid = attrNameError(pk, "partition key");
  const skInvalid = withSk
    ? sk.trim() !== "" && sk.trim() === pk.trim()
      ? "The sort key must be a different attribute from the partition key."
      : attrNameError(sk, "sort key")
    : null;
  const invalid = nameInvalid ?? pkInvalid ?? skInvalid;
  const armed =
    name.trim() !== "" &&
    pk.trim() !== "" &&
    (!withSk || sk.trim() !== "") &&
    invalid === null &&
    !busy;

  const confirm = () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const desc = await dynamoCreateTable(handleId, {
          name: name.trim(),
          pk: pk.trim(),
          pkType,
          sk: withSk ? sk.trim() : undefined,
          skType: withSk ? skType : undefined,
          billing,
          rcu: billing === "PROVISIONED" ? Number(rcu) || 5 : undefined,
          wcu: billing === "PROVISIONED" ? Number(wcu) || 5 : undefined,
        });
        // The backend waits for ACTIVE but gives up rather than failing a table
        // that is merely slow, so say which of the two happened.
        toast(
          desc.status === "ACTIVE"
            ? "Created table “" + desc.name + "”"
            : "Table “" + desc.name + "” is " + desc.status.toLowerCase() + " — refresh shortly",
          "ok",
        );
        onCreated(desc);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not create the table."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Create table"
      width={520}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="add_box" size={18} style={{ color: "var(--accent)" }} /> Create table
      </ModalTitle>
      <div className="truncate-body">
        <p>
          A table's <b>primary key is permanent</b> — DynamoDB cannot change it later, and every
          query you can run is shaped by it. Everything else about an item stays schemaless.
        </p>
        <div className="truncate-prod">
          <label>
            Table name
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              placeholder="Orders"
              spellCheck="false"
              aria-label="Table name"
            />
          </label>

          <div className="ddb-ddl-row">
            <label className="ddb-ddl-grow">
              Partition key
              <input
                value={pk}
                onChange={(e) => setPk(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
                placeholder="PK"
                spellCheck="false"
                aria-label="Partition key attribute"
              />
            </label>
            <label className="ddb-ddl-type">
              Type
              <Select
                className="sel-block"
                value={pkType}
                options={KEY_TYPES}
                onChange={setPkType}
                mono={false}
                aria-label="Partition key type"
              />
            </label>
          </div>

          {/* A sort key is optional and cannot be added later either, so it is
              offered here rather than left to a "modify table" that DynamoDB
              does not have. */}
          <label className="ddb-ddl-check">
            <input
              type="checkbox"
              checked={withSk}
              onChange={(e) => setWithSk(e.target.checked)}
              aria-label="Add a sort key"
            />
            <span>Composite key — add a sort key</span>
          </label>

          {withSk ? (
            <div className="ddb-ddl-row">
              <label className="ddb-ddl-grow">
                Sort key
                <input
                  value={sk}
                  onChange={(e) => setSk(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirm();
                  }}
                  placeholder="SK"
                  spellCheck="false"
                  aria-label="Sort key attribute"
                />
              </label>
              <label className="ddb-ddl-type">
                Type
                <Select
                  className="sel-block"
                  value={skType}
                  options={KEY_TYPES}
                  onChange={setSkType}
                  mono={false}
                  aria-label="Sort key type"
                />
              </label>
            </div>
          ) : null}

          <div className="ddb-ddl-row">
            <label className="ddb-ddl-grow">
              Capacity
              <Select
                className="sel-block"
                value={billing}
                options={BILLING}
                onChange={setBilling}
                mono={false}
                aria-label="Billing mode"
              />
            </label>
            {billing === "PROVISIONED" ? (
              <>
                <label className="ddb-ddl-type">
                  Read units
                  <input
                    value={rcu}
                    onChange={(e) => setRcu(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    aria-label="Read capacity units"
                  />
                </label>
                <label className="ddb-ddl-type">
                  Write units
                  <input
                    value={wcu}
                    onChange={(e) => setWcu(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    aria-label="Write capacity units"
                  />
                </label>
              </>
            ) : null}
          </div>
          <p className="ddb-ddl-hint">
            {billing === "PAY_PER_REQUEST"
              ? "On-demand bills per request with no capacity to plan — the safe default."
              : "Provisioned reserves capacity around the clock, billed whether it is used or not."}
          </p>
        </div>
        {invalid ? (
          <div className="truncate-error">
            <Icon name="error" size={15} /> {invalid}
          </div>
        ) : null}
        {error ? (
          <div className="truncate-error">
            <Icon name="error" size={15} /> {error}
          </div>
        ) : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <Btn icon="add" variant="filled" disabled={!armed} onClick={confirm}>
          {busy ? "Creating…" : "Create table"}
        </Btn>
      </ModalActions>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Truncate (delete every item)
// ---------------------------------------------------------------------------

export function DynamoTruncateTableModal({
  handleId,
  table,
  count,
  env,
  onClose,
  onTruncated,
}: {
  handleId: string;
  table: string;
  /** Items currently in it, when known — DescribeTable's approximate count. */
  count?: number | null;
  env: string;
  onClose: () => void;
  onTruncated: (table: string) => void;
}) {
  const toast = useToast();
  const confirmProd = useSettingsStore((s) => s.settings.confirmProd);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Production gate only — the table, its key schema and its indexes all
  // survive, so a typed name everywhere would be friction out of proportion.
  const isProd = normalizeEnv(env) === "production" && confirmProd;
  const armed = (!isProd || typed.trim() === table) && !busy;

  const confirm = () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const removed = await dynamoTruncateTable(handleId, table);
        toast(
          "Emptied “" +
            table +
            "” — " +
            removed.toLocaleString() +
            " item" +
            (removed === 1 ? "" : "s") +
            " deleted",
          "ok",
        );
        onTruncated(table);
        onClose();
      } catch (err) {
        // Partial progress is real here: whatever was deleted before the
        // failure stays deleted, so the caller refreshes either way.
        setError(appErrorMessage(err, "Could not empty the table."));
        onTruncated(table);
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Empty table"
      width={500}
      className="truncate-modal"
      initialFocusRef={isProd ? nameRef : cancelRef}
    >
      <ModalTitle>
        <Icon name="delete_sweep" size={18} style={{ color: DANGER }} /> Empty table
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This deletes <b>every item</b>
          {count !== null && count !== undefined ? (
            <>
              {" "}
              — about <b>{count.toLocaleString()}</b> of them
            </>
          ) : null}{" "}
          from <code>{table}</code>. The table, its key schema, its indexes and its TTL settings all
          stay.
        </p>
        <p>
          DynamoDB has no TRUNCATE, so this scans the keys and deletes them in batches:{" "}
          <b>one write unit per item</b>, and it runs for as long as that takes. On a large table it
          is cheaper to delete the table and create it again — at the cost of rebuilding its
          indexes.
        </p>
        <pre className="truncate-sql">
          Scan {table} (keys only) → BatchWriteItem DeleteRequest ×N
        </pre>
        {isProd ? (
          <ConfirmName name={table} env={env} typed={typed} onTyped={setTyped} inputRef={nameRef} />
        ) : null}
        {error ? (
          <div className="truncate-error">
            <Icon name="error" size={15} /> {error}
          </div>
        ) : null}
      </div>
      <ModalActions>
        <Btn ref={cancelRef} variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={confirm}>
          <Icon name="delete_sweep" size={16} />
          <span>{busy ? "Emptying…" : "Empty table"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Delete table
// ---------------------------------------------------------------------------

export function DynamoDeleteTableModal({
  handleId,
  table,
  count,
  indexes,
  env,
  onClose,
  onDeleted,
}: {
  handleId: string;
  table: string;
  /** Items about to go with it (approximate, from DescribeTable). */
  count?: number | null;
  /** GSI + LSI names — the part that cannot be recreated by a re-import. */
  indexes: string[];
  env: string;
  onClose: () => void;
  onDeleted: (table: string) => void;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Always typed: this takes the key schema and every index with the items, and
  // AWS offers no undo unless the table had point-in-time recovery on.
  const armed = typed.trim() === table && !busy;

  const confirm = () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await dynamoDeleteTable(handleId, table);
        toast("Deleted table “" + table + "”", "ok");
        onDeleted(table);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not delete the table."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Delete table"
      width={500}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="delete_forever" size={18} style={{ color: DANGER }} /> Delete table
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This deletes <code>{table}</code> itself
          {count !== null && count !== undefined ? (
            <>
              {" "}
              — about <b>{count.toLocaleString()}</b> item{count === 1 ? "" : "s"}
            </>
          ) : null}
          {indexes.length > 0 ? (
            <>
              , and its{" "}
              <b>
                {indexes.length} secondary {indexes.length === 1 ? "index" : "indexes"}
              </b>{" "}
              ({indexes.join(", ")})
            </>
          ) : null}
          . Unless point-in-time recovery is on, there is nothing to restore from.
        </p>
        <pre className="truncate-sql">DeleteTable {table}</pre>
        <ConfirmName name={table} env={env} typed={typed} onTyped={setTyped} inputRef={nameRef} />
        {error ? (
          <div className="truncate-error">
            <Icon name="error" size={15} /> {error}
          </div>
        ) : null}
      </div>
      <ModalActions>
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={confirm}>
          <Icon name="delete_forever" size={16} />
          <span>{busy ? "Deleting…" : "Delete table"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
