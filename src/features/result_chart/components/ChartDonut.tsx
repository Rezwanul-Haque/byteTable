// Donut chart: what share each label holds (a yes/no, a handful of statuses).
// One series of non-negative totals only — the caller checks `donutUnfit`.
// The largest MAX_SLICES slices are drawn, the rest fold into "Other"; the
// legend beside it names every slice with its value and percentage, so the
// colours never carry the meaning alone.

import { useState } from "react";

import { fmtNumber } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { donutSlices, fmt, OTHER_COLOR, SLICES, type ChartSeries } from "../chartModel";

const R = 46;
const C = 2 * Math.PI * R;

const pct = (share: number) =>
  fmtNumber(share, { style: "percent", maximumFractionDigits: share < 0.1 ? 1 : 0 });

export function ChartDonut({ data, labelName }: { data: ChartSeries; labelName: string }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const { slices, total } = donutSlices(data, t("chart.donut.other"));
  const color = (i: number) => (slices[i]!.other ? OTHER_COLOR : SLICES[i % SLICES.length]);
  // A hairline gap between slices, none for a single full ring.
  const gap = slices.length > 1 ? 0.8 : 0;
  // Where each slice's arc starts along the ring: the running sum before it.
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((a, x) => a + x.share * C, 0));

  return (
    <div className="ch-donut">
      {/* The ring is the picture; the legend beside it is the readable data. */}
      <svg
        viewBox="0 0 120 120"
        className="ch-donut-svg"
        role="img"
        aria-label={t("chart.aria.donut", {
          name: data.names[0] ?? "",
          label: labelName,
          marks: t("chart.slices", { count: slices.length }),
        })}
      >
        <circle cx="60" cy="60" r={R} className="ch-donut-track" />
        {slices.map((s, i) => {
          const len = Math.max(0, s.share * C - gap);
          return (
            <circle
              key={i}
              cx="60"
              cy="60"
              r={R}
              className={"ch-donut-arc" + (hover === i ? " on" : hover != null ? " dim" : "")}
              stroke={color(i)}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-starts[i]!}
              transform="rotate(-90 60 60)"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        <text x="60" y="58" textAnchor="middle" className="ch-donut-total">
          {fmt(hover != null ? slices[hover]!.value : total)}
        </text>
        <text x="60" y="72" textAnchor="middle" className="ch-donut-sub">
          {hover != null ? pct(slices[hover]!.share) : (data.names[0] ?? "")}
        </text>
      </svg>
      <ul className="ch-donut-legend">
        {slices.map((s, i) => (
          <li
            key={i}
            className={hover === i ? "on" : undefined}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <i style={{ background: color(i) }} />
            <span className="ch-donut-label" title={s.label}>
              {s.label}
            </span>
            <span className="ch-donut-val">{fmt(s.value)}</span>
            <span className="ch-donut-pct">{pct(s.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
