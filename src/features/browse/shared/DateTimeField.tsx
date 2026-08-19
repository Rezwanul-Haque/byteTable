// DateTimeField — the calendar + clock editor for a temporal value: UTC by
// default with a timezone switcher, a year picker, hour/minute/second steppers,
// and a raw-text escape hatch for anything it cannot parse.
//
// Shared by the SQL row inspector (`browse/sql/components/RowInspector`) and the
// DynamoDB item drawer (`browse/dynamo/components/DynamoItemDrawer`), which are
// otherwise separate components. It lives in `browse/shared` so neither engine
// slice imports from the other — the same reason the helpers it drives
// (`dateTimeCell.ts`) are already here.
//
// The two engines disagree about STORAGE, which is why `parse` and `emitValue`
// are injectable rather than baked in:
//
//   • SQL columns declare their shape, so the default `parseTs` / `fmtTs` pair
//     reads and writes `2026-04-07 16:30:00` (+ a `+00` tag for timestamptz).
//   • DynamoDB has no date type — a timestamp is an ISO-8601 string — and
//     `parseTs` stops at the seconds, so it would read `…T16:30:00+06:00` as
//     16:30 UTC when it is really 10:30. The drawer passes its own ISO-safe pair.

import { useEffect, useRef, useState } from "react";

import type { CellValue } from "../../../shared/api/engine";
import { Icon } from "../../../shared/ui/Icon";
import {
  RI_TZS,
  fmtTs,
  isDateOnlyType,
  isTzAwareType,
  p2,
  parseTs,
  tzParts,
  wallToDate,
  type WallParts,
} from "./dateTimeCell";
import "./CellEditors.css";
import "./DateTimeField.css";

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

/**
 * Calendar + clock editor for a temporal value, UTC by default and timezone
 * switchable, with a raw-text escape hatch.
 *
 * Exported because DynamoDB's item drawer needs the same editor. It cannot use
 * the same STORAGE format though: `fmtTs` writes SQL's `2026-04-07 16:30:00`,
 * and `parseTs` stops at the seconds so it reads a timezone offset as if it were
 * UTC. Both are fine for a SQL column whose type declares the shape, and both
 * would quietly corrupt a DynamoDB ISO-8601 string. So the parse and the emit
 * are injectable; omit them and the SQL behaviour is unchanged.
 */
export function RiDateTime({
  type,
  cur,
  onDraft,
  parse,
  emitValue,
}: {
  type: string;
  cur: CellValue;
  onDraft: (v: CellValue) => void;
  /** Read the stored value as a Date. Defaults to `parseTs` (SQL literals). */
  parse?: (v: CellValue) => Date | null;
  /** Render a Date back to storage. Defaults to `fmtTs` + the tz-aware suffix. */
  emitValue?: (d: Date) => string;
}) {
  const [open, setOpen] = useState(false);
  const [tz, setTz] = useState("UTC");
  const [tzOpen, setTzOpen] = useState(false);
  const [yrOpen, setYrOpen] = useState(false);
  const [textMode, setTextMode] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const yrListRef = useRef<HTMLDivElement>(null);

  // Close the panel on a click outside this picker (so opening a second date
  // field's panel closes this one). Uses `click`, not `mousedown`: the clicked
  // button's onClick (which opens its own panel) runs first, then this closes
  // the other. Closing on mousedown would collapse this panel and shift a lower
  // button out from under the pointer before its click could register.
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setTzOpen(false);
        setYrOpen(false);
      }
    };
    window.addEventListener("click", onClickOutside);
    return () => window.removeEventListener("click", onClickOutside);
  }, [open]);

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
  const date = (parse ?? parseTs)(cur);
  const w: WallParts | null = date ? tzParts(date, tz) : null;

  // Store the wall-time converted to UTC, tagged `+00` for tz-aware columns.
  const emit = (d: Date) =>
    onDraft(emitValue ? emitValue(d) : fmtTs(d, dateOnly) + (tzAware ? "+00" : ""));

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
        {cur != null ? (
          <button
            type="button"
            className="ri-mini-btn"
            onClick={() => onDraft(null)}
            title="Clear this field — stages NULL"
          >
            <Icon name="block" size={12} /> null
          </button>
        ) : null}
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
    <div className="ri-dt" ref={rootRef}>
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
            {date ? (
              <button
                type="button"
                className="ri-mini-btn"
                onClick={() => onDraft(null)}
                title="Clear this field — stages NULL"
              >
                <Icon name="block" size={12} /> null
              </button>
            ) : (
              <button type="button" className="ri-mini-btn" onClick={() => emit(new Date())}>
                now
              </button>
            )}
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
