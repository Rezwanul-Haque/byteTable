// The Chart view of a query result (M46) — ported from the prototype's
// chart.jsx (ResultChart). Controls, notes, the plot and a footer that says
// what is charted. Charts the rows the result already holds: nothing is
// re-queried, and a result cut by the row limit is charted as cut.
//
// SETTINGS are local and keyed by the column list: a re-run that returns the
// same columns keeps them (change a WHERE, keep the chart); a different column
// list starts from a fresh suggestion (task B3).

import { Fragment, useId, useMemo, useState } from "react";

import type { CellValue, ColumnMeta } from "../../../shared/api/engine";
import { fmtNumber } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import { Select } from "../../../shared/ui/Select";
import {
  columnsSig,
  donutSlices,
  donutUnfit,
  firstCfg,
  MAX_BARS,
  MAX_SLICES,
  MAX_SERIES,
  profile,
  SERIES,
  type Agg,
  type ChartCfg,
  type SortMode,
} from "../chartModel";
import { useChartSeries } from "../hooks/useChartSeries";
import { ChartBars } from "./ChartBars";
import { ChartDonut } from "./ChartDonut";
import { ChartLine } from "./ChartLine";
import "./ResultChart.css";

/** **bold** spans in a note. Raw text, never HTML. */
function Bold({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(\*\*[^*]+\*\*)/)
        .map((p, i) =>
          p.startsWith("**") && p.endsWith("**") && p.length > 3 ? (
            <b key={i}>{p.slice(2, -2)}</b>
          ) : (
            <Fragment key={i}>{p}</Fragment>
          ),
        )}
    </>
  );
}

const UNFIT_KEY = {
  series: "chart.donut.unfit.series",
  agg: "chart.donut.unfit.agg",
  negative: "chart.donut.unfit.negative",
  empty: "chart.donut.unfit.empty",
} as const;

const TYPE_ICON = { bar: "bar_chart", line: "show_chart", donut: "donut_large" } as const;
const TYPE_KEY = {
  bar: "chart.type.bar",
  line: "chart.type.line",
  donut: "chart.type.donut",
} as const;

const AGG_KEY = {
  sum: "chart.agg.sum",
  avg: "chart.agg.avg",
  min: "chart.agg.min",
  max: "chart.agg.max",
} as const;

export function ResultChart({ columns, rows }: { columns: ColumnMeta[]; rows: CellValue[][] }) {
  const t = useT();
  // Field captions name their dropdowns (Select is a button, not a <select>,
  // so a wrapping <label> would not label it — and would open it on click).
  const ids = useId();
  const cols = useMemo(() => profile(columns, rows), [columns, rows]);
  const sig = columnsSig(columns);
  const [state, setState] = useState<{ sig: string; cfg: ChartCfg }>(() => ({
    sig,
    cfg: firstCfg(cols, rows),
  }));
  // A new column list: start over from a fresh suggestion (derived state, so
  // the stale settings never paint).
  if (state.sig !== sig) setState({ sig, cfg: firstCfg(cols, rows) });
  const cfg = state.sig === sig ? state.cfg : firstCfg(cols, rows);
  const set = (patch: Partial<ChartCfg>) => setState({ sig, cfg: { ...cfg, ...patch } });

  const numeric = cols.filter((c) => c.kind === "number" && c.index !== cfg.x);
  const xKind = cfg.x == null ? undefined : cols[cfg.x]?.kind;
  const ys = cfg.ys.filter((y) => numeric.some((c) => c.index === y));
  const useCount = cfg.count || ys.length === 0;
  const colNames = useMemo(() => columns.map((c) => c.name), [columns]);
  const drawn: ChartCfg = { ...cfg, ys, count: useCount };
  const data = useChartSeries(
    rows,
    drawn,
    xKind,
    t("chart.rowN", { n: "{n}" }),
    t("chart.rowCount"),
    colNames,
  );

  if (rows.length === 0) {
    return (
      <div className="ch-empty">
        <Icon name="bar_chart" size={28} />
        <div>{t("chart.empty.title")}</div>
        <p>{t("chart.empty.body")}</p>
      </div>
    );
  }

  // Values chips (C2): at most four; a fifth drops the oldest; unticking the
  // last switches to row count; row count replaces the value columns.
  const toggleY = (index: number) => {
    const on = ys.includes(index) && !useCount;
    const base = useCount ? [] : ys;
    const next = on ? base.filter((y) => y !== index) : [...base, index].slice(-MAX_SERIES);
    set({ ys: next, count: next.length === 0 });
  };
  const toggleCount = () => {
    if (useCount && numeric.length) set({ count: false, ys: [numeric[0]!.index] });
    else set({ count: true });
  };

  // A donut needs one series of totals; when the data stops fitting (a second
  // value ticked, average chosen) the chart falls back to bars and the button
  // says why, instead of drawing a misleading part-of-whole.
  const unfit = data ? donutUnfit(data, drawn) : null;
  const type = cfg.type === "donut" && unfit ? "bar" : cfg.type;
  const labelName = cfg.x == null ? t("chart.rowNumber") : (columns[cfg.x]?.name ?? "");
  const marksKey =
    type === "bar" ? "chart.bars" : type === "line" ? "chart.points" : "chart.slices";
  const capped = data != null && type === "bar" && data.total > MAX_BARS;
  const folded = data != null && type === "donut" ? donutSlices(data, "").folded : 0;

  return (
    <div className="ch">
      <div className="ch-controls">
        <div className="ch-seg" role="radiogroup" aria-label={t("chart.type.aria")}>
          {(["bar", "line", "donut"] as const).map((kind) => {
            const off = kind === "donut" && unfit != null;
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={type === kind}
                className={type === kind ? "on" : ""}
                disabled={off}
                title={off ? t(UNFIT_KEY[unfit]) : undefined}
                onClick={() => set({ type: kind })}
              >
                <Icon
                  name={TYPE_ICON[kind]}
                  size={14}
                  style={kind === "bar" ? { transform: "rotate(90deg) scaleX(-1)" } : undefined}
                />{" "}
                {t(TYPE_KEY[kind])}
              </button>
            );
          })}
        </div>
        <div className="ch-field">
          <span id={ids + "label"}>{t("chart.label")}</span>
          <Select
            className="ch-sel"
            aria-labelledby={ids + "label"}
            value={cfg.x == null ? "" : String(cfg.x)}
            onChange={(v) => set({ x: v === "" ? null : Number(v) })}
            options={[
              { value: "", label: t("chart.rowNumber") },
              ...cols.map((c) => ({ value: String(c.index), label: c.name })),
            ]}
          />
        </div>
        <div className="ch-field">
          <span>{t("chart.values")}</span>
          <div className="ch-chips" role="group" aria-label={t("chart.valuesAria")}>
            {numeric.map((c) => {
              const at = ys.indexOf(c.index);
              const on = at >= 0 && !useCount;
              return (
                <button
                  key={c.index}
                  type="button"
                  className={"ch-chip" + (on ? " on" : "")}
                  aria-pressed={on}
                  onClick={() => toggleY(c.index)}
                >
                  {on ? <i style={{ background: SERIES[at % SERIES.length] }} /> : null}
                  {c.name}
                </button>
              );
            })}
            <button
              type="button"
              className={"ch-chip" + (useCount ? " on" : "")}
              aria-pressed={useCount}
              onClick={toggleCount}
              title={t("chart.rowCountTitle")}
            >
              {useCount ? <i style={{ background: SERIES[0] }} /> : null}
              {t("chart.rowCount")}
            </button>
          </div>
        </div>
        {data?.grouped && !useCount ? (
          <div className="ch-field">
            <span id={ids + "agg"}>{t("chart.combine")}</span>
            <Select<Agg>
              className="ch-sel"
              aria-labelledby={ids + "agg"}
              value={cfg.agg}
              onChange={(agg) => set({ agg })}
              options={(["sum", "avg", "min", "max"] as const).map((a) => ({
                value: a,
                label: t(AGG_KEY[a]),
              }))}
            />
          </div>
        ) : null}
        {type === "bar" && (xKind === "text" || xKind === "bool") ? (
          <div className="ch-field">
            <span id={ids + "sort"}>{t("chart.order")}</span>
            <Select<SortMode>
              className="ch-sel"
              aria-labelledby={ids + "sort"}
              value={cfg.sort}
              onChange={(sort) => set({ sort })}
              options={[
                { value: "asis", label: t("chart.order.asis") },
                { value: "value", label: t("chart.order.value") },
              ]}
            />
          </div>
        ) : null}
      </div>

      {data && (data.grouped || capped || folded > 0 || data.lopsided) ? (
        <div className="ch-notes">
          {data.grouped ? (
            <span>
              <Icon name="info" size={13} />{" "}
              <span>
                <Bold
                  text={t(useCount ? "chart.note.counted" : "chart.note.combined", {
                    label: labelName,
                    agg: t(AGG_KEY[cfg.agg]),
                    rows: t("chart.rows", { count: rows.length }),
                    marks: t(marksKey, { count: data.total }),
                  })}
                />
              </span>
            </span>
          ) : null}
          {data.lopsided ? (
            <span>
              <Icon name="info" size={13} />{" "}
              <span>
                <Bold text={t("chart.note.lopsided", data.lopsided)} />
              </span>
            </span>
          ) : null}
          {folded > 0 ? (
            <span>
              <Icon name="info" size={13} />{" "}
              <span>
                {t("chart.note.donutFolded", {
                  max: MAX_SLICES,
                  total: fmtNumber(data.total),
                })}
              </span>
            </span>
          ) : null}
          {capped ? (
            <span>
              <Icon name="info" size={13} />{" "}
              <span>{t("chart.note.capped", { max: MAX_BARS, total: fmtNumber(data.total) })}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="ch-plot">
        {data == null ? (
          <div className="ch-empty" role="status">
            <Icon name="hourglass_top" size={24} />
            <div>{t("chart.preparing")}</div>
          </div>
        ) : type === "bar" ? (
          <ChartBars data={data} labelName={labelName} />
        ) : type === "line" ? (
          <ChartLine data={data} />
        ) : (
          <ChartDonut data={data} labelName={labelName} />
        )}
      </div>
      <div className="ch-foot">
        <span className="ch-legend">
          {/* A donut names its slices beside the ring; the series legend is
              for bars and lines. */}
          {(type === "donut" ? [] : (data?.names ?? [])).map((name, i) => (
            <span key={name + i}>
              <i style={{ background: SERIES[i % SERIES.length] }} />
              {name}
            </span>
          ))}
        </span>
        <span className="ch-foot-n">
          {t("chart.foot", { rows: t("chart.rows", { count: rows.length }) })}
        </span>
      </div>
    </div>
  );
}
