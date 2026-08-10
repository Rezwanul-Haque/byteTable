// Typesense documents tab + drawer (M30 Task 7, ported from typesense.jsx
// TsDocsTab / TsDocDrawer): a table of up to 8 columns (`id` + fields, `_at`
// int64 columns rendered as dates), a row click opening a raw-JSON drawer with
// Upsert and Delete.
//
// Deviation from the prototype, necessarily: the prototype holds every document
// in memory and scans them all client-side. Real collections do not fit in
// memory, so documents are paged from the server (a match-all search) and the
// scan box filters the LOADED page. The input says so rather than implying it
// searched the index — that is what the Search playground is for.

import { useCallback, useEffect, useMemo, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import {
  typesenseDeleteDocument,
  typesenseDocuments,
  typesenseUpsertDocument,
  type CollectionDescriptor,
} from "../api";
import { isTimestampColumn, tsCount, tsDate, tsFmt } from "../format";
import { TsError, TsLoading } from "./TsBits";

/** Max columns rendered in the table (prototype: `id` + fields, sliced to 8). */
const MAX_COLUMNS = 8;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

type Doc = Record<string, unknown>;

interface TsDocsTabProps {
  handleId: string;
  collection: CollectionDescriptor | null;
  /** Bumped by the workspace to force a reload (refresh, or a write elsewhere). */
  reloadKey: number;
  /** Called after a write so the sidebar/dashboard counts refresh. */
  onChanged: () => void;
}

export function TsDocsTab({ handleId, collection, reloadKey, onChanged }: TsDocsTabProps) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Doc | null>(null);
  const [q, setQ] = useState("");

  const name = collection?.name ?? "";

  const load = useCallback(async () => {
    if (!name) {
      setDocs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await typesenseDocuments(handleId, name, page, perPage);
      setDocs(result.documents);
      setTotal(result.total);
    } catch (e) {
      setError(isAppErrorPayload(e) ? e.message : "Could not load documents.");
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [handleId, name, page, perPage]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Reset to the first page when the collection changes — page 7 of the previous
  // collection is meaningless here.
  useEffect(() => {
    setPage(1);
    setSelected(null);
    setQ("");
  }, [name]);

  // Clamp the page when the total shrinks under it (e.g. after deletes).
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const columns = useMemo(() => {
    if (!collection) return [];
    const names = ["id", ...collection.fields.map((f) => f.name).filter((n) => n !== "id")];
    return names.slice(0, MAX_COLUMNS);
  }, [collection]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return docs;
    return docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
  }, [docs, q]);

  if (!collection) {
    return (
      <div className="ts-empty">
        <Icon name="data_object" size={26} style={{ color: "var(--text-faint)" }} />
        <p>No collection selected.</p>
        <span className="ts-empty-hint">Pick a collection in the sidebar to browse documents.</span>
      </div>
    );
  }

  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);

  return (
    <div className="ts-docs" data-screen-label={"Typesense documents: " + collection.name}>
      <div className="ts-docs-head">
        <Icon name="data_object" size={16} style={{ color: "var(--accent)" }} />
        <h2>{collection.name}</h2>
        <span className="structure-sub">
          {q.trim() ? tsCount(shown.length) + " of " : ""}
          {tsCount(docs.length)} loaded · {tsCount(total)} documents
        </span>
        <div className="ts-docs-search">
          <Icon name="search" size={14} style={{ color: "var(--text-faint)" }} />
          <input
            placeholder="Filter loaded documents…"
            title="Filters the documents on this page. Use the Search playground to query the index."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="ts-docs-body">
        {error ? (
          <TsError message={error} />
        ) : loading && docs.length === 0 ? (
          <TsLoading what="documents" />
        ) : shown.length === 0 ? (
          <div className="ts-facet-none">
            {docs.length === 0
              ? "this collection has no documents"
              : "nothing on this page matches"}
          </div>
        ) : (
          <table className="structure-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                {columns.map((k) => (
                  <th key={k}>{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((d, i) => {
                const id = typeof d.id === "string" ? d.id : String(i);
                return (
                  <tr
                    key={id}
                    className={selected && selected.id === d.id ? "ts-row-sel" : ""}
                    onClick={() => setSelected(d)}
                  >
                    {columns.map((k) => (
                      <td key={k} className={typeof d[k] === "number" ? "cass-dash-num" : ""}>
                        {isTimestampColumn(k, d[k]) ? tsDate(d[k] as number) : tsFmt(d[k])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="table-footer">
        <span className="table-hint">
          Click a row to edit its JSON · upsert replaces the whole document by <code>id</code>
        </span>
        <div className="pager">
          <span className="pager-label" id="ts-docs-pager-label">
            Documents per page
          </span>
          <Select
            className="pager-size"
            placement="up"
            aria-labelledby="ts-docs-pager-label"
            value={String(perPage)}
            options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => {
              setPerPage(Number(v));
              setPage(1);
            }}
          />
          <span className="pager-range">
            {tsCount(from)}–{tsCount(to)} of {tsCount(total)} · Page {page} of {pageCount}
          </span>
          <IconBtn
            icon="chevron_left"
            title="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          />
          <IconBtn
            icon="chevron_right"
            title="Next page"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          />
        </div>
      </div>

      {selected ? (
        <TsDocDrawer
          handleId={handleId}
          collection={collection.name}
          doc={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            void load();
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function TsDocDrawer({
  handleId,
  collection,
  doc,
  onClose,
  onChanged,
}: {
  handleId: string;
  collection: string;
  doc: Doc;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState(() => JSON.stringify(doc, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = typeof doc.id === "string" ? doc.id : "";

  // Re-seed when a different row is picked while the drawer is open.
  useEffect(() => {
    setText(JSON.stringify(doc, null, 2));
    setError(null);
  }, [doc]);

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // A parse failure changes nothing — no request is sent.
      setError(e instanceof Error ? e.message : "That is not valid JSON.");
      return;
    }
    setBusy(true);
    try {
      await typesenseUpsertDocument(handleId, collection, parsed);
      const savedId = typeof (parsed as Doc)?.id === "string" ? ((parsed as Doc).id as string) : id;
      toast("Document " + savedId + " upserted", "ok");
      setError(null);
      onChanged();
      onClose();
    } catch (e) {
      setError(isAppErrorPayload(e) ? e.message : "The upsert failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await typesenseDeleteDocument(handleId, collection, id);
      toast("Deleted " + id, "ok");
      onChanged();
      onClose();
    } catch (e) {
      setError(isAppErrorPayload(e) ? e.message : "The delete failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ts-drawer">
      <div className="ts-drawer-head">
        <Icon name="data_object" size={15} style={{ color: "var(--accent)" }} />
        <span className="ts-drawer-id">
          {collection} / {id || "(no id)"}
        </span>
        <div style={{ flex: 1 }} />
        <IconBtn icon="close" title="Close" onClick={onClose} size={15} />
      </div>
      <textarea
        className="ts-drawer-json"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      {error ? (
        <div className="ts-drawer-err">
          <Icon name="error" size={14} /> {error}
        </div>
      ) : null}
      <div className="ts-drawer-foot">
        <button
          type="button"
          className="btn btn-danger-text"
          onClick={() => void remove()}
          disabled={busy || !id}
          title={id ? "Delete this document" : "This document has no id to delete by"}
        >
          <Icon name="delete" size={14} /> Delete
        </button>
        <div style={{ flex: 1 }} />
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="filled" icon="save" onClick={() => void save()} disabled={busy}>
          Upsert
        </Btn>
      </div>
    </div>
  );
}
