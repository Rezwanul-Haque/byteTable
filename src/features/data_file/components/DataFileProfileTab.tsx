// Column profile (M35 Task 5) — ported from the prototype's `CsvProfileCard` /
// `CsvProfileTab`.
//
// One card per column, always for EVERY column: hiding a column removes it from
// the Data grid, never from its profile. Each card answers "what is in here and
// how clean is it" — the type, a valid/off-type/empty bar, the stats that make
// sense for that type, and either a distribution (numeric) or the values that
// actually occur (everything else).

import { Fragment, useEffect, useRef } from "react";

import { Icon } from "../../../shared/ui/Icon";
import { useT } from "../../../shared/i18n/useT";
import { TYPES, type ColumnProfile } from "../core";
import type { DataFileDoc } from "../doc";

const pct = (x: number): number => Math.round(x * 100);

/**
 * A number for a stat cell: thousands separators once it is worth them, and at
 * most four decimals otherwise (trailing zeros trimmed).
 */
function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(+n.toFixed(4));
}

/** One `label — value` row of the stat grid. */
function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="csvv-pstat">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

export function DataFileProfileCard({ col, focused }: { col: ColumnProfile; focused: boolean }) {
  const t = useT();
  const meta = TYPES[col.type];
  const maxTop = col.top[0]?.n ?? 1;
  const maxBin = col.hist ? Math.max(...col.hist.map((b) => b.n)) : 1;
  const ref = useRef<HTMLDivElement>(null);

  // Scroll the focused card into view — the sidebar's column click and the
  // issue cards' "Column" action both land here.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <div className={"csvv-card" + (focused ? " focused" : "")} ref={ref}>
      <div className="csvv-card-head">
        <Icon name={meta.icon} size={15} style={{ color: meta.color }} />
        <span className="csvv-card-name" title={col.name}>
          {col.name}
        </span>
        <span className="csvv-type" style={{ color: meta.color }}>
          {col.type}
        </span>
        {col.unique && col.present ? (
          <span className="csvv-badge">{t("dfile.uniqueBadge")}</span>
        ) : null}
        {col.bad.length ? (
          <span className="csvv-badge bad">{t("dfile.badN", { count: col.bad.length })}</span>
        ) : null}
      </div>

      <div className="csvv-stack" title={t("dfile.fillPct", { pct: pct(col.fill) })}>
        <span
          className="ok"
          style={{ width: Math.max(0, pct((col.present - col.bad.length) / col.count)) + "%" }}
        />
        <span className="bad" style={{ width: pct(col.bad.length / col.count) + "%" }} />
        <span className="nul" style={{ width: pct(col.nulls / col.count) + "%" }} />
      </div>
      <div className="csvv-stack-legend">
        <span>
          <i className="ok" />
          {(col.present - col.bad.length).toLocaleString()} {t("dfile.valid")}
        </span>
        {col.bad.length ? (
          <span>
            <i className="bad" />
            {col.bad.length.toLocaleString()} {t("dfile.offType")}
          </span>
        ) : null}
        <span>
          <i className="nul" />
          {col.nulls.toLocaleString()} {t("dfile.emptyStat")}
        </span>
      </div>

      <div className="csvv-pstats">
        <Stat k={t("dfile.statDistinct")} v={col.distinct.toLocaleString()} />
        <Stat k={t("dfile.statFilled")} v={pct(col.fill) + "%"} />
        {col.stats ? (
          <Fragment>
            <Stat k={t("dfile.statMin")} v={fmtNum(col.stats.min)} />
            <Stat k={t("dfile.statMax")} v={fmtNum(col.stats.max)} />
            <Stat k={t("dfile.statMean")} v={fmtNum(col.stats.mean)} />
            <Stat k={t("dfile.statMedian")} v={fmtNum(col.stats.median)} />
            <Stat k={t("dfile.statSum")} v={fmtNum(col.stats.sum)} />
            <Stat k={t("dfile.statP95")} v={fmtNum(col.stats.p95)} />
          </Fragment>
        ) : null}
        {col.range ? (
          <Fragment>
            <Stat k={t("dfile.statEarliest")} v={col.range.min.slice(0, 19).replace("T", " ")} />
            <Stat k={t("dfile.statLatest")} v={col.range.max.slice(0, 19).replace("T", " ")} />
          </Fragment>
        ) : null}
        {col.bools ? (
          <Fragment>
            <Stat k={t("dfile.statTrue")} v={col.bools.t.toLocaleString()} />
            <Stat k={t("dfile.statFalse")} v={col.bools.f.toLocaleString()} />
          </Fragment>
        ) : null}
        {col.len && !col.stats ? (
          <Fragment>
            <Stat k={t("dfile.statLength")} v={col.len.min + "–" + col.len.max} />
            <Stat k={t("dfile.statAvgLength")} v={col.len.avg.toFixed(1)} />
          </Fragment>
        ) : null}
      </div>

      {col.hist ? (
        <div className="csvv-hist" title={t("dfile.histTitle")}>
          {col.hist.map((b, i) => (
            <span
              key={i}
              style={{ height: Math.max(2, (b.n / maxBin) * 100) + "%", background: meta.color }}
              title={t("dfile.binRows", { x0: fmtNum(b.x0), x1: fmtNum(b.x1), count: b.n })}
            />
          ))}
        </div>
      ) : null}

      {!col.hist && col.top.length ? (
        <div className="csvv-top">
          {col.top.map((tv) => (
            <div className="csvv-top-row" key={tv.v}>
              <span className="csvv-top-v" title={tv.v}>
                {tv.v}
              </span>
              <span className="csvv-top-bar">
                <i
                  style={{
                    width: Math.max(3, (tv.n / maxTop) * 100) + "%",
                    background: meta.color,
                  }}
                />
              </span>
              <span className="csvv-top-n">{tv.n}</span>
            </div>
          ))}
          {col.distinct > col.top.length ? (
            <div className="csvv-top-more">
              {t("dfile.moreDistinct", { count: (col.distinct - col.top.length).toLocaleString() })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DataFileProfileTab({ doc, focus }: { doc: DataFileDoc; focus: string | null }) {
  const t = useT();
  return (
    <div className="csvv-pane csvv-scroll" data-screen-label={"Column profile: " + doc.name}>
      <div className="csvv-pane-head">
        <Icon name="insights" size={15} style={{ color: "var(--accent)" }} />
        <h3>{t("dfile.tabProfile")}</h3>
        <span className="csvv-pane-note">
          {t("dfile.profileNote", {
            cols: doc.analysis.cols.length,
            rows: doc.parsed.rows.length.toLocaleString(),
          })}
        </span>
      </div>
      <div className="csvv-cards">
        {doc.analysis.cols.map((c) => (
          <DataFileProfileCard key={c.name} col={c} focused={focus === c.name} />
        ))}
      </div>
    </div>
  );
}
