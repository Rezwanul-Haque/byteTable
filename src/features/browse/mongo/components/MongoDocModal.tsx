// MongoDB JSON document editor modal (M18 §18.3). Edits a document as JSON with
// ObjectId("…") / ISODate("…") preserved through the `{$oid}`/`{$date}` tags,
// shows live parse-error + $jsonSchema validation feedback, and saves via
// replaceOne (or insertOne for a new doc) behind the writer port. Delete is an
// explicit action (production-env confirm). Ported from the prototype's
// MongoDocModal.

import { useRef, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Modal } from "../../../../shared/ui/Modal";
import { useToast } from "../../../../shared/ui/toastContext";
import { mongoDeleteOne, mongoInsertOne, mongoReplaceOne, type MongoDoc } from "../api";
import { highlightMongoJson, mongoParse, mongoStringify, validateAgainstSchema } from "../helpers";
import "../../shared/CellEditors.css"; // .jx-* token colours

export function MongoDocModal({
  doc,
  db,
  coll,
  handleId,
  validator,
  isNew,
  isProduction,
  onClose,
  onSaved,
}: {
  doc: MongoDoc;
  db: string;
  coll: string;
  handleId: string;
  validator?: unknown;
  isNew?: boolean;
  isProduction?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState(() => mongoStringify(doc));
  const [dirty, setDirty] = useState(!!isNew);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);

  // The highlight layer must scroll with the textarea or the colours slide off
  // the characters they belong to.
  const syncScroll = () => {
    if (taRef.current && hlRef.current) {
      hlRef.current.scrollTop = taRef.current.scrollTop;
      hlRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  let parsed: MongoDoc | null = null;
  let error: string | null = null;
  try {
    parsed = mongoParse(text);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const validationErr = parsed ? validateAgainstSchema(parsed, validator) : null;

  const save = async () => {
    if (error || !parsed) {
      toast("Invalid document JSON", "err");
      return;
    }
    if (validationErr) {
      toast("Schema validation failed: " + validationErr, "err");
      return;
    }
    setBusy(true);
    try {
      if (isNew) {
        await mongoInsertOne(handleId, db, coll, parsed);
        toast("Inserted into " + db + "." + coll, "ok");
      } else {
        await mongoReplaceOne(handleId, db, coll, doc._id, parsed);
        toast("Saved " + db + "." + coll, "ok");
      }
      onSaved();
      onClose();
    } catch (e) {
      toast(appErrorMessage(e, "Could not save document"), "err");
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (isProduction && !window.confirm("Delete this document from production " + coll + "?")) {
      return;
    }
    setBusy(true);
    try {
      await mongoDeleteOne(handleId, db, coll, doc._id);
      toast("Document deleted · " + db + "." + coll, "ok");
      onSaved();
      onClose();
    } catch (e) {
      toast(appErrorMessage(e, "Could not delete document"), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} className="json-modal mg-doc-modal">
      <div className="modal-title">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="data_object" size={17} style={{ color: "var(--accent)" }} />{" "}
          {isNew ? "Insert document" : "Edit document"}
          <span className="json-type-tag">
            {db}.{coll}
          </span>
          {validator ? (
            <span className="mg-validated">
              <Icon name="verified" size={12} /> validated
            </span>
          ) : null}
          {dirty ? <span className="ddb-edit-dot" title="Unsaved changes" /> : null}
        </span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </div>
      {/* Transparent-text textarea over a <pre> highlight layer, their scroll
          positions kept in sync — the same shape as the shared JsonField, but
          with a Mongo tokenizer so ObjectId("…") / ISODate("…") colour too. */}
      <div className="mg-doc-code">
        <pre
          className="mg-doc-hl"
          ref={hlRef}
          aria-hidden="true"
          // `highlightMongoJson` escapes &, < and > itself, so the only markup
          // here is its own token spans.
          dangerouslySetInnerHTML={{ __html: highlightMongoJson(text) + "\n" }}
        />
        <textarea
          ref={taRef}
          className="mg-doc-editor"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label={isNew ? "New document JSON" : "Document JSON"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          onScroll={syncScroll}
        />
      </div>
      <div className="mg-doc-status">
        {error ? (
          <span className="mg-doc-err">
            <Icon name="error" size={13} /> {error}
          </span>
        ) : validationErr ? (
          <span className="mg-doc-err">
            <Icon name="gpp_bad" size={13} /> {validationErr}
          </span>
        ) : (
          <span className="mg-doc-ok">
            <Icon name="check_circle" size={13} /> valid {validator ? "· passes schema" : "JSON"}
          </span>
        )}
        <span className="mg-doc-hint">ObjectId("…") and ISODate("…") are preserved</span>
      </div>
      <div className="modal-actions ddb-item-actions">
        {!isNew ? (
          <Btn variant="text" small icon="delete" onClick={() => void del()} className="mg-del-btn">
            Delete
          </Btn>
        ) : null}
        <div style={{ flex: 1 }} />
        <Btn variant="text" small onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          icon="save"
          variant="filled"
          small
          disabled={!dirty || !!error || !!validationErr || busy}
          onClick={() => void save()}
        >
          {isNew ? "Insert" : "Save changes"}
        </Btn>
      </div>
    </Modal>
  );
}
