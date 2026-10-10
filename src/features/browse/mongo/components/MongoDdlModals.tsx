// MongoDB collection lifecycle: create a collection, and the three destructive
// confirms — truncate a collection, drop a collection, empty a database.
//
// Deliberately the same contract as the Cassandra pair (`CassDropModals`) and
// the SQL ones before it: the shared Modal + `.truncate-*` chrome, the name
// typed to arm the button, the env tag escalating the visual weight on
// production, and backend errors surfaced INSIDE the dialog so it stays open on
// a refusal rather than vanishing and leaving a toast to explain.
//
// Truncate is the light one and is gated accordingly — the collection, its
// indexes and its validator all survive, so it asks for a typed name only on a
// production connection (and only when "Confirm writes on production" is on).
// The two structural dialogs always require it: a dropped collection takes its
// indexes and validator with it, MongoDB has no transaction to roll that back,
// and "empty database" does it to every collection at once.
//
// Why create exists at all, when MongoDB makes a collection on first insert:
// implicit creation cannot give you an empty collection to import into, or one
// to index and validate before any data arrives.

import { useRef, useState, type RefObject } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { t } from "../../../../shared/i18n";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../../shared/ui/Modal";
import { ENV_COLOR } from "../../../../shared/ui/envColors";
import { useToast } from "../../../../shared/ui/toastContext";
import { normalizeEnv } from "../../../../shared/types";
import { useSettingsStore } from "../../../settings/state";
import {
  mongoCreateCollection,
  mongoDropCollection,
  mongoDropDatabase,
  mongoEmptyDatabase,
  mongoTruncateCollection,
} from "../api";
import "../../../export/components/TruncateModal.css";

const DANGER = "#e06c75";

/**
 * MongoDB's collection naming rules, checked before the round trip so a typo
 * gets an answer immediately rather than a driver error. Returns the problem,
 * or null when the name is usable.
 */
function collectionNameError(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (n === "") return null; // nothing typed yet — not an error, just not ready
  if (n.startsWith("system.")) return t("mongo.err.nameReserved");
  if (n.includes("$")) return t("mongo.err.nameDollar");
  if (n.includes("\0")) return t("mongo.err.nameNull");
  // The server's limit is on the full namespace; 200 leaves room for the
  // database name and the dot without guessing at the exact budget.
  if (new Blob([n]).size > 200) return t("mongo.err.nameTooLong");
  if (existing.includes(n)) return t("mongo.err.nameExists", { name: n });
  return null;
}

/**
 * MongoDB's database naming rules. Stricter than the collection ones: the name
 * becomes a directory on disk, so the filesystem's forbidden characters are
 * forbidden here too, and the limit is 63 bytes rather than a namespace budget.
 */
function databaseNameError(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (n === "") return null;
  if (/[/\\. "$*<>:|?]/.test(n)) return t("mongo.err.dbChars");
  if (n.includes("\0")) return t("mongo.err.dbNull");
  if (new Blob([n]).size > 63) return t("mongo.err.dbTooLong");
  // MongoDB compares database names case-insensitively on most deployments, so
  // a name differing only in case would be refused by the server.
  const clash = existing.find((e) => e.toLowerCase() === n.toLowerCase());
  if (clash) return t("mongo.err.dbExists", { name: clash });
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
        {t("uix.bulkDelete.typePre")} <b>{name}</b> {t("uix.bulkDelete.typePost")}
        {/* No `autoFocus`: Modal focuses the first tabbable element in its own
            effect, which runs AFTER a child's and would overwrite it — hence
            `initialFocusRef` (documented on Modal). */}
        <input
          ref={inputRef}
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          placeholder={name}
          spellCheck="false"
          aria-label={t("mongo.typeConfirmAria", { name })}
        />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function MongoCreateCollectionModal({
  handleId,
  db,
  existing,
  onClose,
  onCreated,
}: {
  handleId: string;
  db: string;
  /** Existing collection names, so a clash is caught before the round trip. */
  existing: string[];
  onClose: () => void;
  /** Called after a successful create so the caller can refresh + open it. */
  onCreated: (coll: string) => void;
}) {
  const toast = useToast();
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const invalid = collectionNameError(name, existing);
  const armed = name.trim() !== "" && invalid === null && !busy;

  const confirm = () => {
    if (!armed) return;
    const coll = name.trim();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await mongoCreateCollection(handleId, db, coll);
        toast(t("mongo.createdColl", { coll }), "ok");
        onCreated(coll);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("mongo.createCollFail")));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("mongo.createCollTitle")}
      width={460}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="create_new_folder" size={18} style={{ color: "var(--accent)" }} />{" "}
        {t("mongo.createCollTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {t("mongo.createCollBodyPre")}
          <code>{db}</code>
          {t("mongo.createCollBodyPost")}
        </p>
        <div className="truncate-prod">
          <label>
            {t("mongo.collName")}
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              placeholder="events"
              spellCheck="false"
              aria-label={t("mongo.collName")}
            />
          </label>
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
          {busy ? t("mongo.creating") : t("mongo.createCollTitle")}
        </Btn>
      </ModalActions>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Create database
// ---------------------------------------------------------------------------

/**
 * MongoDB has no "create an empty database" operation — a database begins to
 * exist when something is written into it. So this asks for a first collection
 * too, and creates that; the database comes into being as a side effect. Compass
 * does the same thing for the same reason, and the dialog says so rather than
 * letting the extra field look like an arbitrary requirement.
 */
export function MongoCreateDatabaseModal({
  handleId,
  existing,
  onClose,
  onCreated,
}: {
  handleId: string;
  /** Existing database names, so a clash is caught before the round trip. */
  existing: string[];
  onClose: () => void;
  /** Called after a successful create, with the new database and collection. */
  onCreated: (db: string, coll: string) => void;
}) {
  const toast = useToast();
  const t = useT();
  const [db, setDb] = useState("");
  const [coll, setColl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dbRef = useRef<HTMLInputElement | null>(null);

  const dbInvalid = databaseNameError(db, existing);
  // A brand-new database holds no collections, so nothing to clash with.
  const collInvalid = collectionNameError(coll, []);
  const armed = db.trim() !== "" && coll.trim() !== "" && !dbInvalid && !collInvalid && !busy;

  const confirm = () => {
    if (!armed) return;
    const dbName = db.trim();
    const collName = coll.trim();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await mongoCreateCollection(handleId, dbName, collName);
        toast(t("mongo.createdDb", { db: dbName, coll: collName }), "ok");
        onCreated(dbName, collName);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("mongo.createDbFail")));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("mongo.createDbTitle")}
      width={460}
      className="truncate-modal"
      initialFocusRef={dbRef}
    >
      <ModalTitle>
        <Icon name="create_new_folder" size={18} style={{ color: "var(--accent)" }} />{" "}
        {t("mongo.createDbTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>{t("mongo.createDbBody")}</p>
        <div className="truncate-prod">
          <label>
            {t("mongo.dbName")}
            <input
              ref={dbRef}
              value={db}
              onChange={(e) => setDb(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              placeholder="analytics"
              spellCheck="false"
              aria-label={t("mongo.dbName")}
            />
          </label>
          <label>
            {t("mongo.firstColl")}
            <input
              value={coll}
              onChange={(e) => setColl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              placeholder="events"
              spellCheck="false"
              aria-label={t("mongo.firstCollAria")}
            />
          </label>
        </div>
        {dbInvalid || collInvalid ? (
          <div className="truncate-error">
            <Icon name="error" size={15} /> {dbInvalid ?? collInvalid}
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
          {busy ? t("mongo.creating") : t("mongo.createDbTitle")}
        </Btn>
      </ModalActions>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Truncate
// ---------------------------------------------------------------------------

export function MongoTruncateCollectionModal({
  handleId,
  db,
  coll,
  count,
  env,
  onClose,
  onTruncated,
}: {
  handleId: string;
  db: string;
  coll: string;
  /** Documents currently in it, when known — named in the warning. */
  count?: number | null;
  env: string;
  onClose: () => void;
  onTruncated: (coll: string) => void;
}) {
  const toast = useToast();
  const t = useT();
  const confirmProd = useSettingsStore((s) => s.settings.confirmProd);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Production gate only — the collection, its indexes and its validator all
  // survive, so a typed name everywhere would be friction out of proportion.
  const isProd = normalizeEnv(env) === "production" && confirmProd;
  const armed = (!isProd || typed.trim() === coll) && !busy;

  const confirm = () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const removed = await mongoTruncateCollection(handleId, db, coll);
        toast(t("mongo.emptiedColl", { coll, count: removed }), "ok");
        onTruncated(coll);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("mongo.emptyCollFail")));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("mongo.emptyCollTitle")}
      width={480}
      className="truncate-modal"
      initialFocusRef={isProd ? nameRef : cancelRef}
    >
      <ModalTitle>
        <Icon name="delete_sweep" size={18} style={{ color: DANGER }} /> {t("mongo.emptyCollTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {t("mongo.emptyCollBodyPre")}
          <b>{t("mongo.emptyCollEveryDoc")}</b>
          {count !== null && count !== undefined ? (
            <>
              {t("mongo.emptyCollCountPre")}
              <b>{count.toLocaleString()}</b>
              {t("mongo.emptyCollBodyMid")}
            </>
          ) : null}
          <code>{coll}</code>
          {t("mongo.emptyCollBodyPost")}
        </p>
        <pre className="truncate-sql">
          db.{coll}.deleteMany({"{}"})
        </pre>
        {isProd ? (
          <ConfirmName name={coll} env={env} typed={typed} onTyped={setTyped} inputRef={nameRef} />
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
          <span>{busy ? t("mongo.emptying") : t("mongo.emptyCollTitle")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Drop
// ---------------------------------------------------------------------------

export function MongoDropCollectionModal({
  handleId,
  db,
  coll,
  env,
  onClose,
  onDropped,
}: {
  handleId: string;
  db: string;
  coll: string;
  env: string;
  onClose: () => void;
  onDropped: (coll: string) => void;
}) {
  const toast = useToast();
  const t = useT();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Always typed: this takes the indexes and the validator with the documents,
  // and there is no transaction to roll it back.
  const armed = typed.trim() === coll && !busy;

  const confirm = () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await mongoDropCollection(handleId, db, coll);
        toast(t("mongo.droppedColl", { coll }), "ok");
        onDropped(coll);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("mongo.dropCollFail")));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("mongo.dropCollTitle")}
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="delete_forever" size={18} style={{ color: DANGER }} />{" "}
        {t("mongo.dropCollTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {t("mongo.dropCollBodyPre")}
          <code>{coll}</code>
          {t("mongo.dropCollBodyMid")}
          <code>{db}</code>
          {t("mongo.dropCollBodyPost")}
        </p>
        <pre className="truncate-sql">db.{coll}.drop()</pre>
        <ConfirmName name={coll} env={env} typed={typed} onTyped={setTyped} inputRef={nameRef} />
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
          <span>{busy ? t("mongo.dropping") : t("mongo.dropCollTitle")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Drop database
// ---------------------------------------------------------------------------

/**
 * The heavier half of the pair: this takes the database itself, not just its
 * contents. `MongoEmptyDatabaseModal` below leaves an empty database standing
 * as a rebuild target — the same distinction SQL draws between "Empty schema"
 * and "Delete schema", and Cassandra between "Empty keyspace" and "Drop
 * keyspace".
 */
export function MongoDropDatabaseModal({
  handleId,
  db,
  collections,
  env,
  onClose,
  onDropped,
}: {
  handleId: string;
  db: string;
  /** Collections about to go with it — the scope, stated plainly. */
  collections: string[];
  env: string;
  onClose: () => void;
  onDropped: (db: string) => void;
}) {
  const toast = useToast();
  const t = useT();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const armed = typed.trim() === db && !busy;

  const confirm = () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await mongoDropDatabase(handleId, db);
        toast(t("mongo.droppedDb", { db }), "ok");
        onDropped(db);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, t("mongo.dropDbFail")));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("mongo.dropDbTitle")}
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="delete_forever" size={18} style={{ color: DANGER }} /> {t("mongo.dropDbTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {t("mongo.dropDbBodyPre")}
          <code>{db}</code>
          {t("mongo.dropDbBodyMid")}
          <b>{t("mongo.dropDbBodyCount", { count: collections.length })}</b>
          {t("mongo.dropDbBodyPost")}
        </p>
        <pre className="truncate-sql">db.dropDatabase()</pre>
        <ConfirmName name={db} env={env} typed={typed} onTyped={setTyped} inputRef={nameRef} />
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
          <span>{busy ? t("mongo.dropping") : t("mongo.dropDbTitle")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Empty database (drop every collection)
// ---------------------------------------------------------------------------

export function MongoEmptyDatabaseModal({
  handleId,
  db,
  collections,
  env,
  onClose,
  onEmptied,
}: {
  handleId: string;
  db: string;
  /** Names about to be dropped — listed so the scope is explicit. */
  collections: string[];
  env: string;
  onClose: () => void;
  onEmptied: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const armed = typed.trim() === db && !busy && collections.length > 0;

  const confirm = () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const dropped = await mongoEmptyDatabase(handleId, db);
        toast(t("mongo.emptiedDb", { db, count: dropped.length }), "ok");
        onEmptied();
        onClose();
      } catch (err) {
        // The backend stops at the first refusal, so some collections may
        // already be gone; the caller refreshes either way.
        setError(appErrorMessage(err, t("mongo.emptyDbFail")));
        onEmptied();
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label={t("mongo.emptyDbTitle")}
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="delete_forever" size={18} style={{ color: DANGER }} /> {t("mongo.emptyDbTitle")}
      </ModalTitle>
      <div className="truncate-body">
        <p>
          {t("mongo.emptyDbBodyPre")}
          <b>{t("mongo.emptyDbEveryColl")}</b>
          {t("mongo.emptyDbBodyIn")}
          <code>{db}</code>
          {t("mongo.emptyDbCountPre")}
          <b>{collections.length}</b>
          {t("mongo.emptyDbBodyPost")}
        </p>
        {collections.length > 0 ? (
          <pre className="truncate-sql">
            {collections.map((c) => "db." + c + ".drop()").join("\n")}
          </pre>
        ) : (
          <p>
            <b>{db}</b>
            {t("mongo.emptyDbNone")}
          </p>
        )}
        <ConfirmName name={db} env={env} typed={typed} onTyped={setTyped} inputRef={nameRef} />
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
          <span>{busy ? t("mongo.emptying") : t("mongo.emptyAllBtn")}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
