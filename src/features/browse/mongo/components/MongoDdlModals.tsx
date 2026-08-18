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
  if (n.startsWith("system.")) return "Names starting with “system.” are reserved by MongoDB.";
  if (n.includes("$")) return "A collection name cannot contain “$”.";
  if (n.includes("\0")) return "A collection name cannot contain a null character.";
  // The server's limit is on the full namespace; 200 leaves room for the
  // database name and the dot without guessing at the exact budget.
  if (new Blob([n]).size > 200) return "That name is too long.";
  if (existing.includes(n)) return "A collection called “" + n + "” already exists.";
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
  if (/[/\\. "$*<>:|?]/.test(n))
    return 'A database name cannot contain / \\ . " $ * < > : | ? or a space.';
  if (n.includes("\0")) return "A database name cannot contain a null character.";
  if (new Blob([n]).size > 63) return "A database name is limited to 63 bytes.";
  // MongoDB compares database names case-insensitively on most deployments, so
  // a name differing only in case would be refused by the server.
  const clash = existing.find((e) => e.toLowerCase() === n.toLowerCase());
  if (clash) return "A database called “" + clash + "” already exists.";
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
        toast("Created collection “" + coll + "”", "ok");
        onCreated(coll);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not create the collection."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Create collection"
      width={460}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="create_new_folder" size={18} style={{ color: "var(--accent)" }} /> Create
        collection
      </ModalTitle>
      <div className="truncate-body">
        <p>
          A new, empty collection in <code>{db}</code>. MongoDB would also create one on the first
          insert — do it here when you want to import into it, or index it, before any documents
          exist.
        </p>
        <div className="truncate-prod">
          <label>
            Collection name
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              placeholder="events"
              spellCheck="false"
              aria-label="Collection name"
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
          Cancel
        </Btn>
        <Btn icon="add" variant="filled" disabled={!armed} onClick={confirm}>
          {busy ? "Creating…" : "Create collection"}
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
        toast("Created database “" + dbName + "” with “" + collName + "”", "ok");
        onCreated(dbName, collName);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not create the database."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Create database"
      width={460}
      className="truncate-modal"
      initialFocusRef={dbRef}
    >
      <ModalTitle>
        <Icon name="create_new_folder" size={18} style={{ color: "var(--accent)" }} /> Create
        database
      </ModalTitle>
      <div className="truncate-body">
        <p>
          MongoDB creates a database the moment something is written to it — there is no empty
          database to make. Name a first collection and both are created together.
        </p>
        <div className="truncate-prod">
          <label>
            Database name
            <input
              ref={dbRef}
              value={db}
              onChange={(e) => setDb(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              placeholder="analytics"
              spellCheck="false"
              aria-label="Database name"
            />
          </label>
          <label>
            First collection
            <input
              value={coll}
              onChange={(e) => setColl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirm();
              }}
              placeholder="events"
              spellCheck="false"
              aria-label="First collection name"
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
          Cancel
        </Btn>
        <Btn icon="add" variant="filled" disabled={!armed} onClick={confirm}>
          {busy ? "Creating…" : "Create database"}
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
        toast(
          "Emptied “" +
            coll +
            "” — " +
            removed.toLocaleString() +
            " document" +
            (removed === 1 ? "" : "s") +
            " removed",
          "ok",
        );
        onTruncated(coll);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not empty the collection."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Empty collection"
      width={480}
      className="truncate-modal"
      initialFocusRef={isProd ? nameRef : cancelRef}
    >
      <ModalTitle>
        <Icon name="delete_sweep" size={18} style={{ color: DANGER }} /> Empty collection
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This removes <b>every document</b>
          {count !== null && count !== undefined ? (
            <>
              {" "}
              — <b>{count.toLocaleString()}</b> of them
            </>
          ) : null}{" "}
          from <code>{coll}</code>. The collection, its indexes and its validator stay.
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
          Cancel
        </Btn>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={confirm}>
          <Icon name="delete_sweep" size={16} />
          <span>{busy ? "Emptying…" : "Empty collection"}</span>
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
        toast("Dropped collection “" + coll + "”", "ok");
        onDropped(coll);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not drop the collection."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Drop collection"
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="delete_forever" size={18} style={{ color: DANGER }} /> Drop collection
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This deletes <code>{coll}</code> from <code>{db}</code> — its documents, its indexes and
          its validator. There is nothing to roll back.
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
          Cancel
        </Btn>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={confirm}>
          <Icon name="delete_forever" size={16} />
          <span>{busy ? "Dropping…" : "Drop collection"}</span>
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
        toast("Dropped database “" + db + "”", "ok");
        onDropped(db);
        onClose();
      } catch (err) {
        setError(appErrorMessage(err, "Could not drop the database."));
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Drop database"
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="delete_forever" size={18} style={{ color: DANGER }} /> Drop database
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This deletes <code>{db}</code> and everything in it —{" "}
          <b>
            {collections.length} collection{collections.length === 1 ? "" : "s"}
          </b>
          , their documents, indexes and validators. The database is gone, not emptied, and there is
          nothing to roll back.
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
          Cancel
        </Btn>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={confirm}>
          <Icon name="delete_forever" size={16} />
          <span>{busy ? "Dropping…" : "Drop database"}</span>
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
        toast(
          "Emptied “" +
            db +
            "” — dropped " +
            dropped.length +
            " collection" +
            (dropped.length === 1 ? "" : "s"),
          "ok",
        );
        onEmptied();
        onClose();
      } catch (err) {
        // The backend stops at the first refusal, so some collections may
        // already be gone; the caller refreshes either way.
        setError(appErrorMessage(err, "Could not empty the database."));
        onEmptied();
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      onClose={onClose}
      label="Empty database"
      width={480}
      className="truncate-modal"
      initialFocusRef={nameRef}
    >
      <ModalTitle>
        <Icon name="delete_forever" size={18} style={{ color: DANGER }} /> Empty database
      </ModalTitle>
      <div className="truncate-body">
        <p>
          This drops <b>every collection</b> in <code>{db}</code> — all <b>{collections.length}</b>{" "}
          of them, with their documents, indexes and validators. The database itself stays, so you
          can rebuild into it.
        </p>
        {collections.length > 0 ? (
          <pre className="truncate-sql">
            {collections.map((c) => "db." + c + ".drop()").join("\n")}
          </pre>
        ) : (
          <p>
            <b>{db}</b> has no collections — there is nothing to drop.
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
          Cancel
        </Btn>
        <button type="button" className="btn btn-danger" disabled={!armed} onClick={confirm}>
          <Icon name="delete_forever" size={16} />
          <span>{busy ? "Emptying…" : "Drop all collections"}</span>
        </button>
      </ModalActions>
    </Modal>
  );
}
