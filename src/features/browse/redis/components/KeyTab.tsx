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

import { appErrorMessage } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../../shared/ui/Modal";
import { useToast } from "../../../../shared/ui/toastContext";
import { CellContent } from "../../shared/components/GridCell";
import { highlightJSON } from "../../shared/jsonCell";
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
  const t = useT();
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
        setError(appErrorMessage(err, t("redis.kt.loadFail")));
      } finally {
        if (signal.live) setLoading(false);
      }
    },
    [handleId, db, keyName, t],
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
        <span className="spinner" /> {t("redis.kt.loading")}
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
          {t("redis.kt.gonePre")} <code>{keyName}</code> {t("redis.kt.gonePost")}
        </p>
        <Btn variant="tonal" small icon="close" onClick={onClose}>
          {t("redis.closeTab")}
        </Btn>
      </div>
    );
  }

  const count = elementCount(view.value);
  const sizeReadout =
    view.keyType === "string"
      ? t("redis.kt.sizeBytes", { count })
      : t("redis.kt.sizeItems", { count });

  return (
    <div className="rkey-tab" data-screen-label={"Redis key: " + keyName}>
      <div className="rkey-toolbar">
        <div className="seg" role="tablist" aria-label={t("redis.kt.viewModeAria")}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "value"}
            className={"seg-btn" + (mode === "value" ? " active" : "")}
            onClick={() => setMode("value")}
          >
            <RedisTypeBadge type={view.keyType} size={13} /> {t("redis.kt.segValue")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "info"}
            className={"seg-btn" + (mode === "info" ? " active" : "")}
            onClick={() => setMode("info")}
          >
            <Icon name="info" size={14} /> {t("redis.kt.segInfo")}
          </button>
        </div>
        <code className="rkey-tab-name">{keyName}</code>
        <IconBtn
          icon="content_copy"
          size={13}
          title={t("redis.kt.copyKeyName")}
          onClick={() => {
            void navigator.clipboard.writeText(keyName).then(
              () => toast(t("redis.kt.keyNameCopied"), "ok"),
              () => toast(t("uix.copy.fail"), "err"),
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
  const t = useT();
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
      return <div className="grid-empty">{t("redis.kt.goneShort")}</div>;
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
  const t = useT();
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
      toast(t("redis.kt.setOk", { name: keyName }), "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.setFail")), "err");
    }
  };

  return (
    <div className="rstr">
      <div className="rstr-bar">
        <span className="rstr-meta">
          {json ? "JSON" : "string"} · {t("redis.kt.sizeBytes", { count: value.length })}
          {dirty ? <span className="rstr-unsaved"> · {t("redis.kt.unsaved")}</span> : null}
        </span>
        <div className="rstr-bar-spacer" />
        <IconBtn
          icon="content_copy"
          size={14}
          title={t("redis.kt.copyValue")}
          onClick={() => {
            void navigator.clipboard.writeText(draft).then(
              () => toast(t("redis.kt.valueCopied"), "ok"),
              () => toast(t("uix.copy.fail"), "err"),
            );
          }}
        />
        {dirty ? (
          <>
            <Btn variant="text" small onClick={() => setDraft(pretty)}>
              {t("redis.kt.discard")}
            </Btn>
            <Btn variant="filled" icon="check" small onClick={save}>
              {t("redis.kt.saveSet")}
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
            aria-label={t("redis.kt.editValueAria", { name: keyName })}
          />
        </div>
      ) : (
        <textarea
          className="rstr-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          aria-label={t("redis.kt.editValueAria", { name: keyName })}
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
  const t = useT();
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
                      title={c.editable && onEdit ? t("redis.kt.dblClickEdit") : undefined}
                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          className="cell-input"
                          aria-label={t("redis.kt.editColAria", { name: c.name })}
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
            {t("redis.kt.cellsEdited", { count: staged.size })}
          </span>
          <div style={{ flex: 1 }} />
          <Btn variant="text" small disabled={saving} onClick={discard}>
            {t("redis.kt.discard")}
          </Btn>
          <Btn variant="filled" icon="check" small disabled={saving} onClick={() => void saveAll()}>
            {t("common.save")}
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
  const t = useT();
  const rows = fields.map((f) => [f.field, f.value]);
  const onEdit = async (ri: number, ci: number, draft: string) => {
    const row = fields[ri];
    if (!row) return;
    try {
      if (ci === 1) {
        // Edit value → HSET key field value.
        await kvHashSet(handleId, db, keyName, row.field, draft);
        toast(t("redis.kt.hsetOk", { name: keyName, field: row.field }), "ok");
      } else {
        // Edit field → HDEL old + HSET new (carry the value over).
        await kvHashDel(handleId, db, keyName, row.field);
        await kvHashSet(handleId, db, keyName, draft, row.value);
        toast(t("redis.kt.hdelHsetOk", { field: row.field, new: draft }), "ok");
      }
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.hashFail")), "err");
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
      empty={t("redis.kt.emptyHash")}
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
  const t = useT();
  const rows = items.map((v, i) => [i, v]);
  const onEdit = async (ri: number, _ci: number, draft: string) => {
    try {
      await kvListSet(handleId, db, keyName, ri, draft);
      toast(t("redis.kt.lsetOk", { name: keyName, index: ri }), "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.lsetFail")), "err");
    }
  };
  return (
    <KeyGrid
      columns={[{ name: "index" }, { name: "value", editable: true }]}
      rows={rows}
      onEdit={onEdit}
      empty={t("redis.kt.emptyList")}
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
  const t = useT();
  const [adding, setAdding] = useState("");
  const rows = members.map((m) => [m]);

  // Edit a member = SREM old + SADD new (a set has no in-place update).
  const onEdit = async (ri: number, _ci: number, draft: string) => {
    const old = members[ri];
    if (old === undefined) return;
    try {
      await kvSetRemove(handleId, db, keyName, old);
      await kvSetAdd(handleId, db, keyName, draft);
      toast(t("redis.kt.sremSaddOk", { old, new: draft }), "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.setUpdateFail")), "err");
    }
  };

  const add = async () => {
    const m = adding.trim();
    if (!m) return;
    try {
      await kvSetAdd(handleId, db, keyName, m);
      setAdding("");
      toast(t("redis.kt.saddOk", { name: keyName, member: m }), "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.saddFail")), "err");
    }
  };

  const remove = async (member: string) => {
    try {
      await kvSetRemove(handleId, db, keyName, member);
      toast(t("redis.kt.sremOk", { name: keyName, member }), "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.sremFail")), "err");
    }
  };

  return (
    <div className="rset">
      <div className="rset-add">
        <input
          className="rinfo-ttl-input rset-add-input"
          placeholder={t("redis.kt.newMember")}
          value={adding}
          spellCheck={false}
          aria-label={t("redis.kt.addMemberAria", { name: keyName })}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <Btn variant="tonal" icon="add" small onClick={add}>
          {t("redis.kt.addSadd")}
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
  const t = useT();
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

  if (rows.length === 0) return <div className="grid-empty">{t("redis.kt.emptySet")}</div>;

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
                    title={t("redis.kt.dblClickEdit")}
                  >
                    {isEditing ? (
                      <input
                        ref={inputRef}
                        className="cell-input"
                        aria-label={t("redis.kt.editColAria", { name: "member" })}
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
                      title={t("redis.kt.removeMember", { member: m })}
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
            {t("redis.kt.membersEdited", { count: staged.size })}
          </span>
          <div style={{ flex: 1 }} />
          <Btn variant="text" small disabled={saving} onClick={discard}>
            {t("redis.kt.discard")}
          </Btn>
          <Btn variant="filled" icon="check" small disabled={saving} onClick={() => void saveAll()}>
            {t("common.save")}
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
  const t = useT();
  // Sorted by score (REDIS_SPEC §6); rank is the sorted index, read-only.
  const sorted = entries.slice().sort((a, b) => a.score - b.score);
  const rows = sorted.map((e, i) => [i, e.member, e.score]);

  const onEdit = async (ri: number, ci: number, draft: string) => {
    if (ci !== 2) return; // only the score column is editable
    const entry = sorted[ri];
    if (!entry) return;
    const score = Number(draft);
    if (Number.isNaN(score)) {
      toast(t("redis.kt.scoreNum"), "err");
      return;
    }
    try {
      await kvZsetAdd(handleId, db, keyName, entry.member, score);
      toast(t("redis.kt.zaddOk", { name: keyName, score, member: entry.member }), "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.zaddFail")), "err");
    }
  };

  return (
    <KeyGrid
      columns={[{ name: "rank" }, { name: "member" }, { name: "score", editable: true }]}
      rows={rows}
      onEdit={onEdit}
      empty={t("redis.kt.emptyZset")}
    />
  );
}

function StreamViewer({
  entries,
}: {
  entries: { id: string; fields: { field: string; value: string }[] }[];
}) {
  const t = useT();
  const rows = entries.map((e) => [e.id, e.fields.map((f) => f.field + "=" + f.value).join("  ")]);
  return (
    <KeyGrid
      columns={[{ name: "id" }, { name: "fields" }]}
      rows={rows}
      empty={t("redis.kt.emptyStream")}
    />
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
  const t = useT();
  const [ttlDraft, setTtlDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = REDIS_TYPES[view.keyType];

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(keyName);
      toast(t("redis.kt.keyCopied"), "info");
    } catch {
      toast(t("redis.kt.keyCopyFail"), "err");
    }
  };

  const setTtl = async () => {
    const seconds = parseInt(ttlDraft, 10);
    if (Number.isNaN(seconds)) {
      toast(t("redis.kt.ttlNum"), "err");
      return;
    }
    try {
      await kvExpire(handleId, db, keyName, seconds);
      setTtlDraft("");
      toast(t("redis.kt.expireOk", { name: keyName, seconds }), "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.expireFail")), "err");
    }
  };

  const persist = async () => {
    try {
      await kvPersist(handleId, db, keyName);
      toast(t("redis.kt.persistOk", { name: keyName }), "ok");
      onMutated();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.persistFail")), "err");
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    try {
      await kvDeleteKey(handleId, db, keyName);
      toast(t("redis.delOk", { name: keyName }), "ok");
      onMutated();
      onClose();
    } catch (err) {
      toast(appErrorMessage(err, t("redis.kt.delFailCmd")), "err");
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
        <IconBtn icon="content_copy" size={15} title={t("redis.kt.copyKey")} onClick={copyKey} />
      </div>

      <div className="rinfo-grid">
        {row(t("redis.kt.infoType"), <span style={{ color: meta.color }}>{view.keyType}</span>)}
        {row(t("redis.kt.infoEncoding"), <code>{view.encoding ?? "—"}</code>)}
        {row(t("redis.kt.infoElements"), view.keyType === "string" ? "—" : count)}
        {row(
          t("redis.kt.infoSize"),
          view.keyType === "string"
            ? t("redis.kt.sizeBytes", { count })
            : t("redis.kt.sizeItems", { count }),
        )}
        {row(t("redis.kt.infoMemory"), view.memory !== null ? humanBytes(view.memory) : "—")}
        {row(t("redis.kt.infoIdle"), view.idle !== null ? humanTTL(view.idle) : "—")}
        {row(
          t("redis.kt.infoTtl"),
          hasTtl ? (
            <span className="cell-true">
              {humanTTL(view.ttl)} ({view.ttl}s)
            </span>
          ) : (
            <span className="cell-dim">{t("redis.kt.noExpiry")}</span>
          ),
        )}
      </div>

      <div className="rinfo-actions">
        <h3>
          <Icon name="bolt" size={14} /> {t("redis.kt.quickActions")}
        </h3>
        <div className="rinfo-act-row">
          <input
            className="rinfo-ttl-input"
            placeholder={t("redis.kt.seconds")}
            value={ttlDraft}
            spellCheck={false}
            aria-label={t("redis.kt.ttlAria")}
            onChange={(e) => setTtlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void setTtl();
            }}
          />
          <Btn variant="tonal" icon="schedule" small onClick={setTtl}>
            {t("redis.kt.setTtl")}
          </Btn>
          {hasTtl ? (
            <Btn variant="text" small onClick={persist}>
              {t("redis.kt.persistBtn")}
            </Btn>
          ) : null}
          <div className="rinfo-act-spacer" />
          <Btn variant="text" icon="delete" small className="rinfo-del-btn" onClick={requestDelete}>
            {t("redis.delKeyBtn")}
          </Btn>
        </div>
      </div>

      {confirmDelete ? (
        <Modal
          onClose={() => setConfirmDelete(false)}
          label={t("redis.kt.confirmDeleteAria")}
          width={460}
        >
          <ModalTitle>
            <Icon name="warning" size={18} style={{ color: "#e06c75" }} />{" "}
            {t("redis.kt.delProdTitle")}
          </ModalTitle>
          <p className="dg-confirm-body">
            {t("redis.kt.delProdPre")} <b>production</b>
            {t("redis.kt.delProdPost")}
          </p>
          <code className="dg-confirm-sql">DEL {keyName}</code>
          <ModalActions>
            <Btn variant="text" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Btn>
            <Btn variant="filled" className="rinfo-del-btn" onClick={doDelete}>
              {t("redis.kt.deleteKeyBtn")}
            </Btn>
          </ModalActions>
        </Modal>
      ) : null}
    </div>
  );
}
