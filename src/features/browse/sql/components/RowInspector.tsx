// Row Inspector — a right-side drawer that opens when a row is clicked in the
// SQL browse grid. It shows the whole record vertically (every column
// scrollable) with type-aware editors: plain text/number, boolean chips, JSON
// with live validation + syntax highlight, binary via the shared hex/UUID
// modal, and a calendar + clock editor for timestamps (UTC by default, timezone
// switchable). Nothing writes directly — edits are STAGED into the browse tab's
// pending-edit buffer (via `onStage`) and only committed when the user saves
// (⌘S) in the grid's save bar.
//
// Ported behavior-for-behavior from the prototype's row-inspector.jsx; the
// staging bridge is adapted to the real DataGrid's column-index /
// EditTarget model (the grid maps `onStage`'s per-column-index changes onto its
// `stageRealValue` / `stageNewValue`).

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CellValue } from "../../../../shared/api/engine";
import { Icon } from "../../../../shared/ui/Icon";
import { useToast } from "../../../../shared/ui/toastContext";
import { CellContent } from "../../shared/GridCell";
import {
  binaryClipboardText,
  formatBinary,
  isBinaryType,
  isUuidType,
} from "../../shared/binaryCell";
import { isJsonType, validateJSON } from "../../shared/jsonCell";
import { JsonField } from "../../shared/JsonField";
import { isTemporalType } from "../../shared/dateTimeCell";
// The calendar + clock editor now lives in `browse/shared` — it is shared with
// the DynamoDB item drawer, so neither engine slice imports from the other.
import { RiDateTime } from "../../shared/DateTimeField";
import { BinaryEditorModal } from "./BinaryEditorModal";
import { UuidEditorModal } from "./UuidEditorModal";
import "../../shared/CellEditors.css";
import "../../shared/InspectorShell.css";
import "./RowInspector.css";

/** Clipboard shapes offered by the drawer's copy-row menu. */
export type RowCopyFormat = "csv" | "json" | "sql" | "values";

const ROW_COPY_ITEMS: { format: RowCopyFormat; label: string; icon: string }[] = [
  { format: "csv", label: "Copy as CSV", icon: "table_view" },
  { format: "json", label: "Copy as JSON", icon: "data_object" },
  { format: "sql", label: "Copy as SQL INSERT", icon: "database" },
  { format: "values", label: "Copy values only", icon: "notes" },
];

/** One column as the inspector needs it: name, declared type, pk/fk flags. */
export interface InspectorColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
}

// --- one field card ---------------------------------------------------------

function RowInspectorField({
  col,
  index,
  focused,
  value,
  draft,
  hasDraft,
  onDraft,
  onRevert,
  schemaName,
  tableName,
}: {
  col: InspectorColumn;
  /** Column index — the drawer finds this field by it to focus the clicked cell. */
  index: number;
  /** True for the field matching the cell the drawer was opened from. */
  focused: boolean;
  value: CellValue;
  draft: CellValue;
  hasDraft: boolean;
  onDraft: (v: CellValue) => void;
  onRevert: () => void;
  schemaName: string;
  tableName: string;
}) {
  const json = isJsonType(col.type);
  const bin = isBinaryType(col.type);
  const uuid = isUuidType(col.type);
  const [binOpen, setBinOpen] = useState(false);
  const [uuidOpen, setUuidOpen] = useState(false);
  const toast = useToast();
  const cur = hasDraft ? draft : value;
  const dirty = hasDraft && draft !== value;
  const isNull = cur === null || cur === undefined;
  // Only true booleans get the toggle: Postgres native `boolean` (value is a JS
  // boolean, or the column type says so even when NULL). MySQL `tinyint(1)` has
  // no native bool — its value is the integer 0/1 — so it renders as a number.
  const boolCol = typeof value === "boolean" || /^(bool|boolean)$/i.test((col.type || "").trim());
  const numCol = typeof value === "number";
  // Numeric fields keep the exact keystrokes ("15.", "1.50", "1e") alongside the
  // parsed draft: the draft is a Number, and String(15) would swallow the dot the
  // user just typed, making a decimal impossible to enter. Only trusted while it
  // still parses to the field's own draft — a revert or row-nav drops it.
  const [numText, setNumText] = useState<string | null>(null);

  // Copy the field's current value to the clipboard. Binary copies `0x`-hex —
  // NOT the UUID display form — so it matches the grid's copy button and pastes
  // into a query as the stored bytes; objects serialize to JSON; NULL copies an
  // empty string.
  const copyValue = () => {
    let s: string;
    if (isNull) s = "";
    else if (bin) s = binaryClipboardText(cur);
    else if (typeof cur === "object") s = JSON.stringify(cur);
    else s = String(cur);
    void navigator.clipboard.writeText(s).then(
      () => toast("Copied", "ok"),
      () => toast("Couldn't copy to clipboard", "err"),
    );
  };

  let body: React.ReactNode;
  if (json) {
    const text = (() => {
      if (isNull) return "";
      if (typeof cur !== "string") return JSON.stringify(cur, null, 2);
      if (hasDraft) return cur; // user is typing — leave as-is
      try {
        return JSON.stringify(JSON.parse(cur), null, 2);
      } catch {
        return cur;
      }
    })();
    // An empty JSON column stores NULL, so the empty string is translated here
    // rather than inside the shared field.
    body = <JsonField text={text} onChange={(t) => onDraft(t === "" ? null : t)} />;
  } else if (bin) {
    const fb = isNull ? null : formatBinary(cur, col.type);
    body = (
      <div className="ri-bin">
        <button
          type="button"
          className="ri-bin-val"
          onClick={() => setBinOpen(true)}
          title="Edit binary value"
        >
          <span className="bin-badge">BIN</span>
          {fb ? (
            <span className={"bin-val " + fb.kind}>{fb.text}</span>
          ) : (
            <span className="ri-null">NULL</span>
          )}
          <Icon name="edit" size={12} style={{ marginLeft: "auto", color: "var(--text-faint)" }} />
        </button>
        {binOpen ? (
          <BinaryEditorModal
            schemaName={schemaName}
            table={tableName}
            column={col.name}
            type={col.type}
            value={cur}
            onClose={() => setBinOpen(false)}
            onSave={(next) => {
              onDraft(next);
              setBinOpen(false);
            }}
          />
        ) : null}
      </div>
    );
  } else if (uuid) {
    const guid = /uniqueidentifier|guid/i.test(col.type || "");
    body = (
      <div className="ri-bin">
        <button
          type="button"
          className="ri-bin-val"
          onClick={() => setUuidOpen(true)}
          title="Edit UUID value"
        >
          <span className="bin-badge">{guid ? "GUID" : "UUID"}</span>
          {isNull ? (
            <span className="ri-null">NULL</span>
          ) : (
            <span className="bin-val uuid">{String(cur)}</span>
          )}
          <Icon name="edit" size={12} style={{ marginLeft: "auto", color: "var(--text-faint)" }} />
        </button>
        {uuidOpen ? (
          <UuidEditorModal
            schemaName={schemaName}
            table={tableName}
            column={col.name}
            type={col.type}
            value={cur}
            onClose={() => setUuidOpen(false)}
            onSave={(next) => {
              onDraft(next);
              setUuidOpen(false);
            }}
          />
        ) : null}
      </div>
    );
  } else if (isTemporalType(col.type)) {
    body = <RiDateTime type={col.type} cur={cur} onDraft={onDraft} />;
  } else if (boolCol) {
    body = (
      <div className="ri-bool">
        {[true, false].map((b) => (
          <button
            key={String(b)}
            type="button"
            className={"ri-bool-btn" + (cur === b ? " on" : "")}
            onClick={() => onDraft(b)}
          >
            {String(b)}
          </button>
        ))}
        <button
          type="button"
          className={"ri-bool-btn null" + (isNull ? " on" : "")}
          onClick={() => onDraft(null)}
        >
          null
        </button>
      </div>
    );
  } else {
    const raw = numCol && hasDraft && numText !== null && Number(numText) === cur ? numText : null;
    const text = raw ?? (isNull ? "" : String(cur));
    const long = text.length > 48 || text.includes("\n");
    body = long ? (
      <textarea
        className="ri-input ri-ta"
        spellCheck={false}
        rows={Math.min(8, Math.max(2, text.split("\n").length + 1))}
        value={text}
        placeholder="null"
        onChange={(e) => onDraft(e.target.value === "" ? null : e.target.value)}
      />
    ) : (
      <input
        className="ri-input"
        value={text}
        placeholder="null"
        spellCheck={false}
        inputMode={numCol ? "decimal" : undefined}
        onChange={(e) => {
          const typed = e.target.value;
          if (numCol) setNumText(typed);
          if (typed === "") return onDraft(null);
          if (numCol && typed.trim() !== "" && !Number.isNaN(Number(typed)))
            return onDraft(Number(typed));
          onDraft(typed);
        }}
      />
    );
  }

  return (
    <div
      className={"ri-field" + (dirty ? " dirty" : "") + (focused ? " focused" : "")}
      data-ri-field={index}
    >
      <div className="ri-field-head">
        {col.pk ? (
          <Icon
            name="key"
            size={11}
            style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
          />
        ) : null}
        {col.fk ? <Icon name="link" size={11} style={{ color: "var(--text-faint)" }} /> : null}
        <span className="ri-field-name">{col.name}</span>
        <span className="ri-field-type">{(col.type || "").toLowerCase()}</span>
        {dirty ? <span className="ri-dot" title="Changed — not staged yet" /> : null}
        <button
          type="button"
          className="ri-mini-btn ri-copy"
          title="Copy value"
          onClick={copyValue}
        >
          <Icon name="content_copy" size={12} />
        </button>
        {dirty ? (
          <button
            type="button"
            className="ri-mini-btn"
            title="Revert this field"
            onClick={onRevert}
          >
            <Icon name="undo" size={12} />
          </button>
        ) : null}
      </div>
      {col.pk ? (
        bin ? (
          // Binary primary key: read-only. Borderless BIN chip inside the dashed
          // pk box (matches the scalar pk look); clicking opens the binary editor
          // modal in read-only mode to view the full UUID / stored bytes.
          <div className="ri-pk-lock">
            <button
              type="button"
              className="bin-cell ri-pk-binbtn"
              onClick={() => setBinOpen(true)}
              title="View binary value"
            >
              {(() => {
                const fb = formatBinary(value, col.type);
                return fb ? (
                  <>
                    <span className="bin-badge">BIN</span>
                    <span className={"bin-val " + fb.kind}>{fb.text}</span>
                  </>
                ) : (
                  <span className="ri-null">NULL</span>
                );
              })()}
            </button>
            <span className="ri-pk-note">
              <Icon name="lock" size={11} /> primary key
            </span>
            {binOpen ? (
              <BinaryEditorModal
                schemaName={schemaName}
                table={tableName}
                column={col.name}
                type={col.type}
                value={value}
                readOnly
                onClose={() => setBinOpen(false)}
                onSave={() => setBinOpen(false)}
              />
            ) : null}
          </div>
        ) : uuid ? (
          // UUID / GUID primary key: read-only chip; click to view in the modal.
          <div className="ri-pk-lock">
            <button
              type="button"
              className="bin-cell ri-pk-binbtn"
              onClick={() => setUuidOpen(true)}
              title="View UUID value"
            >
              <span className="bin-badge">
                {/uniqueidentifier|guid/i.test(col.type || "") ? "GUID" : "UUID"}
              </span>
              {value == null ? (
                <span className="ri-null">NULL</span>
              ) : (
                <span className="bin-val uuid">{String(value)}</span>
              )}
            </button>
            <span className="ri-pk-note">
              <Icon name="lock" size={11} /> primary key
            </span>
            {uuidOpen ? (
              <UuidEditorModal
                schemaName={schemaName}
                table={tableName}
                column={col.name}
                type={col.type}
                value={value}
                readOnly
                onClose={() => setUuidOpen(false)}
                onSave={() => setUuidOpen(false)}
              />
            ) : null}
          </div>
        ) : (
          <div className="ri-pk-lock">
            <CellContent value={value} column={col.name} type={col.type} />
            <span className="ri-pk-note">
              <Icon name="lock" size={11} /> primary key
            </span>
          </div>
        )
      ) : (
        body
      )}
    </div>
  );
}

// --- drawer shell -----------------------------------------------------------

interface RowInspectorProps {
  open: boolean;
  columns: InspectorColumn[];
  /** Displayed base values aligned to `columns`; null when no row is targeted. */
  values: CellValue[] | null;
  /** Stable identity of the targeted row — resets drafts when it changes. */
  rowId: string;
  /**
   * Column index of the cell the drawer was opened from, or null when it was
   * opened for the whole row (the row-number button). That field is highlighted,
   * scrolled into view and given focus, so clicking a cell lands you on the same
   * field here instead of at the top of the record.
   */
  focusColumn: number | null;
  isStagedNew: boolean;
  /** The pk = value subline body (composite keys joined), e.g. `id = 42`. */
  pkLabel: string;
  /** 1-based position + total, for the `n / N` nav readout. */
  position: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  schemaName: string;
  tableName: string;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  /**
   * Re-fetch the grid page and re-read this row, drawer stays open. OMIT when
   * there is nothing to re-read: the M35 data-file editor's rows come from a
   * file already held in memory, and a refresh button that cannot refresh
   * anything is worse than no button.
   */
  onRefresh?: () => void;
  /** True while that re-fetch is in flight — spins the refresh icon. */
  refreshing?: boolean;
  /** Copy this row to the clipboard in one of the offered shapes. Gets the
   *  values the drawer is SHOWING (drafts folded over the base row). */
  onCopyRow: (format: RowCopyFormat, values: CellValue[]) => void;
  /** Stage the changed cells (column index → new value) into the grid's buffer. */
  onStage: (changes: Map<number, CellValue>) => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function RowInspector({
  open,
  columns,
  values,
  rowId,
  focusColumn,
  isStagedNew,
  pkLabel,
  position,
  total,
  canPrev,
  canNext,
  schemaName,
  tableName,
  onPrev,
  onNext,
  onClose,
  onRefresh,
  refreshing,
  onCopyRow,
  onStage,
  onDirtyChange,
}: RowInspectorProps) {
  // Drafts keyed by column index; a present key (incl. a null value) is an
  // active draft, an absent key means "unchanged".
  const [drafts, setDrafts] = useState<Map<number, CellValue>>(new Map());

  // Reset drafts whenever the targeted row changes (nav / retarget / close).
  // Done during render (React's "adjust state on prop change" pattern, as in
  // TableTab's pager reset) rather than in an effect, to avoid a cascading pass.
  const [lastRowId, setLastRowId] = useState(rowId);
  if (lastRowId !== rowId) {
    setLastRowId(rowId);
    setDrafts(new Map());
  }

  // Effective changes: drafts that differ from the current base value.
  const changes = useMemo(() => {
    const out = new Map<number, CellValue>();
    if (!values) return out;
    drafts.forEach((v, ci) => {
      if (v !== (values[ci] ?? null)) out.set(ci, v);
    });
    return out;
  }, [drafts, values]);
  const nChanges = changes.size;

  const dirty = nChanges > 0;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const jsonBroken = useMemo(() => {
    if (!values) return false;
    for (const [ci, v] of changes) {
      const col = columns[ci];
      if (!col || !isJsonType(col.type)) continue;
      if (v != null && !validateJSON(typeof v === "string" ? v : JSON.stringify(v)).ok) return true;
    }
    return false;
  }, [changes, columns, values]);

  // Copy-row menu (CSV / JSON / SQL), anchored beside the reload button.
  const [copyOpen, setCopyOpen] = useState(false);
  const copyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!copyOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (copyRef.current && !copyRef.current.contains(e.target as Node)) setCopyOpen(false);
    };
    window.addEventListener("click", onClickOutside);
    return () => window.removeEventListener("click", onClickOutside);
  }, [copyOpen]);

  // Put the clicked cell's field under the user's hands: scroll it into view
  // inside the scroller and focus its editor. Runs on open and whenever the
  // target moves (another cell, or prev/next stepping to the next row with the
  // same column), never on an unrelated re-render.
  //
  // The editors are queried by class rather than through a ref map because a
  // field renders one of several bodies (text/number, JSON textarea, bool chips,
  // binary/UUID buttons, the date-time trigger) — and the field HEAD also holds
  // buttons (copy/revert), which a generic "first focusable" query would grab.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || focusColumn === null) return;
    const field = bodyRef.current?.querySelector<HTMLElement>(
      '[data-ri-field="' + focusColumn + '"]',
    );
    if (!field) return;
    field.scrollIntoView({ block: "nearest" });
    // Preferred editors first; the fallbacks cover read-only pk chips and the
    // bool row when neither chip is the current value.
    const control =
      field.querySelector<HTMLElement>(".ri-input, .ri-json-ta, .ri-bool-btn.on, .ri-bin-val") ??
      field.querySelector<HTMLElement>(".ri-bool-btn, .ri-pk-binbtn, button");
    control?.focus();
  }, [open, rowId, focusColumn]);

  // What the drawer is showing right now: base row with the open drafts folded
  // in, so a copy matches the fields on screen rather than the stored row.
  const shownValues = useMemo(
    () =>
      columns.map((_, ci) => (drafts.has(ci) ? (drafts.get(ci) ?? null) : (values?.[ci] ?? null))),
    [columns, drafts, values],
  );

  const setDraft = (ci: number, v: CellValue) =>
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(ci, v);
      return next;
    });
  const revert = (ci: number) =>
    setDrafts((prev) => {
      const next = new Map(prev);
      next.delete(ci);
      return next;
    });

  // Stage the current field edits into the grid's save bar — the action of the
  // "Stage changes" button, also reachable via ⌘/Ctrl+S below. No-op unless
  // there is a valid change (mirrors the button's `disabled` gate).
  const stage = useCallback(() => {
    if (nChanges === 0 || jsonBroken) return;
    onStage(new Map(changes));
    setDrafts(new Map());
    onClose();
  }, [nChanges, jsonBroken, changes, onStage, onClose]);

  // Escape closes; ⌘/Ctrl+S stages (NOT the grid's batch commit — while the
  // drawer holds un-staged edits, save must stage those first). The grid's own
  // ⌘S window listener skips its `save()` when this drawer is open + dirty, so
  // the two never both fire for one keystroke.
  //
  // Both branches `preventDefault()`: an Escape we act on must not travel on to
  // the window, or macOS reads it as "leave full screen" and one keypress both
  // closes the drawer and drops the app out of full screen. Same reason the
  // shared `Modal` swallows Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        stage();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, stage]);

  return createPortal(
    <aside className={"ri-drawer" + (open ? " open" : "")}>
      {values ? (
        <>
          <div className="ri-head">
            <Icon name="wysiwyg" size={16} style={{ color: "var(--accent)" }} />
            <div className="ri-title">
              <span className="ri-title-main">{tableName}</span>
              <span className="ri-title-sub">
                {schemaName} · {pkLabel}
                {isStagedNew ? " · staged row" : ""}
              </span>
            </div>
            <div className="ri-nav">
              <button
                type="button"
                className="ri-nav-btn"
                disabled={!canPrev || dirty}
                title={dirty ? "Stage or discard changes first" : "Previous row"}
                onClick={onPrev}
              >
                <Icon name="keyboard_arrow_up" size={16} />
              </button>
              <span className="ri-nav-pos">
                {position} / {total}
              </span>
              <button
                type="button"
                className="ri-nav-btn"
                disabled={!canNext || dirty}
                title={dirty ? "Stage or discard changes first" : "Next row"}
                onClick={onNext}
              >
                <Icon name="keyboard_arrow_down" size={16} />
              </button>
            </div>
            {/* Copy the whole row to the clipboard — CSV (header + one line),
                JSON object, or a ready-to-run INSERT. Shape building lives in
                the grid (it holds the engine + column metadata). */}
            <div className="ri-copyrow" ref={copyRef}>
              <button
                type="button"
                className={"ri-close" + (copyOpen ? " on" : "")}
                title="Copy this row to the clipboard"
                onClick={() => setCopyOpen(!copyOpen)}
              >
                <Icon name="content_copy" size={16} />
              </button>
              {copyOpen ? (
                <div className="ri-copyrow-menu">
                  {ROW_COPY_ITEMS.map((it) => (
                    <div
                      key={it.format}
                      className="ri-copyrow-item"
                      onClick={() => {
                        setCopyOpen(false);
                        onCopyRow(it.format, shownValues);
                      }}
                    >
                      <Icon name={it.icon} size={13} />
                      {it.label}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            {/* Re-read this row from the database without closing the drawer —
                the way to confirm a save actually landed. Blocked while dirty:
                a re-fetch replaces the base values under the open drafts. */}
            {onRefresh ? (
              <button
                type="button"
                className="ri-close"
                disabled={dirty || isStagedNew || refreshing}
                title={
                  isStagedNew
                    ? "Staged row — not in the database yet"
                    : dirty
                      ? "Stage or discard changes first"
                      : "Reload this row"
                }
                onClick={onRefresh}
              >
                <Icon name="refresh" size={16} className={refreshing ? "ri-spin" : undefined} />
              </button>
            ) : null}
            <button
              type="button"
              className="ri-close"
              title="Close (Esc / ⌘E / Ctrl+E)"
              onClick={onClose}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="ri-body" ref={bodyRef}>
            {columns.map((c, ci) => (
              <RowInspectorField
                key={c.name}
                col={c}
                index={ci}
                focused={ci === focusColumn}
                value={values[ci] ?? null}
                draft={drafts.get(ci) ?? null}
                hasDraft={drafts.has(ci)}
                onDraft={(v) => setDraft(ci, v)}
                onRevert={() => revert(ci)}
                schemaName={schemaName}
                tableName={tableName}
              />
            ))}
          </div>
          <div className={"ri-foot" + (dirty ? " dirty" : "")}>
            {dirty ? (
              <>
                <Icon name="edit_note" size={15} style={{ color: "var(--accent)" }} />
                <span className="ri-foot-n">
                  {nChanges} field{nChanges > 1 ? "s" : ""} changed
                </span>
                <div style={{ flex: 1 }} />
                <button type="button" className="ri-btn ghost" onClick={() => setDrafts(new Map())}>
                  Discard
                </button>
                <button
                  type="button"
                  className="ri-btn primary"
                  disabled={jsonBroken}
                  title={
                    jsonBroken
                      ? "Fix invalid JSON first"
                      : "Stage into the save bar — commit with ⌘S"
                  }
                  onClick={stage}
                >
                  <Icon name="playlist_add_check" size={14} /> Stage changes
                </button>
              </>
            ) : (
              <span className="ri-foot-hint">
                <Icon name="info" size={13} /> Edits are staged first — nothing is written until you
                commit in the save bar (⌘S)
              </span>
            )}
          </div>
        </>
      ) : null}
    </aside>,
    document.body,
  );
}
