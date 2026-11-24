// Horizontal bar chart, in HTML (task D). One row per label, one shared scale
// from min(0, lowest) to max(0, highest); bars grow from zero, negatives to
// the left. At most MAX_BARS labels, after sorting.

import { useT } from "../../../shared/i18n/useT";
import { fmt, MAX_BARS, SERIES, type ChartSeries } from "../chartModel";

export function ChartBars({ data, labelName }: { data: ChartSeries; labelName: string }) {
  const t = useT();
  const pts = data.points.slice(0, MAX_BARS);
  const all = pts.flatMap((p) => p.values);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const span = hi - lo || 1;
  const zero = ((0 - lo) / span) * 100;
  const multi = data.names.length > 1;
  return (
    <div
      className="ch-bars"
      role="img"
      aria-label={t("chart.aria.bar", {
        names: data.names.join(", "),
        label: labelName,
        marks: t("chart.bars", { count: pts.length }),
      })}
    >
      {pts.map((p) => (
        <div key={p.label} className="ch-bar-row">
          <div className="ch-bar-label" title={p.label}>
            {p.label}
          </div>
          <div className="ch-bar-tracks">
            {p.values.map((v, i) => {
              const w = (Math.abs(v) / span) * 100;
              const name = data.names[i] ?? "";
              return (
                <div
                  key={i}
                  className={"ch-bar-track" + (multi ? " thin" : "")}
                  title={
                    t("chart.barTitle", { name, value: fmt(v) }) +
                    (p.n > 1 ? " · " + t("chart.rows", { count: p.n }) : "")
                  }
                >
                  <i
                    style={{
                      left: (v < 0 ? zero - w : zero) + "%",
                      width: Math.max(0.4, w) + "%",
                      background: SERIES[i % SERIES.length],
                    }}
                  />
                  <span
                    className="ch-bar-val"
                    style={
                      v < 0
                        ? { right: 100 - (zero - w) + "%", marginRight: 6 }
                        : { left: zero + w + "%", marginLeft: 6 }
                    }
                  >
                    {fmt(v)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
