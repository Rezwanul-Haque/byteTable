// Table overview — a card per table, showing what the engine already believes
// about each one.
//
// ESTIMATES, ON PURPOSE. Every number comes from catalog statistics the engine
// keeps for its own planner — Postgres `pg_class.reltuples`, MySQL
// `information_schema.TABLES.TABLE_ROWS` — fetched once by `list_tables` and
// cached in the introspection store. Opening this tab therefore runs NO query:
// not one `COUNT(*)`, not one scan. On a large database that is the whole point,
// because counting every table exactly could take minutes to answer a question
// ("what is big here?") that a free estimate answers well enough.
//
// The price is accuracy, and the tab says so rather than presenting estimates as
// fact: a planner estimate drifts between ANALYZE runs, and a table that has
// never been analyzed has none at all (Postgres reports -1, shown as "no
// estimate" — never as 0, which would be a lie).
//
// Exact per-column numbers deliberately live elsewhere. The grid's column-header
// insights popover (M10 `column_stats`) already gives distinct / nulls / min /
// max / mean / most-frequent for ONE column, on demand, where the user is
// already looking. Repeating that per column here would mean an aggregate pass
// per column per table — dozens of full scans to render a tab that exists
// precisely because it costs nothing.

import type React from "react";
import { useMemo, useState } from "react";

import { Icon } from "../../../../shared/ui/Icon";
import type { TableInfo } from "../../../../shared/api/engine";
import { tablesKey, useIntrospectionStore } from "../../../introspection/state";
import { useWorkspacesStore } from "../../../workspaces/state";
import type { TableOverviewView, Workspace } from "../../../workspaces/types";
import "./TableOverview.css";

/** One table's card data. */
interface Card {
  name: string;
  rows: number | null;
  /** Share of the schema's estimated total, 0–1 — the card's meter. */
  share: number;
  /** Rank by estimated rows among tables that have an estimate (1-based). */
  rank: number | null;
  /** The catalog row itself, for the size / engine / collation / comment line. */
  info: TableInfo;
}

/**
 * This table's share of the schema's estimated ROW COUNT — not of its bytes.
 * A table of few but very wide rows is understated by this, and the label says
 * "rows" for exactly that reason.
 *
 * The denominator is the total across tables that HAVE an estimate, so the
 * label says "estimated rows", not "all rows": on Postgres, where a table stays
 * un-analyzed until autovacuum reaches it, one analyzed table among seven would
 * otherwise claim "100% of all rows" while six unknowns sit beside it.
 *
 * With fewer than two estimates there is no share worth stating — one table
 * being 100% of itself is noise — so it returns nothing.
 *
 * Anything under half a percent reads "<1%" rather than rounding to a bare
 * "0%", which looks like a bug on a table that plainly has rows.
 */
function sharePct(rows: number, total: number, known: number): string {
  if (total <= 0 || known < 2) return "";
  const pct = (rows / total) * 100;
  if (pct > 0 && pct < 0.5) return "<1% of estimated rows";
  return Math.round(pct) + "% of estimated rows";
}

/** Bytes as KB/MB/GB, the way a catalog listing reads them. */
function bytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  if (n < 1024 * 1024 * 1024)
    return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

/** Compact row counts: 12, 4.2K, 1.3M, 2.1B. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + "M";
  return (n / 1_000_000_000).toFixed(1) + "B";
}

/** Columns the table layout can sort by. */
type SortKey = "name" | "rows" | "total" | "data" | "index";

export function TableOverview({
  workspace,
  schema,
  view,
  onViewChange,
}: {
  workspace: Workspace;
  schema: string;
  view: TableOverviewView;
  onViewChange: (view: TableOverviewView) => void;
}) {
  const handleId = workspace.handleId;
  const entry = useIntrospectionStore((s) => s.tables[tablesKey(handleId, schema)]);
  const loadTables = useIntrospectionStore((s) => s.loadTables);
  const openTableTab = useWorkspacesStore((s) => s.openTableTab);
  const tables = entry?.tables ?? null;
  // Table-layout sort. Defaults to biggest-first, matching the card order and
  // the question the tab exists to answer.
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "rows", dir: -1 });
  const { cards, total, known, unknown } = useMemo(() => {
    const list = tables ?? [];
    const counted = list.filter((t) => t.approxRowCount != null);
    const max = counted.reduce((m, t) => Math.max(m, t.approxRowCount ?? 0), 0);
    const ranked = [...counted].sort((a, b) => (b.approxRowCount ?? 0) - (a.approxRowCount ?? 0));
    const rankOf = new Map(ranked.map((t, i) => [t.name, i + 1]));
    const cards: Card[] = list
      .map((t) => ({
        name: t.name,
        rows: t.approxRowCount,
        share: max > 0 && t.approxRowCount != null ? t.approxRowCount / max : 0,
        rank: rankOf.get(t.name) ?? null,
        info: t,
      }))
      // Biggest first — the sidebar already gives the alphabetical view, and the
      // question a size profile answers is which tables dominate.
      .sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1) || a.name.localeCompare(b.name));
    return {
      cards,
      total: counted.reduce((n, t) => n + (t.approxRowCount ?? 0), 0),
      known: counted.length,
      unknown: list.length - counted.length,
    };
  }, [tables]);

  // Which optional columns any table actually reports. Rendering an all-empty
  // `engine` column on Postgres would be noise, so those columns are dropped.
  const has = useMemo(
    () => ({
      engine: cards.some((c) => c.info.engine),
      collation: cards.some((c) => c.info.collation),
      comment: cards.some((c) => c.info.comment),
      sizes: cards.some((c) => c.info.totalBytes != null),
    }),
    [cards],
  );

  const sorted = useMemo(() => {
    const val = (c: (typeof cards)[number]): number | string =>
      sort.key === "name"
        ? c.name
        : sort.key === "rows"
          ? (c.rows ?? -1)
          : sort.key === "total"
            ? (c.info.totalBytes ?? -1)
            : sort.key === "data"
              ? (c.info.dataBytes ?? -1)
              : (c.info.indexBytes ?? -1);
    return [...cards].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      const cmp =
        typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return cmp * sort.dir || a.name.localeCompare(b.name);
    });
  }, [cards, sort]);

  /**
   * ONE explicit track list, shared by the header and every row through a CSS
   * variable — the same mechanism the data grid uses (`--grid-cols`).
   *
   * Each row was previously its own grid with an `auto-fit`/`auto` template, so
   * tracks were sized per row from that row's own content: the header's columns
   * landed in different places from the body's, and no two rows agreed either.
   */
  const cols = [
    "minmax(180px, 1.4fr)", // name
    "110px", // est. rows
    ...(has.sizes ? ["100px", "100px", "100px"] : []),
    ...(has.engine ? ["110px"] : []),
    ...(has.collation ? ["170px"] : []),
    ...(has.comment ? ["minmax(0, 1fr)"] : []),
  ].join(" ");

  const th = (key: SortKey, label: string, extra?: string) => (
    <button
      type="button"
      className={"tov-th" + (extra ? " " + extra : "") + (sort.key === key ? " sorted" : "")}
      onClick={() =>
        setSort((cur) =>
          // Re-clicking the active column flips it; a new column starts
          // descending for the numbers and ascending for the name.
          cur.key === key
            ? { key, dir: (cur.dir === 1 ? -1 : 1) as 1 | -1 }
            : { key, dir: key === "name" ? 1 : -1 },
        )
      }
    >
      {label}
      {sort.key === key ? (
        <Icon name={sort.dir === 1 ? "arrow_upward" : "arrow_downward"} size={12} />
      ) : null}
    </button>
  );

  return (
    <div className="tov" data-screen-label={"Table overview: " + schema}>
      <div className="tov-head">
        <Icon name="monitoring" size={17} style={{ color: "var(--accent)" }} />
        <div className="tov-head-title">
          <span className="tov-head-main">Table overview</span>
          <span className="tov-head-sub">{schema}</span>
        </div>
        <div style={{ flex: 1 }} />
        <div className="tov-summary">
          <span>
            <b>{tables?.length ?? 0}</b> tables
          </span>
          <span>
            ≈<b>{total.toLocaleString()}</b> rows
          </span>
          {unknown > 0 ? (
            <span className="tov-summary-dim">{unknown} without an estimate</span>
          ) : null}
        </div>
        <div className="seg tov-seg">
          <button
            type="button"
            className={"seg-btn" + (view === "table" ? " active" : "")}
            onClick={() => onViewChange("table")}
          >
            <Icon name="table_rows" size={14} /> Table
          </button>
          <button
            type="button"
            className={"seg-btn" + (view === "cards" ? " active" : "")}
            onClick={() => onViewChange("cards")}
          >
            <Icon name="grid_view" size={14} /> Cards
          </button>
        </div>
        <button
          type="button"
          className="tov-refresh"
          title="Re-read the catalog statistics"
          onClick={() => void loadTables(handleId, schema, { force: true })}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>

      <div className="tov-note">
        <Icon name="info" size={13} />
        <span>
          Estimates from the engine's own planner statistics — opening this tab queried none of
          these tables. They drift between <code>ANALYZE</code> runs; open a table for exact
          numbers.
          {unknown > 0 ? (
            <>
              {" "}
              Postgres reports nothing for a table until <code>ANALYZE</code> or autovacuum has
              reached it, which is why {unknown === 1 ? "one is" : unknown + " are"} unestimated
              here — sizes below are exact regardless.
            </>
          ) : null}
        </span>
      </div>

      {tables === null ? (
        <div className="tov-empty">Loading tables…</div>
      ) : tables.length === 0 ? (
        <div className="tov-empty">This schema has no tables.</div>
      ) : view === "table" ? (
        <div
          className="tov-table"
          role="table"
          style={{ "--tov-cols": cols } as React.CSSProperties}
        >
          <div className="tov-tr tov-thead" role="row">
            {th("name", "Name", "tov-c-name")}
            {th("rows", "Est. rows", "tov-c-num")}
            {has.sizes ? th("total", "Total", "tov-c-num") : null}
            {has.sizes ? th("data", "Data", "tov-c-num") : null}
            {has.sizes ? th("index", "Index", "tov-c-num") : null}
            {has.engine ? <span className="tov-th tov-c-tag">Engine</span> : null}
            {has.collation ? <span className="tov-th tov-c-tag">Collation</span> : null}
            {has.comment ? <span className="tov-th tov-c-comment">Comment</span> : null}
          </div>
          {sorted.map((c) => (
            <div
              key={c.name}
              className="tov-tr"
              role="row"
              tabIndex={0}
              title={"Open " + schema + "." + c.name}
              onClick={() => openTableTab(schema, c.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openTableTab(schema, c.name);
                }
              }}
            >
              <span className="tov-td tov-c-name">
                <Icon name="table" size={13} style={{ color: "var(--text-faint)" }} />
                {c.name}
              </span>
              <span className={"tov-td tov-c-num" + (c.rows == null ? " none" : "")}>
                {c.rows == null ? "—" : "≈" + c.rows.toLocaleString()}
              </span>
              {has.sizes ? (
                <span className="tov-td tov-c-num">
                  {c.info.totalBytes != null ? bytes(c.info.totalBytes) : "—"}
                </span>
              ) : null}
              {has.sizes ? (
                <span className="tov-td tov-c-num">
                  {c.info.dataBytes != null ? bytes(c.info.dataBytes) : "—"}
                </span>
              ) : null}
              {has.sizes ? (
                <span className="tov-td tov-c-num">
                  {c.info.indexBytes != null ? bytes(c.info.indexBytes) : "—"}
                </span>
              ) : null}
              {has.engine ? <span className="tov-td tov-c-tag">{c.info.engine ?? "—"}</span> : null}
              {has.collation ? (
                <span className="tov-td tov-c-tag" title={c.info.collation}>
                  {c.info.collation ?? "—"}
                </span>
              ) : null}
              {has.comment ? (
                <span className="tov-td tov-c-comment" title={c.info.comment}>
                  {c.info.comment ?? ""}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="tov-grid">
          {cards.map((c) => (
            <div key={c.name} className={"tov-card" + (c.rows == null ? " unknown" : "")}>
              <div
                className="tov-card-main"
                role="button"
                tabIndex={0}
                title={"Open " + schema + "." + c.name}
                onClick={() => openTableTab(schema, c.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openTableTab(schema, c.name);
                  }
                }}
              >
                <div className="tov-card-head">
                  <Icon name="table" size={14} style={{ color: "var(--text-faint)" }} />
                  <span className="tov-card-name">{c.name}</span>
                  {c.rank != null && c.rank <= 3 && known > 3 ? (
                    <span className="tov-card-rank">#{c.rank}</span>
                  ) : null}
                </div>

                <div className="tov-card-rows">
                  {c.rows == null ? (
                    <span className="tov-card-none">no estimate</span>
                  ) : (
                    <>
                      <span className="tov-card-approx">≈</span>
                      <span className="tov-card-n">{compact(c.rows)}</span>
                      <span className="tov-card-unit">rows</span>
                    </>
                  )}
                </div>

                <div className="tov-card-meter" aria-hidden>
                  <span className="tov-card-meter-fill" style={{ width: c.share * 100 + "%" }} />
                </div>
                <div className="tov-card-foot">
                  {c.rows == null ? "never analyzed" : sharePct(c.rows, total, known)}
                </div>

                {/* Catalog facts, shown only where the engine reports them —
                    MySQL fills all of these, Postgres the sizes and the comment,
                    SQLite none. An absent field is omitted rather than rendered
                    blank, so a card never implies a zero it does not know. */}
                {c.info.totalBytes != null ? (
                  <div className="tov-card-sizes">
                    <span title="Total size, including indexes">
                      <b>{bytes(c.info.totalBytes)}</b> total
                    </span>
                    {c.info.dataBytes != null ? (
                      <span title="Row data">{bytes(c.info.dataBytes)} data</span>
                    ) : null}
                    {c.info.indexBytes != null ? (
                      <span title="Indexes">{bytes(c.info.indexBytes)} index</span>
                    ) : null}
                  </div>
                ) : null}

                {c.info.engine || c.info.collation ? (
                  <div className="tov-card-tags">
                    {c.info.engine ? <span className="tov-tag">{c.info.engine}</span> : null}
                    {c.info.collation ? (
                      // The charset is the collation's prefix — MySQL reports
                      // only the collation, and both are worth seeing at a glance.
                      <span className="tov-tag" title={c.info.collation}>
                        {c.info.collation.split("_")[0]}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {c.info.comment ? (
                  <div className="tov-card-comment" title={c.info.comment}>
                    {c.info.comment}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
