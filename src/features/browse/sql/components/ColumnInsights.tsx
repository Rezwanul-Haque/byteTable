// Column insights popover (M10 §3.5). Opened from a column header's chart icon
// (shown on header hover): computes per-column statistics over the grid's
// CURRENT FILTERED SET via `columnStats` (the same `FilterSpec` the grid fetches
// with, so insights match what the user sees), then renders a 280px popover —
// "N rows shown", a stat grid (distinct, nulls + %, min, max, and avg when the
// column is numeric), and a "Most frequent" top-5 list with accent frequency
// bars scaled to the max count. Async with a small spinner; never blocks scroll.
//
// Markup + behavior ported from the prototype's grid.jsx insights popover; CSS
// is the byte-exact `.insight-*` / `.dg-popover` rules from ByteTable.html.
// Outside-click / Esc close, role=dialog, anchored + viewport-clamped.

import { useEffect, useRef, useState } from "react";

import type { ColumnStats, FilterSpec } from "../../../../shared/api/engine";
import { columnStats } from "../../../../shared/api/engine";
import { appErrorMessage } from "../../../../shared/api/error";
import { Icon } from "../../../../shared/ui/Icon";
import "./Popovers.css";

export interface InsightsAnchor {
  /** The header cell's bounding rect (drives positioning). */
  rect: DOMRect;
  /** The column the insights are for. */
  column: string;
}

/** Clamp a popover of `width`×`height` near `rect` to the viewport. */
function popoverPos(rect: DOMRect, width: number, height: number): { left: number; top: number } {
  const x = Math.min(rect.left, window.innerWidth - width - 12);
  let y = rect.bottom + 6;
  if (y + height > window.innerHeight - 8) y = Math.max(8, rect.top - height - 6);
  return { left: Math.max(8, x), top: y };
}

/** Truncate a frequency-bar label like the prototype (22 chars + ellipsis). */
function truncLabel(s: string): string {
  return s.length > 22 ? s.slice(0, 22) + "…" : s;
}

export function ColumnInsights({
  handleId,
  schema,
  table,
  filter,
  anchor,
  onClose,
}: {
  handleId: string;
  schema: string;
  table: string;
  /** The grid's current applied filter — stats are computed over this set. */
  filter: FilterSpec | null;
  anchor: InsightsAnchor;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<ColumnStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { column } = anchor;

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setStats(null);
      setError(null);
      try {
        const s = await columnStats(handleId, { schema, table, column, filter });
        if (!alive) return;
        setStats(s);
        setLoading(false);
      } catch (err: unknown) {
        if (!alive) return;
        setError(appErrorMessage(err, "Could not compute insights."));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [handleId, schema, table, column, filter]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current && popRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const pos = popoverPos(anchor.rect, 280, 300);
  const maxCount = stats && stats.top.length ? stats.top[0]!.count : 0;
  const nullPct = stats && stats.total ? Math.round((stats.nulls / stats.total) * 100) : 0;

  return (
    <div
      ref={popRef}
      className="dg-popover insight-pop"
      style={pos}
      role="dialog"
      aria-label={"Insights for " + column}
    >
      <div className="dg-pop-title">
        <Icon name="monitoring" size={14} style={{ color: "var(--accent)" }} />
        <span className="dg-pop-mono">{column}</span>
        {stats ? <span className="dg-pop-dim">{stats.total} rows shown</span> : null}
      </div>

      {loading ? (
        <div className="dg-pop-loading">
          <span className="dg-pop-spinner" />
          <span className="dg-pop-dim">Computing…</span>
        </div>
      ) : error ? (
        <div className="dg-pop-empty">{error}</div>
      ) : stats ? (
        <>
          <div className="insight-stats">
            <div className="insight-stat">
              <span>distinct</span>
              <b>{stats.distinct}</b>
            </div>
            <div className="insight-stat">
              <span>nulls</span>
              <b>
                {stats.nulls} ({nullPct}%)
              </b>
            </div>
            {stats.min !== null ? (
              <div className="insight-stat">
                <span>min</span>
                <b title={String(stats.min)}>{String(stats.min)}</b>
              </div>
            ) : null}
            {stats.max !== null ? (
              <div className="insight-stat">
                <span>max</span>
                <b title={String(stats.max)}>{String(stats.max)}</b>
              </div>
            ) : null}
            {stats.numeric && stats.avg !== null ? (
              <div className="insight-stat">
                <span>avg</span>
                <b>{stats.avg}</b>
              </div>
            ) : null}
          </div>

          {stats.top.length ? (
            <div className="insight-bars">
              <div className="dg-pop-dim" style={{ marginBottom: 5 }}>
                Most frequent
              </div>
              {stats.top.map((entry, i) => {
                const label = String(entry.value);
                return (
                  <div className="insight-bar-row" key={label + ":" + i}>
                    <span className="insight-bar-label" title={label}>
                      {truncLabel(label)}
                    </span>
                    <span className="insight-bar-track">
                      <span
                        className="insight-bar-fill"
                        style={{ width: Math.max(4, (entry.count / maxCount) * 100) + "%" }}
                      />
                    </span>
                    <span className="insight-bar-n">{entry.count}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
