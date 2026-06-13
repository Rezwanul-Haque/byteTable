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
import { CellContent } from "../../browse/components/GridCell";
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
}: KeyTabProps) {
  const toast = useToast();
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const json = isJsonish(value);
  const pretty = json ? JSON.stringify(JSON.parse(value), null, 2) : value;

  const save = async () => {
    try {
      await kvSetString(handleId, db, keyName, draft);
      setEditing(false);
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
        </span>
        <div className="rstr-bar-spacer" />
        {editing ? (
          <>
            <Btn
              variant="text"
              small
              onClick={() => {
                setDraft(value);
                setEditing(false);
              }}
            >
              Cancel
            </Btn>
            <Btn variant="filled" icon="check" small onClick={save}>
              Save (SET)
            </Btn>
          </>
        ) : (
          <Btn
            variant="tonal"
            icon="edit"
            small
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
          >
            Edit
          </Btn>
        )}
      </div>
      {editing ? (
        <textarea
          className="rstr-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-label={"Edit value of " + keyName}
          autoFocus
        />
      ) : (
        <pre className="rstr-value">{pretty}</pre>
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
  /** Commit an inline edit: (rowIndex, columnIndex, draftText). */
  onEdit?: (rowIndex: number, colIndex: number, draft: string) => void;
  empty: string;
}

function KeyGrid({ columns, rows, onEdit, empty }: KeyGridProps) {
  const [editing, setEditing] = useState<{ row: number; col: number; draft: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const gridCols = "38px " + columns.map(() => "minmax(90px, max-content)").join(" ");

  const commit = () => {
    if (!editing) return;
    const cur = rows[editing.row]?.[editing.col];
    const next = editing.draft;
    setEditing(null);
    // Only fire the write when the value actually changed.
    if (onEdit && String(cur ?? "") !== next) onEdit(editing.row, editing.col, next);
  };

  if (rows.length === 0) {
    return <div className="grid-empty">{empty}</div>;
  }

  return (
    <div className="datagrid-wrap">
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
          {rows.map((row, ri) => (
            <div key={ri} className="dg-tr dg-row">
              <div className="dg-rownum">{ri + 1}</div>
              {columns.map((c, ci) => {
                const isEditing = editing?.row === ri && editing?.col === ci;
                const cellValue = row[ci] ?? null;
                return (
                  <div
                    key={c.name}
                    className={"dg-td" + (isEditing ? " cell-editing" : "")}
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
  onEdit: (ri: number, ci: number, draft: string) => void;
  onRemove: (member: string) => void;
}) {
  const [editing, setEditing] = useState<{ row: number; draft: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    if (!editing) return;
    const cur = members[editing.row];
    const next = editing.draft;
    setEditing(null);
    if (String(cur ?? "") !== next) onEdit(editing.row, 0, next);
  };

  if (rows.length === 0) return <div className="grid-empty">empty set</div>;

  return (
    <div className="datagrid-wrap">
      <div
        className="dg-canvas"
        style={{ "--grid-cols": "38px minmax(90px, max-content) 36px" } as React.CSSProperties}
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
            return (
              <div key={ri} className="dg-tr dg-row">
                <div className="dg-rownum">{ri + 1}</div>
                <div
                  className={"dg-td" + (isEditing ? " cell-editing" : "")}
                  onDoubleClick={() => setEditing({ row: ri, draft: m })}
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
                    <CellContent value={m} column="member" />
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
