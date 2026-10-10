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
import { t } from "../../../../shared/i18n";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { Checkbox } from "../../../../shared/ui/Checkbox";
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

const KEY_TYPES: readonly { value: KeyAttrType; labelKey: string }[] = [
  { value: "S", labelKey: "dyn.ddl.typeString" },
  { value: "N", labelKey: "dyn.ddl.typeNumber" },
  { value: "B", labelKey: "dyn.ddl.typeBinary" },
];

const BILLING = [
  { value: "PAY_PER_REQUEST" as const, labelKey: "dyn.billing.onDemand" },
  { value: "PROVISIONED" as const, labelKey: "dyn.billing.provisioned" },
];

/**
 * DynamoDB's table naming rules, checked before the round trip so a typo gets an
 * answer immediately rather than a `ValidationException`. Returns the problem,
 * or null when the name is usable.
 */
function tableNameError(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (n === "") return null; // nothing typed yet — not an error, just not ready
  if (n.length < 3) return t("dyn.ddl.nameMin");
  if (n.length > 255) return t("dyn.ddl.nameMax");
  if (!/^[A-Za-z0-9_.-]+$/.test(n)) return t("dyn.ddl.nameChars");
  if (existing.includes(n)) return t("dyn.ddl.nameExists", { name: n });
  return null;
}

/** Key attribute names are 1–255 characters; everything else is allowed. */
function attrNameError(name: string, role: string): string | null {
  const n = name.trim();
  if (n === "") return null;
  if (n.length > 255) return t("dyn.ddl.attrMax", { role });
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
  const t = useT();
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
        {t("dyn.ddl.typeToConfirmPre")} <b>{name}</b>
        {t("dyn.ddl.typeToConfirmPost")}
        {/* No `autoFocus`: Modal focuses the first tabbable element in its own
            effect, which runs AFTER a child's and would overwrite it — hence
            `initialFocusRef` (documented on Modal). */}
        <input
          ref={inputRef}
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          placeholder={name}
          spellCheck="false"
          aria-label={t("dyn.ddl.typeToConfirmAria", { name })}
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
  const t = useT();
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
  const pkInvalid = attrNameError(pk, t("dyn.ddl.partitionKey"));
  const skInvalid = withSk
    ? sk.trim() !== "" && sk.trim() === pk.trim()
      ? t("dyn.ddl.pkSameSk")
      : attrNameError(sk, t("dyn.ddl.sortKey"))
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
            ? t("dyn.ddl.created", { name: desc.name })
            : t("dyn.ddl.createdPending", { name: desc.name, status: desc.status.toLowerCase() }),
          "ok",
        );
        onCreated(desc);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("dyn.ddl.createFail")));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("dyn.ddl.createLabel")}
      width={520}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="add_box" size={18} style={{ color: "var(--accent)" }} />{" "}
        {t("dyn.ddl.createLabel")}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {t("dyn.ddl.createLeadA")}
          <b>{t("dyn.ddl.createLeadPk")}</b>
          {t("dyn.ddl.createLeadB")}
        </p>
        <div className="truncate-prod">
          <label>
            {t("dyn.ddl.tableName")}
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              placeholder="Orders"
              spellCheck="false"
              aria-label={t("dyn.ddl.tableNameAria")}
            />
          </label>

          <div className="ddb-ddl-row">
            <label className="ddb-ddl-grow">
              {t("dyn.ddl.pkLabel")}
              <input
                value={pk}
                onChange={(e) => setPk(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                }}
                placeholder="PK"
                spellCheck="false"
                aria-label={t("dyn.ddl.pkAria")}
              />
            </label>
            <label className="ddb-ddl-type">
              {t("dyn.typeLabel")}
              <Select
                className="sel-block"
                value={pkType}
                options={KEY_TYPES.map((k) => ({
                  value: k.value,
                  label: t(k.labelKey as "dyn.ddl.typeString"),
                }))}
                onChange={setPkType}
                mono={false}
                aria-label={t("dyn.ddl.pkTypeAria")}
              />
            </label>
          </div>

          {/* A sort key is optional and cannot be added later either, so it is
              offered here rather than left to a "modify table" that DynamoDB
              does not have. */}
          <label className="ddb-ddl-check">
            <Checkbox
              checked={withSk}
              onChange={(e) => setWithSk(e.target.checked)}
              aria-label={t("dyn.ddl.addSkAria")}
            />
            <span>{t("dyn.ddl.addSk")}</span>
          </label>

          {withSk ? (
            <div className="ddb-ddl-row">
              <label className="ddb-ddl-grow">
                {t("dyn.ddl.skLabel")}
                <input
                  value={sk}
                  onChange={(e) => setSk(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirm();
                  }}
                  placeholder="SK"
                  spellCheck="false"
                  aria-label={t("dyn.ddl.skAria")}
                />
              </label>
              <label className="ddb-ddl-type">
                {t("dyn.typeLabel")}
                <Select
                  className="sel-block"
                  value={skType}
                  options={KEY_TYPES.map((k) => ({
                    value: k.value,
                    label: t(k.labelKey as "dyn.ddl.typeString"),
                  }))}
                  onChange={setSkType}
                  mono={false}
                  aria-label={t("dyn.ddl.skTypeAria")}
                />
              </label>
            </div>
          ) : null}

          <div className="ddb-ddl-row">
            <label className="ddb-ddl-grow">
              {t("dyn.ddl.capacity")}
              <Select
                className="sel-block"
                value={billing}
                options={BILLING.map((b) => ({
                  value: b.value,
                  label: t(b.labelKey as "dyn.billing.onDemand"),
                }))}
                onChange={setBilling}
                mono={false}
                aria-label={t("dyn.ddl.billingAria")}
              />
            </label>
            {billing === "PROVISIONED" ? (
              <>
                <label className="ddb-ddl-type">
                  {t("dyn.ddl.readUnits")}
                  <input
                    value={rcu}
                    onChange={(e) => setRcu(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    aria-label={t("dyn.ddl.rcuAria")}
                  />
                </label>
                <label className="ddb-ddl-type">
                  {t("dyn.ddl.writeUnits")}
                  <input
                    value={wcu}
                    onChange={(e) => setWcu(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    aria-label={t("dyn.ddl.wcuAria")}
                  />
                </label>
              </>
            ) : null}
          </div>
          <p className="ddb-ddl-hint">
            {billing === "PAY_PER_REQUEST"
              ? t("dyn.ddl.hintOnDemand")
              : t("dyn.ddl.hintProvisioned")}
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
          {t("common.cancel")}
        </Btn>
        <Btn icon="add" variant="filled" disabled={!armed} onClick={confirm}>
          {busy ? t("dyn.ddl.creating") : t("dyn.ddl.createLabel")}
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
  const t = useT();
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
          t("dyn.ddl.emptiedPre", { table }) +
            (removed === 1
              ? t("dyn.ddl.deleted1", { count: removed })
              : t("dyn.ddl.deletedN", { count: removed })),
          "ok",
        );
        onTruncated(table);
        onClose();
      } catch (err) {
        // Partial progress is real here: whatever was deleted before the
        // failure stays deleted, so the caller refreshes either way.
        setError(appErrorMessage(err, t("dyn.ddl.emptyFail")));
        onTruncated(table);
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("dyn.ddl.emptyLabel")}
      width={500}
      className="truncate-modal"
      initialFocusRef={isProd ? nameRef : cancelRef}
    >
      <ModalTitle>
        <Icon name="delete_sweep" size={18} style={{ color: DANGER }} /> {t("dyn.ddl.emptyLabel")}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {t("dyn.ddl.truncA")}
          <b>{t("dyn.ddl.truncEvery")}</b>
          {count !== null && count !== undefined ? (
            <>
              {t("dyn.ddl.truncCountA")}
              <b>{count.toLocaleString()}</b>
              {t("dyn.ddl.truncCountB")}
            </>
          ) : null}
          {t("dyn.ddl.truncFrom")} <code>{table}</code>
          {t("dyn.ddl.truncTail")}
        </p>
        <p>
          {t("dyn.ddl.truncPara2A")}
          <b>{t("dyn.ddl.truncPara2Bold")}</b>
          {t("dyn.ddl.truncPara2B")}
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
          {t("common.cancel")}
        </Btn>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={confirm}>
          <Icon name="delete_sweep" size={16} />
          <span>{busy ? t("dyn.ddl.emptying") : t("dyn.ddl.emptyLabel")}</span>
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
  const t = useT();
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
        toast(t("dyn.ddl.deletedTable", { table }), "ok");
        onDeleted(table);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("dyn.ddl.deleteFail")));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("dyn.ddl.deleteLabel")}
      width={500}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="delete_forever" size={18} style={{ color: DANGER }} />{" "}
        {t("dyn.ddl.deleteLabel")}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {t("dyn.ddl.delA")} <code>{table}</code>
          {t("dyn.ddl.delSelf")}
          {count !== null && count !== undefined ? (
            <>
              {t("dyn.ddl.delCountA")}
              <b>{count.toLocaleString()}</b>
              {count === 1
                ? t("dyn.ddl.delCountB1", { count })
                : t("dyn.ddl.delCountBN", { count })}
            </>
          ) : null}
          {indexes.length > 0 ? (
            <>
              {t("dyn.ddl.delIdxA")}{" "}
              <b>
                {indexes.length === 1
                  ? t("dyn.ddl.delIdx1", { count: indexes.length })
                  : t("dyn.ddl.delIdxN", { count: indexes.length })}
              </b>{" "}
              ({indexes.join(", ")})
            </>
          ) : null}
          {t("dyn.ddl.delTail")}
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
          {t("common.cancel")}
        </Btn>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={confirm}>
          <Icon name="delete_forever" size={16} />
          <span>{busy ? t("dyn.ddl.deleting") : t("dyn.ddl.deleteLabel")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Region-wide: empty every table / drop every table
// ---------------------------------------------------------------------------

/**
 * The two bulk actions on the region's ⋯ menu. One dialog, because they differ
 * only in what they say and which call they loop — but they differ ENORMOUSLY in
 * cost, and the dialog says so:
 *
 *   • Drop is a control-plane call. AWS does not bill for it and it does not
 *     consume write capacity, so it costs the same on an empty table as on one
 *     with 500M items. What it costs is everything else: the GSIs, LSIs, TTL
 *     config, tags, stream settings and PITR history go with each table, and
 *     nothing brings them back.
 *   • Empty keeps all of that, and pays for it — a key-only scan plus one write
 *     unit per item, per table. On a large region that is a real bill.
 *
 * Both run table-by-table from here rather than as one backend call: DynamoDB's
 * DDL is asynchronous and a big region can take minutes, so progress has to be
 * visible. A table that fails does not stop the rest; the failures are listed at
 * the end instead of vanishing into a single error.
 */
export function DynamoBulkTableModal({
  handleId,
  action,
  region,
  tables,
  env,
  onClose,
  onDone,
}: {
  handleId: string;
  action: "empty" | "drop";
  region: string;
  tables: TableDescriptor[];
  env: string;
  onClose: () => void;
  /** Called after the run (even a partial one) so the caller can refresh. */
  onDone: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ table: string; message: string }[]>([]);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const isDrop = action === "drop";
  // Always typed: both act on every table in the region at once, and neither has
  // an undo. The region name is the scope's own identifier.
  const armed = typed.trim() === region && !running && tables.length > 0;
  const totalItems = tables.reduce((n, t) => n + t.itemCount, 0);

  const run = () => {
    if (!armed) return;
    setRunning(true);
    setFailed([]);
    setDoneCount(0);
    void (async () => {
      const errors: { table: string; message: string }[] = [];
      for (const tb of tables) {
        setCurrent(tb.name);
        try {
          if (isDrop) await dynamoDeleteTable(handleId, tb.name);
          else await dynamoTruncateTable(handleId, tb.name);
        } catch (err) {
          errors.push({ table: tb.name, message: appErrorMessage(err, t("dyn.ddl.bulkFail")) });
        }
        setDoneCount((n) => n + 1);
      }
      setCurrent(null);
      setFailed(errors);
      setRunning(false);
      onDone();
      const ok = tables.length - errors.length;
      if (errors.length === 0) {
        toast(
          (isDrop ? t("dyn.ddl.bulkDropped") : t("dyn.ddl.bulkEmptied")) +
            (ok === 1 ? t("dyn.ddl.tables1", { count: ok }) : t("dyn.ddl.tablesN", { count: ok })),
          "ok",
        );
        onClose();
      } else {
        toast(t("dyn.ddl.bulkPartial", { ok, total: tables.length, failed: errors.length }), "err");
      }
    })();
  };

  return (
    <Modal
      onClose={running ? () => {} : onClose}
      label={isDrop ? t("dyn.ddl.dropAll") : t("dyn.ddl.emptyAll")}
      width={520}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon
          name={isDrop ? "delete_forever" : "delete_sweep"}
          size={18}
          style={{ color: DANGER }}
        />{" "}
        {isDrop ? t("dyn.ddl.dropAll") : t("dyn.ddl.emptyAll")}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {isDrop ? t("dyn.ddl.bulkVerbDrop") : t("dyn.ddl.bulkVerbEmpty")}
          <b>
            {tables.length === 1
              ? t("dyn.ddl.bulkAll1", { count: tables.length })
              : t("dyn.ddl.bulkAllN", { count: tables.length })}
          </b>
          {t("dyn.ddl.bulkIn")}
          <code>{region}</code>
          {isDrop ? (
            t("dyn.ddl.bulkDropTail")
          ) : (
            <>
              {t("dyn.ddl.bulkEmptyMid")}
              <b>{totalItems.toLocaleString()}</b>
              {t("dyn.ddl.bulkEmptyTail")}
            </>
          )}
        </p>
        {isDrop ? (
          <p>
            {t("dyn.ddl.bulkFreeA")}
            <b>{t("dyn.ddl.bulkFree")}</b>
            {t("dyn.ddl.bulkFreeB")}
          </p>
        ) : (
          <p>
            {t("dyn.ddl.bulkNoTruncA")}
            <b>{t("dyn.ddl.bulkScanAll")}</b>
            {t("dyn.ddl.bulkNoTruncB")}
            <b>{t("dyn.ddl.bulkWriteUnit")}</b>
            {t("dyn.ddl.bulkNoTruncC")}
          </p>
        )}
        <pre className="truncate-sql">
          {tables
            .map((tb) => (isDrop ? "DeleteTable " : t("dyn.ddl.verbEmpty") + " ") + tb.name)
            .join("\n")}
        </pre>

        {running || doneCount > 0 ? (
          <div className="ddb-bulk-progress">
            <Icon name="hourglass_top" size={14} />
            <span>
              {doneCount} / {tables.length}
              {current ? " · " + current : ""}
            </span>
          </div>
        ) : null}

        {failed.length > 0 ? (
          <div className="truncate-error">
            <Icon name="error" size={15} />
            <span>
              {t("dyn.ddl.bulkFailed", {
                count: failed.length,
                list: failed.map((f) => f.table).join(", "),
              })}
            </span>
          </div>
        ) : null}

        <ConfirmName name={region} env={env} typed={typed} onTyped={setTyped} inputRef={nameRef} />
      </div>
      <ModalActions>
        <Btn variant="text" disabled={running} onClick={onClose}>
          {failed.length > 0 ? t("common.close") : t("common.cancel")}
        </Btn>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={run}>
          <Icon name={isDrop ? "delete_forever" : "delete_sweep"} size={16} />
          <span>
            {running
              ? isDrop
                ? t("dyn.ddl.dropping")
                : t("dyn.ddl.emptying")
              : isDrop
                ? t("dyn.ddl.bulkBtnDrop", { count: tables.length })
                : t("dyn.ddl.bulkBtnEmpty", { count: tables.length })}
          </span>
        </button>
      </ModalActions>
    </Modal>
  );
}
