// Redis key tab — type-aware Value/Info viewers + inline editing + key ops
// (REDIS_SPEC §6). Ported from the prototype `redis-tabs.jsx` (StringViewer /
// KeyValueViewer / KeyInfoPanel) and `redis.jsx` (RedisKeyTab toolbar). Unlike
// the SQL DataGrid (which pages a table from the backend), a Redis value is an
// in-memory array fetched once via `kvGetKey`; the grids here mirror
// SqlResultGrid's DOM + reuse the shared `CellContent` for cell visuals, with
// the M11 inline-edit pattern (.cell-input / .cell-editing) for editable cells.
//
// Data flow: fetch on mount + whenever the workspace `version` nonce changes
// (a write here, or the sidebar's "refresh keyspace", bumps it — REDIS_SPEC
// §7). Every mutation issues the real kv* command, toasts, and bumps the
// version so the sidebar + this tab re-fetch. Destructive Delete on a
// production connection confirms first (the M11 confirm-modal pattern).

import { useCallback, useEffect, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { CellContent } from "../../browse/shared/GridCell";
import { highlightJSON } from "../../browse/shared/jsonCell";
import {
  kvDeleteKey,
  kvExpire,
  kvGetKey,
  kvHashDel,
  kvHashSet,
  kvListSet,
  kvPersist,
  kvSetAdd,
  kvSetRemove,
  kvSetString,
  kvZsetAdd,
  type KeyType,
  type KeyView,
  type KvValue,
} from "../api";
import { humanBytes, humanTTL, REDIS_TYPES } from "../helpers";
import { RedisTypeBadge } from "./RedisTypeBadge";
import "./KeyTab.css";

interface KeyTabProps {
  handleId: string;
  db: number;
  keyName: string;
  /** The tab's badge type (the fetched `view.keyType` is the live source). */
  keyType: KeyType;
  /** Invalidation nonce — re-fetch when it changes (write or manual refresh). */
  version: number;
  /** True when the connection's env is `production` (gate destructive ops). */
  isProduction: boolean;
  /** Bump the workspace version after a write (sidebar + tabs re-fetch). */
  onMutated: () => void;
  /** Close this tab (after a successful DEL). */
  onClose: () => void;
  /**
   * Report the loaded key's type + memory to the status bar (REDIS_SPEC §9).
   * Optional so the standalone key tab still works without a host.
   */
  onMeta?: (meta: { keyType: KeyType; memory: number | null }) => void;
}

/** Number of elements a value holds (string → byte length; else item count). */
function elementCount(value: KvValue): number {
  switch (value.type) {
    case "str":
      return value.value.length;
    case "list":
      return value.items.length;
    case "set":
      return value.members.length;
    case "hash":
      return value.fields.length;
    case "zset":
      return value.entries.length;
    case "stream":
      return value.entries.length;
    case "missing":
      return 0;
  }
}

export function KeyTab({
  handleId,
  db,
  keyName,
  version,
  isProduction,
  onMutated,
  onClose,
  onMeta,
}: KeyTabProps) {
  const toast = useToast();
  // Keep the latest onMeta in a ref so reporting it never re-creates `load`
  // (which would re-fetch the key on every parent render).
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;
  const [mode, setMode] = useState<"value" | "info">("value");
  const [view, setView] = useState<KeyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch the typed view (mount + whenever `version` changes — REDIS_SPEC §7).
  // The work lives in a callback (not the effect body) so the loading flag is
  // not flipped synchronously inside the effect — same shape as the sidebar.
  const load = useCallback(
    async (signal: { live: boolean }) => {
      setLoading(true);
      try {
        const v = await kvGetKey(handleId, db, keyName);
        if (!signal.live) return;
        setView(v);
        setError(null);
        // Report type + memory to the status bar (REDIS_SPEC §9).
        if (v.value.type !== "missing")
          onMetaRef.current?.({ keyType: v.keyType, memory: v.memory });
      } catch (err) {
        if (!signal.live) return;
        setError(appErrorMessage(err, "Could not load this key."));
      } finally {
        if (signal.live) setLoading(false);
      }
    },
    [handleId, db, keyName],
  );

  useEffect(() => {
    const signal = { live: true };
    void load(signal);
    return () => {
      signal.live = false;
    };
    // `version` is the write / refresh nonce — re-fetch when it bumps.
  }, [load, version]);

  // After any successful write, bump the workspace version → triggers the
  // effect above (re-fetch) and re-scans the sidebar.
  const mutated = useCallback(() => onMutated(), [onMutated]);

  if (loading && !view) {
    return (
      <div className="rkey-state">
        <span className="spinner" /> Loading key…
      </div>
    );
  }
  if (error !== null && !view) {
    return <div className="rkey-state rkey-state-error">{error}</div>;
  }
  if (!view || view.value.type === "missing") {
    return (
      <div className="rkey-state">
        <p>
          Key <code>{keyName}</code> no longer exists — it may have been deleted or expired.
        </p>
        <Btn variant="tonal" small icon="close" onClick={onClose}>
          Close tab
        </Btn>
      </div>
    );
  }

  const count = elementCount(view.value);
  const sizeReadout = view.keyType === "string" ? count + " bytes" : count + " items";

  return (
    <div className="rkey-tab" data-screen-label={"Redis key: " + keyName}>
      <div className="rkey-toolbar">
        <div className="seg" role="tablist" aria-label="Key view mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "value"}
            className={"seg-btn" + (mode === "value" ? " active" : "")}
            onClick={() => setMode("value")}
          >
            <RedisTypeBadge type={view.keyType} size={13} /> Value
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "info"}
            className={"seg-btn" + (mode === "info" ? " active" : "")}
            onClick={() => setMode("info")}
          >
            <Icon name="info" size={14} /> Info
          </button>
        </div>
        <code className="rkey-tab-name">{keyName}</code>
        <IconBtn
          icon="content_copy"
          size={13}
          title="Copy key name"
          onClick={() => {
            void navigator.clipboard.writeText(keyName).then(
              () => toast("Key name copied", "ok"),
              () => toast("Couldn't copy to clipboard", "err"),
            );
          }}
        />
        <span className={"rkey-ttl" + (view.ttl >= 0 ? " live" : "")} title="TTL">
          {humanTTL(view.ttl)}
        </span>
        <div className="rkey-toolbar-spacer" />
        <span className="rkey-size">{sizeReadout}</span>
      </div>

      {mode === "value" ? (
        <ValueViewer
          handleId={handleId}
          db={db}
          keyName={keyName}
          view={view}
          toast={toast}
          onMutated={mutated}
        />
      ) : (
        <InfoPanel
          handleId={handleId}
          db={db}
          keyName={keyName}
          view={view}
          count={count}
          isProduction={isProduction}
          toast={toast}
          onMutated={mutated}
          onClose={onClose}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Value mode — one viewer per type
// ---------------------------------------------------------------------------

type ToastFn = ReturnType<typeof useToast>;

interface ViewerProps {
  handleId: string;
  db: number;
  keyName: string;
  view: KeyView;
  toast: ToastFn;
  onMutated: () => void;
}

function ValueViewer({ handleId, db, keyName, view, toast, onMutated }: ViewerProps) {
  const v = view.value;
  switch (v.type) {
    case "str":
      return (
        <StringViewer
          handleId={handleId}
          db={db}
          keyName={keyName}
          value={v.value}
          toast={toast}
          onMutated={onMutated}
        />
      );
    case "hash":
      return (
        <HashViewer
          handleId={handleId}
          db={db}
          keyName={keyName}
          fields={v.fields}
          toast={toast}
          onMutated={onMutated}
        />
      );
    case "list":
      return (
        <ListViewer
          handleId={handleId}
          db={db}
          keyName={keyName}
          items={v.items}
          toast={toast}
          onMutated={onMutated}
        />
      );
    case "set":
      return (
        <SetViewer
          handleId={handleId}
          db={db}
          keyName={keyName}
          members={v.members}
          toast={toast}
          onMutated={onMutated}
        />
      );
    case "zset":
      return (
        <ZsetViewer
          handleId={handleId}
          db={db}
          keyName={keyName}
          entries={v.entries}
          toast={toast}
          onMutated={onMutated}
        />
      );
    case "stream":
      return <StreamViewer entries={v.entries} />;
    case "missing":
      return <div className="grid-empty">Key no longer exists.</div>;
  }
}

/** Whether a string parses as a JSON object/array (so we pretty-print it). */
function isJsonish(s: string): boolean {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function StringViewer({
  handleId,
  db,
  keyName,
  value,
  toast,
  onMutated,
}: {
  handleId: string;
  db: number;
  keyName: string;
  value: string;
  toast: ToastFn;
  onMutated: () => void;
}) {
  const json = isJsonish(value);
  const pretty = json ? JSON.stringify(JSON.parse(value), null, 2) : value;
  // Always editable: `draft` is the working copy (pretty-printed for JSON). A
  // Save/Discard bar appears only when it diverges from the stored value — the
  // SQL-grid staged-edit pattern, no Edit button.
  const [draft, setDraft] = useState(pretty);
  // Keep the highlight overlay scrolled in lock-step with the textarea.
  const hlRef = useRef<HTMLPreElement | null>(null);
  // Adopt the stored value when it changes externally (a refresh / another
  // writer) — but only while there is no unsaved edit, so the auto-refresh
  // timer can never clobber in-progress typing.
  const lastPrettyRef = useRef(pretty);
  useEffect(() => {
    setDraft((d) => (d === lastPrettyRef.current ? pretty : d));
    lastPrettyRef.current = pretty;
  }, [pretty]);

  const dirty = draft !== pretty;

  const save = async () => {
    try {
      // The editor shows pretty-printed JSON; store it compact (minified) again.
      // If the draft no longer parses as JSON, save it verbatim.
      let toStore = draft;
      if (isJsonish(draft)) {
        try {
          toStore = JSON.stringify(JSON.parse(draft));
        } catch {
          /* invalid mid-edit — store the raw draft */
        }
      }
      await kvSetString(handleId, db, keyName, toStore);
      toast("SET " + keyName + " — OK", "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, "SET failed."), "err");
    }
  };

  return (
    <div className="rstr">
      <div className="rstr-bar">
        <span className="rstr-meta">
          {json ? "JSON" : "string"} · {value.length} bytes
          {dirty ? <span className="rstr-unsaved"> · unsaved</span> : null}
        </span>
        <div className="rstr-bar-spacer" />
        <IconBtn
          icon="content_copy"
          size={14}
          title="Copy value"
          onClick={() => {
            void navigator.clipboard.writeText(draft).then(
              () => toast("Value copied", "ok"),
              () => toast("Couldn't copy to clipboard", "err"),
            );
          }}
        />
        {dirty ? (
          <>
            <Btn variant="text" small onClick={() => setDraft(pretty)}>
              Discard
            </Btn>
            <Btn variant="filled" icon="check" small onClick={save}>
              Save (SET)
            </Btn>
          </>
        ) : null}
      </div>
      {json ? (
        // Highlight-overlay editor (always on): a transparent textarea over a
        // highlighted <pre>, scroll-synced. Trailing newline keeps the last
        // line's height. highlightJSON HTML-escapes its input, so it is safe to
        // inject; .rstr-value .jx-* colors live in KeyTab.css.
        <div className="rstr-editwrap">
          <pre
            ref={hlRef}
            className="rstr-value rstr-edit-hl"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: highlightJSON(draft) + "\n" }}
          />
          <textarea
            className="rstr-edit rstr-edit-overlay"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onScroll={(e) => {
              if (hlRef.current) {
                hlRef.current.scrollTop = e.currentTarget.scrollTop;
                hlRef.current.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
            spellCheck={false}
            aria-label={"Edit value of " + keyName}
          />
        </div>
      ) : (
        <textarea
          className="rstr-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-label={"Edit value of " + keyName}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared in-memory grid (mirrors SqlResultGrid DOM + reuses CellContent /
// the M11 inline-edit .cell-input pattern). Values are small in-memory arrays
// (one key), so no virtualization is needed here.
// ---------------------------------------------------------------------------

interface GridColumn {
  /** Header label + the `column` passed to CellContent (drives cell visuals). */
  name: string;
  /** Whether double-click opens an inline editor on this column's cells. */
  editable?: boolean;
}

interface KeyGridProps {
  columns: GridColumn[];
  /** Row values, parallel to `columns`. */
  rows: (string | number)[][];
  /** Apply one staged edit: (rowIndex, columnIndex, draftText). May be async. */
  onEdit?: (rowIndex: number, colIndex: number, draft: string) => void | Promise<void>;
  empty: string;
}

function KeyGrid({ columns, rows, onEdit, empty }: KeyGridProps) {
  const [editing, setEditing] = useState<{ row: number; col: number; draft: string } | null>(null);
  // Staged edits keyed "row,col" — nothing is written until Save (the SQL-grid
  // pattern). Survives the auto-refresh re-fetch because it's local state.
  const [staged, setStaged] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select only when the *edited cell* changes (edit start). Depending
  // on the whole `editing` object would re-run on every keystroke and re-select
  // all text, so each new character would replace the selection.
  const editCell = editing ? editing.row + "," + editing.col : null;
  useEffect(() => {
    if (editCell !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editCell]);

  // Equal flexible tracks (fixed 90px min, no content-based sizing) so every
  // row shares identical column widths and the grid aligns — KeyGrid isn't
  // virtualized, so it can't use the SQL grid's measured fixed px tracks.
  const gridCols = "38px " + columns.map(() => "minmax(90px, 1fr)").join(" ");

  const cellKey = (r: number, c: number) => r + "," + c;
  const stagedOf = (r: number, c: number) => staged.get(cellKey(r, c));
  // The value to show: the staged edit when present, else the stored value.
  const shownValue = (r: number, c: number): string | number | null => {
    const s = stagedOf(r, c);
    return s !== undefined ? s : (rows[r]?.[c] ?? null);
  };

  const commit = () => {
    if (!editing) return;
    const { row, col, draft } = editing;
    setEditing(null);
    const orig = String(rows[row]?.[col] ?? "");
    setStaged((m) => {
      const n = new Map(m);
      if (draft === orig)
        n.delete(cellKey(row, col)); // back to original → un-stage
      else n.set(cellKey(row, col), draft);
      return n;
    });
  };

  const discard = () => setStaged(new Map());

  const saveAll = async () => {
    if (!onEdit || saving || staged.size === 0) return;
    setSaving(true);
    try {
      // Replay each staged cell through the per-type writer (HSET / LSET / …).
      for (const [k, v] of staged) {
        const parts = k.split(",");
        await onEdit(Number(parts[0]), Number(parts[1]), v);
      }
      setStaged(new Map());
    } finally {
      setSaving(false);
    }
  };

  if (rows.length === 0) {
    return <div className="grid-empty">{empty}</div>;
  }

  return (
    <div className="rkey-gridwrap">
      <div className="datagrid-wrap rkey-grid">
        <div className="dg-canvas" style={{ "--grid-cols": gridCols } as React.CSSProperties}>
          <div className="dg-header dg-row">
            <div className="dg-rownum-h">#</div>
            {columns.map((c) => (
              <div key={c.name} className="dg-th" title={c.name}>
                <span className="dg-head">
                  <span className="dg-colname">{c.name}</span>
                </span>
              </div>
            ))}
          </div>
          <div>
            {rows.map((_row, ri) => (
              <div key={ri} className="dg-tr dg-row">
                <div className="dg-rownum">{ri + 1}</div>
                {columns.map((c, ci) => {
                  const isEditing = editing?.row === ri && editing?.col === ci;
                  const cellValue = shownValue(ri, ci);
                  const isEdited = stagedOf(ri, ci) !== undefined;
                  return (
                    <div
                      key={c.name}
                      className={
                        "dg-td" +
                        (isEditing ? " cell-editing" : "") +
                        (isEdited ? " cell-edited" : "")
                      }
                      onDoubleClick={
                        c.editable && onEdit
                          ? () => setEditing({ row: ri, col: ci, draft: String(cellValue ?? "") })
                          : undefined
                      }
                      title={c.editable && onEdit ? "Double-click to edit" : undefined}
                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          className="cell-input"
                          aria-label={"Edit " + c.name}
                          value={editing.draft}
                          onChange={(e) =>
                            setEditing((prev) => (prev ? { ...prev, draft: e.target.value } : prev))
                          }
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commit();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditing(null);
                            }
                          }}
                        />
                      ) : (
                        <CellContent value={cellValue} column={c.name} />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      {staged.size > 0 ? (
        <div className="rkey-savebar">
          <span className="rkey-savebar-msg">
            {staged.size} cell{staged.size === 1 ? "" : "s"} edited · unsaved
          </span>
          <div style={{ flex: 1 }} />
          <Btn variant="text" small disabled={saving} onClick={discard}>
            Discard
          </Btn>
          <Btn variant="filled" icon="check" small disabled={saving} onClick={() => void saveAll()}>
            Save
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

function HashViewer({
  handleId,
  db,
  keyName,
  fields,
  toast,
  onMutated,
}: {
  handleId: string;
  db: number;
  keyName: string;
  fields: { field: string; value: string }[];
  toast: ToastFn;
  onMutated: () => void;
}) {
  const rows = fields.map((f) => [f.field, f.value]);
  const onEdit = async (ri: number, ci: number, draft: string) => {
    const row = fields[ri];
    if (!row) return;
    try {
      if (ci === 1) {
        // Edit value → HSET key field value.
        await kvHashSet(handleId, db, keyName, row.field, draft);
        toast("HSET " + keyName + " " + row.field + " — OK", "ok");
      } else {
        // Edit field → HDEL old + HSET new (carry the value over).
        await kvHashDel(handleId, db, keyName, row.field);
        await kvHashSet(handleId, db, keyName, draft, row.value);
        toast("HDEL " + row.field + " + HSET " + draft + " — OK", "ok");
      }
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, "Hash update failed."), "err");
    }
  };
  return (
    <KeyGrid
      columns={[
        { name: "field", editable: true },
        { name: "value", editable: true },
      ]}
      rows={rows}
      onEdit={onEdit}
      empty="empty hash"
    />
  );
}

function ListViewer({
  handleId,
  db,
  keyName,
  items,
  toast,
  onMutated,
}: {
  handleId: string;
  db: number;
  keyName: string;
  items: string[];
  toast: ToastFn;
  onMutated: () => void;
}) {
  const rows = items.map((v, i) => [i, v]);
  const onEdit = async (ri: number, _ci: number, draft: string) => {
    try {
      await kvListSet(handleId, db, keyName, ri, draft);
      toast("LSET " + keyName + " " + ri + " — OK", "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, "LSET failed."), "err");
    }
  };
  return (
    <KeyGrid
      columns={[{ name: "index" }, { name: "value", editable: true }]}
      rows={rows}
      onEdit={onEdit}
      empty="empty list"
    />
  );
}

function SetViewer({
  handleId,
  db,
  keyName,
  members,
  toast,
  onMutated,
}: {
  handleId: string;
  db: number;
  keyName: string;
  members: string[];
  toast: ToastFn;
  onMutated: () => void;
}) {
  const [adding, setAdding] = useState("");
  const rows = members.map((m) => [m]);

  // Edit a member = SREM old + SADD new (a set has no in-place update).
  const onEdit = async (ri: number, _ci: number, draft: string) => {
    const old = members[ri];
    if (old === undefined) return;
    try {
      await kvSetRemove(handleId, db, keyName, old);
      await kvSetAdd(handleId, db, keyName, draft);
      toast("SREM " + old + " + SADD " + draft + " — OK", "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, "Set update failed."), "err");
    }
  };

  const add = async () => {
    const m = adding.trim();
    if (!m) return;
    try {
      await kvSetAdd(handleId, db, keyName, m);
      setAdding("");
      toast("SADD " + keyName + " " + m + " — OK", "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, "SADD failed."), "err");
    }
  };

  const remove = async (member: string) => {
    try {
      await kvSetRemove(handleId, db, keyName, member);
      toast("SREM " + keyName + " " + member + " — OK", "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, "SREM failed."), "err");
    }
  };

  return (
    <div className="rset">
      <div className="rset-add">
        <input
          className="rinfo-ttl-input rset-add-input"
          placeholder="new member"
          value={adding}
          spellCheck={false}
          aria-label={"Add member to " + keyName}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <Btn variant="tonal" icon="add" small onClick={add}>
          Add (SADD)
        </Btn>
      </div>
      <SetGrid members={members} rows={rows} onEdit={onEdit} onRemove={remove} />
    </div>
  );
}

/** Set grid: the shared grid plus a trailing remove button per row. */
function SetGrid({
  members,
  rows,
  onEdit,
  onRemove,
}: {
  members: string[];
  rows: (string | number)[][];
  onEdit: (ri: number, ci: number, draft: string) => void | Promise<void>;
  onRemove: (member: string) => void;
}) {
  const [editing, setEditing] = useState<{ row: number; draft: string } | null>(null);
  // Staged member edits keyed by row index — nothing written until Save.
  const [staged, setStaged] = useState<Map<number, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select on edit start only (see KeyGrid) — not on every keystroke.
  const editRow = editing ? editing.row : null;
  useEffect(() => {
    if (editRow !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editRow]);

  const shownMember = (ri: number) => staged.get(ri) ?? members[ri] ?? "";

  const commit = () => {
    if (!editing) return;
    const { row, draft } = editing;
    setEditing(null);
    const orig = String(members[row] ?? "");
    setStaged((m) => {
      const n = new Map(m);
      if (draft === orig) n.delete(row);
      else n.set(row, draft);
      return n;
    });
  };

  const discard = () => setStaged(new Map());

  const saveAll = async () => {
    if (saving || staged.size === 0) return;
    setSaving(true);
    try {
      for (const [ri, v] of staged) await onEdit(ri, 0, v);
      setStaged(new Map());
    } finally {
      setSaving(false);
    }
  };

  if (rows.length === 0) return <div className="grid-empty">empty set</div>;

  return (
    <div className="rkey-gridwrap">
      <div className="datagrid-wrap rkey-grid">
        <div
          className="dg-canvas"
          style={{ "--grid-cols": "38px minmax(90px, 1fr) 36px" } as React.CSSProperties}
        >
          <div className="dg-header dg-row">
            <div className="dg-rownum-h">#</div>
            <div className="dg-th" title="member">
              <span className="dg-head">
                <span className="dg-colname">member</span>
              </span>
            </div>
            <div className="dg-th" />
          </div>
          <div>
            {members.map((m, ri) => {
              const isEditing = editing?.row === ri;
              const shown = shownMember(ri);
              const isEdited = staged.has(ri);
              return (
                <div key={ri} className="dg-tr dg-row">
                  <div className="dg-rownum">{ri + 1}</div>
                  <div
                    className={
                      "dg-td" +
                      (isEditing ? " cell-editing" : "") +
                      (isEdited ? " cell-edited" : "")
                    }
                    onDoubleClick={() => setEditing({ row: ri, draft: shown })}
                    title="Double-click to edit"
                  >
                    {isEditing ? (
                      <input
                        ref={inputRef}
                        className="cell-input"
                        aria-label="Edit member"
                        value={editing.draft}
                        onChange={(e) =>
                          setEditing((prev) => (prev ? { ...prev, draft: e.target.value } : prev))
                        }
                        onBlur={commit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commit();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                          }
                        }}
                      />
                    ) : (
                      <CellContent value={shown} column="member" />
                    )}
                  </div>
                  <div className="dg-td rset-remove-cell">
                    <IconBtn
                      icon="close"
                      size={14}
                      title={"Remove " + m}
                      onClick={() => onRemove(m)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {staged.size > 0 ? (
        <div className="rkey-savebar">
          <span className="rkey-savebar-msg">
            {staged.size} member{staged.size === 1 ? "" : "s"} edited · unsaved
          </span>
          <div style={{ flex: 1 }} />
          <Btn variant="text" small disabled={saving} onClick={discard}>
            Discard
          </Btn>
          <Btn variant="filled" icon="check" small disabled={saving} onClick={() => void saveAll()}>
            Save
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

function ZsetViewer({
  handleId,
  db,
  keyName,
  entries,
  toast,
  onMutated,
}: {
  handleId: string;
  db: number;
  keyName: string;
  entries: { member: string; score: number }[];
  toast: ToastFn;
  onMutated: () => void;
}) {
  // Sorted by score (REDIS_SPEC §6); rank is the sorted index, read-only.
  const sorted = entries.slice().sort((a, b) => a.score - b.score);
  const rows = sorted.map((e, i) => [i, e.member, e.score]);

  const onEdit = async (ri: number, ci: number, draft: string) => {
    if (ci !== 2) return; // only the score column is editable
    const entry = sorted[ri];
    if (!entry) return;
    const score = Number(draft);
    if (Number.isNaN(score)) {
      toast("Score must be a number.", "err");
      return;
    }
    try {
      await kvZsetAdd(handleId, db, keyName, entry.member, score);
      toast("ZADD " + keyName + " " + score + " " + entry.member + " — OK", "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, "ZADD failed."), "err");
    }
  };

  return (
    <KeyGrid
      columns={[{ name: "rank" }, { name: "member" }, { name: "score", editable: true }]}
      rows={rows}
      onEdit={onEdit}
      empty="empty zset"
    />
  );
}

function StreamViewer({
  entries,
}: {
  entries: { id: string; fields: { field: string; value: string }[] }[];
}) {
  const rows = entries.map((e) => [e.id, e.fields.map((f) => f.field + "=" + f.value).join("  ")]);
  return (
    <KeyGrid columns={[{ name: "id" }, { name: "fields" }]} rows={rows} empty="empty stream" />
  );
}

// ---------------------------------------------------------------------------
// Info mode — key metadata + quick actions (REDIS_SPEC §6)
// ---------------------------------------------------------------------------

function InfoPanel({
  handleId,
  db,
  keyName,
  view,
  count,
  isProduction,
  toast,
  onMutated,
  onClose,
}: {
  handleId: string;
  db: number;
  keyName: string;
  view: KeyView;
  count: number;
  isProduction: boolean;
  toast: ToastFn;
  onMutated: () => void;
  onClose: () => void;
}) {
  const [ttlDraft, setTtlDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = REDIS_TYPES[view.keyType];

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(keyName);
      toast("Key copied", "info");
    } catch {
      toast("Could not copy key.", "err");
    }
  };

  const setTtl = async () => {
    const seconds = parseInt(ttlDraft, 10);
    if (Number.isNaN(seconds)) {
      toast("TTL must be a number of seconds.", "err");
      return;
    }
    try {
      await kvExpire(handleId, db, keyName, seconds);
      setTtlDraft("");
      toast("EXPIRE " + keyName + " " + seconds + " — OK", "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, "EXPIRE failed."), "err");
    }
  };

  const persist = async () => {
    try {
      await kvPersist(handleId, db, keyName);
      toast("PERSIST " + keyName + " — OK", "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, "PERSIST failed."), "err");
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    try {
      await kvDeleteKey(handleId, db, keyName);
      toast("DEL " + keyName + " — OK", "ok");
      onMutated();
      onClose();
    } catch (err) {
      toast(appErrorMessage(err, "DEL failed."), "err");
    }
  };

  const requestDelete = () => {
    if (isProduction) setConfirmDelete(true);
    else void doDelete();
  };

  const row = (label: string, val: React.ReactNode) => (
    <div className="rinfo-row">
      <span className="rinfo-label">{label}</span>
      <span className="rinfo-val">{val}</span>
    </div>
  );

  const hasTtl = view.ttl >= 0;

  return (
    <div className="rinfo">
      <div className="rinfo-head">
        <RedisTypeBadge type={view.keyType} size={22} />
        <code className="rinfo-key">{keyName}</code>
        <IconBtn icon="content_copy" size={15} title="Copy key" onClick={copyKey} />
      </div>

      <div className="rinfo-grid">
        {row("Type", <span style={{ color: meta.color }}>{view.keyType}</span>)}
        {row("Encoding", <code>{view.encoding ?? "—"}</code>)}
        {row("Elements", view.keyType === "string" ? "—" : count)}
        {row("Size", view.keyType === "string" ? count + " bytes" : count + " items")}
        {row("Memory", view.memory !== null ? humanBytes(view.memory) : "—")}
        {row("Idle", view.idle !== null ? humanTTL(view.idle) : "—")}
        {row(
          "TTL",
          hasTtl ? (
            <span className="cell-true">
              {humanTTL(view.ttl)} ({view.ttl}s)
            </span>
          ) : (
            <span className="cell-dim">no expiry (∞)</span>
          ),
        )}
      </div>

      <div className="rinfo-actions">
        <h3>
          <Icon name="bolt" size={14} /> Quick actions
        </h3>
        <div className="rinfo-act-row">
          <input
            className="rinfo-ttl-input"
            placeholder="seconds"
            value={ttlDraft}
            spellCheck={false}
            aria-label="TTL in seconds"
            onChange={(e) => setTtlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void setTtl();
            }}
          />
          <Btn variant="tonal" icon="schedule" small onClick={setTtl}>
            Set TTL (EXPIRE)
          </Btn>
          {hasTtl ? (
            <Btn variant="text" small onClick={persist}>
              Persist
            </Btn>
          ) : null}
          <div className="rinfo-act-spacer" />
          <Btn variant="text" icon="delete" small className="rinfo-del-btn" onClick={requestDelete}>
            Delete key (DEL)
          </Btn>
        </div>
      </div>

      {confirmDelete ? (
        <Modal onClose={() => setConfirmDelete(false)} label="Confirm delete" width={460}>
          <ModalTitle>
            <Icon name="warning" size={18} style={{ color: "#e06c75" }} /> Delete a key on a
            production connection?
          </ModalTitle>
          <p className="dg-confirm-body">
            This connection points at <b>production</b>. The following command will run:
          </p>
          <code className="dg-confirm-sql">DEL {keyName}</code>
          <ModalActions>
            <Btn variant="text" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Btn>
            <Btn variant="filled" className="rinfo-del-btn" onClick={doDelete}>
              Delete key
            </Btn>
          </ModalActions>
        </Modal>
      ) : null}
    </div>
  );
}
