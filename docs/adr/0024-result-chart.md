# ADR-0024 — Result chart: hand-drawn charts of the in-memory result, off-thread when large

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-11-24 (first commit that shipped the feature: `72d2c67` "chart a query result as bars or a line or a donut")
- **Area:** SQL
- **Related:** ADR-0010, ADR-0017, ADR-0019, ADR-0026

## Context

Users want a quick visual of the rows a query returned without exporting to
another tool. Three rules apply:

1. chart the result as it is, with no re-run or rewrite, and show a cut result
   as cut;
2. produce a useful chart with no setup;
3. say in plain words what was done to the data (combined, capped, rescaled).

The scope was bar and line charts with up to four value columns. Images,
pie/stacked/area, a second axis, charts in the table view, non-SQL engines, and
saving a chart with a saved query were all out of scope. Results can hold up to
10,000 rows (ADR-0019), and building a series on the main thread could freeze
the UI.

## Decision

- **Renderer-only slice `src/features/result_chart/`**, with no Rust side.
  - `chartModel.ts` contains the pure data logic.
  - `components/ResultChart.tsx` holds the controls, notes, plot and footer.
  - `ChartBars.tsx` (HTML bar rows), `ChartLine.tsx` and `ChartDonut.tsx`
    (inline SVG) draw the charts.
  - `hooks/useChartSeries.ts` and `chart.worker.ts` build the series.
- **No charting library.** The charts are hand-built components sized to their
  box (SVG for line/donut).
- **Columns by index, not name**, because `SELECT *` across a join can return two
  `id` columns (`chartModel.ts` header). `profile` classifies each column as
  number/time/bool/text and flags ID-like names (`id`, `*_id`, `*.id`) so they
  are not picked as values.
- **Zero-setup inference** (`infer` / `firstCfg`):
  - no numeric columns → count rows per label on the text column that repeats
    most, drawn as a donut when that column has 2–4 distinct values or is
    boolean, otherwise as bars;
  - only numbers → one bar per row;
  - a time column → a line chart;
  - otherwise → bars of the first non-ID value column.
- **Limits and notes:** `MAX_SERIES = 4`, `MAX_BARS = 40`, `MAX_SLICES = 6` (the
  rest fold into "Other"). Rows sharing a label combine with `Agg`
  `sum | avg | min | max` (sum by default), and a note says so. Null labels render
  as `∅ null`.
- **Off-thread above `OFF_THREAD_ROWS = 5000`:** `useChartSeries` posts rows and
  config to a module `Worker` (`new URL("../chart.worker.ts", import.meta.url)`)
  that runs the same `series` function. Translated labels are sent as strings
  because functions cannot be posted. Request ids discard stale replies, and the
  worker is terminated on unmount.
- **State:** `SqlTabState.resultView?: "table" | "chart"`
  (`src/features/workspaces/types.ts`) lives on the tab, so a re-run keeps Chart.
  Chart settings are local to `ResultChart` and keyed by `columnsSig(columns)`.
  A re-run with the same columns keeps the settings, and a different column list
  starts over from a fresh suggestion.
- **Reuse:** the notebook query cell imports the same `ResultChart` (ADR-0026).
  Labels respect data masking (`maskShow` / `useMask`, ADR-0017).

## Alternatives considered

- **A charting library (Recharts, Chart.js, ECharts):** not adopted, and
  `package.json` has none. Inferred reasons: bundle size, exact control over the
  `.ch-*` styling, and only three simple chart types needed.
- **Re-query with `GROUP BY` for aggregation:** ruled out by rule 1. Combining
  happens client-side over the returned rows.
- **Always compute on the main thread:** rejected for large results (the hook
  comment cites "task A5": switching to Chart "never freezes the UI").
- **Persist chart config with the saved query:** out of scope, and not
  implemented.

## Consequences

- **Positive:** charts appear with no setup, never touch the database, and work
  on every SQL engine plus notebooks. The model is pure and covered by
  `chartModel.test.ts`.
- **Negative / trade-offs:** a chart shows at most the returned rows, so a
  truncated result is a truncated chart. Rows are copied to the worker on every
  config change for large results. There is no export, no second axis, and no
  persistence across sessions or saved queries.
- **Follow-ups:** the donut type shipped beyond the original bar/line scope.
  Charts for the table data view and non-SQL engines are not implemented.
