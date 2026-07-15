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
import { useEffect, useMemo, useRef, useState } from "react";

import type { CellValue } from "../../../../shared/api/engine";
import { Icon } from "../../../../shared/ui/Icon";
import { CellContent } from "../../shared/GridCell";
import { formatBinary, isBinaryType } from "../../shared/binaryCell";
import { highlightJSON, isJsonType, validateJSON } from "../../shared/jsonCell";
import {
  RI_TZS,
  fmtTs,
  isDateOnlyType,
  isTemporalType,
  isTzAwareType,
  p2,
  parseTs,
  tzParts,
  wallToDate,
  type WallParts,
} from "../../shared/dateTimeCell";
import { BinaryEditorModal } from "./BinaryEditorModal";
import "../../shared/CellEditors.css";
import "./RowInspector.css";

/** One column as the inspector needs it: name, declared type, pk/fk flags. */
export interface InspectorColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
}

// --- timestamp editor: calendar + clock, UTC by default, tz switchable ------

function RiStepper({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const wrap = (n: number) => (n + max + 1) % (max + 1);
  return (
    <div className="ri-step">
      <button type="button" className="ri-step-btn" onClick={() => onChange(wrap(value + 1))}>
        <Icon name="keyboard_arrow_up" size={13} />
      </button>
      <input
        className="ri-step-val"
        value={p2(value)}
        onChange={(e) => {
          const n = +e.target.value.replace(/\D/g, "").slice(-2);
          if (!Number.isNaN(n)) onChange(Math.min(max, n));
        }}
      />
      <button type="button" className="ri-step-btn" onClick={() => onChange(wrap(value - 1))}>
        <Icon name="keyboard_arrow_down" size={13} />
      </button>
    </div>
  );
}

function RiDateTime({
  type,
  cur,
  onDraft,
}: {
  type: string;
  cur: CellValue;
  onDraft: (v: CellValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tz, setTz] = useState("UTC");
  const [tzOpen, setTzOpen] = useState(false);
  const [yrOpen, setYrOpen] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const yrListRef = useRef<HTMLDivElement>(null);

  // Bring the freshly-opened panel into view inside the drawer's scroll area.
  useEffect(() => {
    if (!open || textMode || !panelRef.current) return;
    const el = panelRef.current;
    const sc = el.closest(".ri-body");
    if (!sc) return;
    requestAnimationFrame(() => {
      const eb = el.getBoundingClientRect();
      const sb = sc.getBoundingClientRect();
      if (eb.bottom > sb.bottom)
        sc.scrollTop += Math.min(eb.bottom - sb.bottom + 12, eb.top - sb.top - 8);
    });
  }, [open, textMode]);

  useEffect(() => {
    if (yrOpen && yrListRef.current) {
      const list = yrListRef.current.querySelector<HTMLElement>(".ri-dt-yrlist");
      const on = list?.querySelector<HTMLElement>(".on");
      if (list && on) list.scrollTop = on.offsetTop - 80;
    }
  }, [yrOpen]);

  const dateOnly = isDateOnlyType(type);
  // Timezone-aware Postgres columns (timestamptz) must carry an explicit UTC
  // offset so the bare literal isn't reinterpreted in the session timezone.
  const tzAware = isTzAwareType(type);
  const date = parseTs(cur);
  const w: WallParts | null = date ? tzParts(date, tz) : null;

  // Store the wall-time converted to UTC, tagged `+00` for tz-aware columns.
  const emit = (d: Date) => onDraft(fmtTs(d, dateOnly) + (tzAware ? "+00" : ""));

  const commit = (patch: Partial<WallParts>) => {
    if (!w) return;
    const next = { ...w, ...patch };
    emit(wallToDate(next, tz));
  };

  // Raw text mode: either the user chose it, or the stored value isn't parsable.
  if (textMode || (cur != null && !date)) {
    const notParsable = cur != null && !date;
    return (
      <div className="ri-dt">
        <input
          className="ri-input"
          value={cur == null ? "" : String(cur)}
          placeholder="null"
          spellCheck={false}
          autoFocus={textMode}
          onChange={(e) => onDraft(e.target.value === "" ? null : e.target.value)}
        />
        <button
          type="button"
          className="ri-mini-btn"
          onClick={() => {
            setTextMode(false);
            setOpen(true);
          }}
          disabled={notParsable}
          title={notParsable ? "Not a parsable timestamp" : "Back to the clock editor"}
        >
          <Icon name="schedule" size={12} /> clock
        </button>
      </div>
    );
  }

  const tzLabel = (RI_TZS.find((t) => t.id === tz) ?? RI_TZS[0]!).label;
  const daysIn = w ? new Date(Date.UTC(w.y, w.mo, 0)).getUTCDate() : 30;
  const firstDow = w ? new Date(Date.UTC(w.y, w.mo - 1, 1)).getUTCDay() : 0;
  const monthName = w
    ? new Date(Date.UTC(w.y, w.mo - 1, 1)).toLocaleString("en-US", {
        month: "long",
        timeZone: "UTC",
      })
    : "";
  const shiftMonth = (dir: number) => {
    if (!w) return;
    let y = w.y;
    let mo = w.mo + dir;
    if (mo < 1) {
      mo = 12;
      y--;
    }
    if (mo > 12) {
      mo = 1;
      y++;
    }
    commit({ y, mo, d: Math.min(w.d, new Date(Date.UTC(y, mo, 0)).getUTCDate()) });
  };

  return (
    <div className="ri-dt">
      <button
        type="button"
        className={"ri-dt-display" + (open ? " open" : "")}
        onClick={() => setOpen(!open)}
      >
        <Icon name="event" size={13} style={{ color: "var(--accent)" }} />
        {date && w ? (
          <span className="ri-dt-val">
            {w.y}-{p2(w.mo)}-{p2(w.d)}
            {dateOnly ? "" : " " + p2(w.h) + ":" + p2(w.mi) + ":" + p2(w.s)}
          </span>
        ) : (
          <span className="ri-null">NULL</span>
        )}
        <span className="ri-dt-tz">{tzLabel}</span>
        <Icon
          name={open ? "expand_less" : "expand_more"}
          size={14}
          style={{ marginLeft: "auto", color: "var(--text-faint)" }}
        />
      </button>
      {open ? (
        <div className="ri-dt-panel" ref={panelRef}>
          <div className="ri-dt-toprow">
            <div className="ri-dt-tzsel">
              <button type="button" className="ri-dt-tzbtn" onClick={() => setTzOpen(!tzOpen)}>
                <Icon name="public" size={12} /> {tzLabel}
                <Icon name="expand_more" size={12} style={{ color: "var(--text-faint)" }} />
              </button>
              {tzOpen ? (
                <div className="ri-dt-tzmenu">
                  {RI_TZS.map((t) => (
                    <div
                      key={t.label}
                      className={"ri-dt-tzitem" + (tz === t.id ? " on" : "")}
                      onClick={() => {
                        setTz(t.id);
                        setTzOpen(false);
                      }}
                    >
                      {t.label}
                      {t.label === "UTC" ? <span className="ri-dt-tzdef">default</span> : null}
                      {tz === t.id ? (
                        <Icon name="check" size={12} style={{ marginLeft: "auto" }} />
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="ri-mini-btn"
              onClick={() => setTextMode(true)}
              title="Type the value as text instead"
            >
              <Icon name="edit" size={12} /> text
            </button>
            {!date ? (
              <button type="button" className="ri-mini-btn" onClick={() => emit(new Date())}>
                now
              </button>
            ) : null}
          </div>
          {date && w ? (
            <>
              <div className="ri-dt-cal">
                <div className="ri-dt-monthrow">
                  <button type="button" className="ri-nav-btn" onClick={() => shiftMonth(-1)}>
                    <Icon name="chevron_left" size={15} />
                  </button>
                  <span className="ri-dt-month">{monthName}</span>
                  <div className="ri-dt-year">
                    <button
                      type="button"
                      className="ri-dt-yrbtn"
                      onClick={() => setYrOpen(!yrOpen)}
                    >
                      {w.y}{" "}
                      <Icon name="expand_more" size={12} style={{ color: "var(--text-faint)" }} />
                    </button>
                    {yrOpen ? (
                      <div className="ri-dt-yrmenu" ref={yrListRef}>
                        <input
                          className="ri-dt-yrinput"
                          placeholder="Any year…"
                          inputMode="numeric"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const y = parseInt(e.currentTarget.value, 10);
                              if (y >= 1 && y <= 9999) {
                                commit({ y });
                                setYrOpen(false);
                              }
                            }
                          }}
                        />
                        <div className="ri-dt-yrlist">
                          {Array.from({ length: 201 }, (_, i) => 1900 + i).map((y) => (
                            <div
                              key={y}
                              className={"ri-dt-tzitem" + (y === w.y ? " on" : "")}
                              onClick={() => {
                                commit({ y });
                                setYrOpen(false);
                              }}
                            >
                              {y}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <button type="button" className="ri-nav-btn" onClick={() => shiftMonth(1)}>
                    <Icon name="chevron_right" size={15} />
                  </button>
                </div>
                <div className="ri-dt-grid">
                  {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                    <span key={"h" + i} className="ri-dt-dow">
                      {d}
                    </span>
                  ))}
                  {Array.from({ length: firstDow }, (_, i) => (
                    <span key={"b" + i} />
                  ))}
                  {Array.from({ length: daysIn }, (_, i) => (
                    <button
                      key={i}
                      type="button"
                      className={"ri-dt-day" + (w.d === i + 1 ? " on" : "")}
                      onClick={() => commit({ d: i + 1 })}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
              </div>
              {!dateOnly ? (
                <div className="ri-dt-clock">
                  <Icon name="schedule" size={14} style={{ color: "var(--text-faint)" }} />
                  <RiStepper value={w.h} max={23} onChange={(h) => commit({ h })} />
                  <span className="ri-dt-colon">:</span>
                  <RiStepper value={w.mi} max={59} onChange={(mi) => commit({ mi })} />
                  <span className="ri-dt-colon">:</span>
                  <RiStepper value={w.s} max={59} onChange={(s) => commit({ s })} />
                  <span className="ri-dt-stored">
                    stored as UTC{tz !== "UTC" ? " · " + fmtTs(date, dateOnly) : ""}
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --- one field card ---------------------------------------------------------

function RowInspectorField({
  col,
  value,
  draft,
  hasDraft,
  onDraft,
  onRevert,
  schemaName,
  tableName,
}: {
  col: InspectorColumn;
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
  const [binOpen, setBinOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  const cur = hasDraft ? draft : value;
  const dirty = hasDraft && draft !== value;
  const isNull = cur === null || cur === undefined;
  const boolCol =
    typeof value === "boolean" || /^(bool|boolean|tinyint\(1\))$/i.test((col.type || "").trim());
  const numCol = typeof value === "number";

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
    const check = validateJSON(text);
    const syncScroll = () => {
      if (taRef.current && hlRef.current) {
        hlRef.current.scrollTop = taRef.current.scrollTop;
        hlRef.current.scrollLeft = taRef.current.scrollLeft;
      }
    };
    const rowsN = Math.min(10, Math.max(3, text.split("\n").length));
    body = (
      <div className={"ri-json" + (!check.ok ? " bad" : "")}>
        <div className="ri-json-code" style={{ height: rowsN * 17 + 14 }}>
          <pre
            className="ri-json-hl"
            ref={hlRef}
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: highlightJSON(text) + "\n" }}
          />
          <textarea
            ref={taRef}
            className="ri-json-ta"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            value={text}
            placeholder="null"
            onChange={(e) => onDraft(e.target.value === "" ? null : e.target.value)}
            onScroll={syncScroll}
          />
        </div>
        <div className="ri-json-foot">
          {check.ok ? (
            <span className="ri-json-ok">
              <Icon name="check_circle" size={12} /> valid json
            </span>
          ) : (
            <span className="ri-json-err">
              <Icon name="error" size={12} /> {check.message}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="ri-mini-btn"
            disabled={!check.ok || check.empty}
            title="Pretty-print"
            onClick={() => onDraft(JSON.stringify(JSON.parse(text), null, 2))}
          >
            format
          </button>
          <button
            type="button"
            className="ri-mini-btn"
            disabled={!check.ok || check.empty}
            title="Minify"
            onClick={() => onDraft(JSON.stringify(JSON.parse(text)))}
          >
            minify
          </button>
        </div>
      </div>
    );
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
    const text = isNull ? "" : String(cur);
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
          const raw = e.target.value;
          if (raw === "") return onDraft(null);
          if (numCol && raw.trim() !== "" && !Number.isNaN(Number(raw)))
            return onDraft(Number(raw));
          onDraft(raw);
        }}
      />
    );
  }

  return (
    <div className={"ri-field" + (dirty ? " dirty" : "")}>
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
        <div className="ri-pk-lock">
          <CellContent value={value} column={col.name} type={col.type} />
          <span className="ri-pk-note">
            <Icon name="lock" size={11} /> primary key
          </span>
        </div>
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
  /** Stage the changed cells (column index → new value) into the grid's buffer. */
  onStage: (changes: Map<number, CellValue>) => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function RowInspector({
  open,
  columns,
  values,
  rowId,
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
            <button type="button" className="ri-close" title="Close (Esc)" onClick={onClose}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="ri-body">
            {columns.map((c, ci) => (
              <RowInspectorField
                key={c.name}
                col={c}
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
                  onClick={() => {
                    onStage(new Map(changes));
                    setDrafts(new Map());
                    onClose();
                  }}
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
