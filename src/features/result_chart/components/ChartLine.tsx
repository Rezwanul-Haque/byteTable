// Line chart, in SVG sized to its box (task E). Gridlines on 1/2/5 ticks with
// the zero line stronger; label ticks thinned to about one per 84px, always
// including the last; dots up to 40 points; a hover readout that snaps to the
// nearest point and flips to the left past the middle.

import { useEffect, useRef, useState, type MouseEvent } from "react";

import { useT } from "../../../shared/i18n/useT";
import { fmt, SERIES, short, ticks, type ChartSeries } from "../chartModel";

const M = { l: 54, r: 18, t: 12, b: 30 };

export function ChartLine({ data }: { data: ChartSeries }) {
  const t = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 640, h: 260 });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ w: Math.max(240, Math.round(r.width)), h: Math.max(180, Math.round(r.height)) });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = data.points;
  const iw = box.w - M.l - M.r;
  const ih = box.h - M.t - M.b;
  const all = pts.flatMap((p) => p.values);
  const tk = ticks(Math.min(0, ...all), Math.max(0, ...all), Math.max(2, Math.floor(ih / 46)));
  const lo = tk[0]!;
  const hi = tk[tk.length - 1]!;
  const X = (i: number) => M.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const Y = (v: number) => M.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(iw / 84))));
  const dots = pts.length <= 40;

  const onMove = (e: MouseEvent) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    const px = e.clientX - r.left;
    const i =
      pts.length === 1
        ? 0
        : Math.max(0, Math.min(pts.length - 1, Math.round(((px - M.l) / iw) * (pts.length - 1))));
    setHover(i);
  };
  const h = hover != null ? pts[hover] : undefined;

  return (
    <div className="ch-line" ref={wrap} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg
        width={box.w}
        height={box.h}
        role="img"
        aria-label={t("chart.aria.line", {
          names: data.names.join(", "),
          marks: t("chart.points", { count: pts.length }),
        })}
      >
        {tk.map((v) => (
          <g key={v}>
            <line
              x1={M.l}
              x2={box.w - M.r}
              y1={Y(v)}
              y2={Y(v)}
              className={"ch-grid" + (v === 0 ? " zero" : "")}
            />
            <text x={M.l - 8} y={Y(v) + 3.5} textAnchor="end" className="ch-tick">
              {short(v)}
            </text>
          </g>
        ))}
        {pts.map((p, i) =>
          i % every === 0 || i === pts.length - 1 ? (
            <text
              key={i}
              x={X(i)}
              y={box.h - 10}
              textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}
              className="ch-tick"
            >
              {p.label.length > 12 ? p.label.slice(0, 10) : p.label}
            </text>
          ) : null,
        )}
        {h && hover != null ? (
          <line x1={X(hover)} x2={X(hover)} y1={M.t} y2={M.t + ih} className="ch-guide" />
        ) : null}
        {data.names.map((name, si) => {
          const color = SERIES[si % SERIES.length];
          return (
            <g key={name + si}>
              <polyline
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={pts.map((p, i) => X(i) + "," + Y(p.values[si] ?? 0)).join(" ")}
              />
              {pts.map((p, i) =>
                dots || i === hover ? (
                  <circle
                    key={i}
                    cx={X(i)}
                    cy={Y(p.values[si] ?? 0)}
                    r={i === hover ? 4.5 : 2.6}
                    fill={color}
                    className="ch-dot"
                  />
                ) : null,
              )}
            </g>
          );
        })}
      </svg>
      {h && hover != null ? (
        <div
          className="ch-tip"
          style={X(hover) > box.w / 2 ? { right: box.w - X(hover) + 12 } : { left: X(hover) + 12 }}
        >
          <div className="ch-tip-x">{h.label}</div>
          {data.names.map((name, si) => (
            <div key={name + si} className="ch-tip-row">
              <i style={{ background: SERIES[si % SERIES.length] }} />
              <span>{name}</span>
              <b>{fmt(h.values[si] ?? 0)}</b>
            </div>
          ))}
          {h.n > 1 ? (
            <div className="ch-tip-n">{t("chart.tip.combined", { count: h.n })}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
