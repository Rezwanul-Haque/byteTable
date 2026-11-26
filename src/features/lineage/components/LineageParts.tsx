// Row lineage (M50): the small pieces the graph and its panel share — a
// table's badge, the "products · External HDD" hop pills and the field list
// with its copy buttons. Ported from the prototype's `LnBadge`, `LnHops`,
// `LnField` / `LnFields` (lineage.jsx).

import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { ColumnInfo } from "../../../shared/api/engine";
import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { CellContent } from "../../browse/shared/components/GridCell";
import { hueStyle as tc, type Hop } from "../graph";
import { badgeText, keyText, type Row } from "../model";

const ACCENT = { "--tc": "var(--accent)" } as CSSProperties;

export function LnBadge({
  table,
  size,
  accent,
}: {
  table: string;
  size?: "lg" | "xl";
  /** Wear the app accent instead of the table's colour (the centre card). */
  accent?: boolean;
}) {
  return (
    <span
      className={"ln-badge" + (size ? " " + size : "")}
      style={accent ? ACCENT : tc(table)}
      aria-hidden="true"
    >
      {badgeText(table)}
    </span>
  );
}

export function LnHops({ hops }: { hops: Hop[] }) {
  if (!hops.length) return null;
  return (
    <span className="ln-hops">
      {hops.map((h) => (
        <span
          key={h.col}
          className="ln-hop"
          style={tc(h.refTable)}
          title={h.col + " → " + h.refTable + "." + h.refCol}
        >
          <i aria-hidden="true"></i>
          <span className="ln-hop-t">{h.refTable}</span>
          <b>{h.label || "#" + keyText(h.key)}</b>
        </span>
      ))}
    </span>
  );
}

/**
 * A copy button that turns into a tick for 1.3 seconds. Copies `text` as given:
 * callers pass the REAL value, never the masked one — copy is how a cut-short
 * value comes out whole, here as everywhere else.
 */
export function LnCopy({
  text,
  title,
  label,
  className = "ln-copy",
  size = 13,
}: {
  text: string;
  title: string;
  label: string;
  className?: string;
  size?: number;
}) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    const ok = () => {
      setDone(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), 1300);
    };
    navigator.clipboard.writeText(text).then(ok, ok);
  };
  return (
    <button
      type="button"
      className={className + (done ? " copied" : "")}
      onClick={(e) => {
        e.stopPropagation();
        copy();
      }}
      title={done ? t("lineage.copied") : title}
      aria-label={done ? t("lineage.copied") : label}
    >
      <Icon name={done ? "check" : "content_copy"} size={size} />
    </button>
  );
}

function LnField({ c, row, isFk }: { c: ColumnInfo; row: Row; isFk: boolean }) {
  const t = useT();
  const v = row[c.name] ?? null;
  return (
    <div className="ln-field">
      <span className="ln-field-n" title={c.name}>
        {c.pk ? <Icon name="key" size={11} /> : isFk ? <Icon name="link" size={11} /> : null}
        {c.name}
      </span>
      <span className="ln-field-v">
        <CellContent value={v} column={c.name} type={c.dataType} />
      </span>
      {v === null ? null : (
        <LnCopy
          text={typeof v === "object" ? JSON.stringify(v) : String(v)}
          title={t("lineage.copy", { col: c.name })}
          label={t("lineage.copyAria", { col: c.name })}
        />
      )}
    </div>
  );
}

export function LnFields({
  columns,
  row,
  fkCols,
  limit,
}: {
  columns: ColumnInfo[];
  row: Row;
  fkCols: string[];
  limit?: number;
}) {
  const cols = limit ? columns.slice(0, limit) : columns;
  return (
    <div className="ln-fields">
      {cols.map((c) => (
        <LnField key={c.name} c={c} row={row} isFk={fkCols.includes(c.name)} />
      ))}
    </div>
  );
}
