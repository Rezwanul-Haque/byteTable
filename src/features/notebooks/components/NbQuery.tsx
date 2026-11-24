// A query cell (M47 E4–E5, F1–F7, G1–G4), ported from the prototype's
// NbQuery. The editor is the SQL tab's own (CodeMirror, with its highlighting,
// autocomplete and ⌘↩), grown to its content.

import { useMemo, type CSSProperties, type ReactNode } from "react";

import type { ColumnMeta, QueryResult } from "../../../shared/api/engine";
import { fmtNumber } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { SegSwitch } from "../../../shared/ui/SegSwitch";
import type { Engine } from "../../../shared/types";
import { ResultChart } from "../../result_chart/components/ResultChart";
import type { Snippet } from "../../snippets/api";
import type { EditorSchema } from "../../workspaces/sqlCompletion";
import { SqlCodeEditor } from "../../workspaces/components/SqlCodeEditor";
import { SqlResultGrid } from "../../workspaces/components/SqlResultGrid";
import { MAX_SHOWN_ROWS, type QueryCell } from "../format";
import { ranWhen } from "../when";

export function NbQuery({
  cell,
  n,
  engine,
  schema,
  snippets,
  readOnly,
  autoFocus,
  onChange,
  onRun,
  onRunNext,
  onRunInsert,
  onStop,
  onConfirm,
  onOpenSql,
}: {
  cell: QueryCell;
  /** Its number among the queries: 1, 2, 3… */
  n: number;
  engine: Engine;
  schema: EditorSchema;
  /** The snippet library for this engine, offered in the completion list. */
  snippets: Snippet[];
  /** The notebook cannot be edited (a newer file version). */
  readOnly: boolean;
  autoFocus: boolean;
  onChange: (patch: Partial<QueryCell>) => void;
  onRun: () => void;
  onRunNext: () => void;
  /** ⌥↩: run, then insert a query cell below. */
  onRunInsert: () => void;
  onStop: () => void;
  onConfirm: () => void;
  onOpenSql: () => void;
}) {
  const t = useT();
  const r = cell.result;
  const stale = !!r && cell.ranSql !== cell.sql;
  const empty = !cell.sql.trim();
  const shown = r ? Math.min(r.rows.length, MAX_SHOWN_ROWS) : 0;
  const more = r ? r.rowCount - shown : 0;
  const total = r ? fmtNumber(r.rowCount) + (r.truncated ? "+" : "") : "";
  const columns = useMemo<ColumnMeta[]>(
    () => (r ? r.columns.map((name) => ({ name, typeHint: "" })) : []),
    [r],
  );
  // The result as the SQL tab's grid takes it: the same read-only grid (no
  // editing, no inspector), over the rows the cell holds.
  const gridResult = useMemo<QueryResult | null>(
    () =>
      r
        ? { columns, rows: r.rows, rowCount: r.rows.length, truncated: false, elapsedMs: r.ms }
        : null,
    [r, columns],
  );
  const c = cell.confirm;

  let confirmLine: ReactNode = null;
  if (c) {
    if (c.readOnly) confirmLine = t("notebook.confirm.readOnly");
    else if (c.counting) confirmLine = t("notebook.confirm.counting");
    else if (c.error) confirmLine = c.error;
    else if (c.rows == null) confirmLine = t("notebook.confirm.noCount", { verb: c.verb });
    else
      confirmLine = t(c.prod ? "notebook.confirm.affectsProd" : "notebook.confirm.affects", {
        verb: c.verb,
        rows: t("notebook.rows", { count: c.rows }),
      });
  }

  return (
    <div className="nb-q">
      <div className="nb-gutter">
        {cell.running ? (
          <button
            type="button"
            className="nb-run running"
            onClick={onStop}
            title={t("notebook.stopTitle")}
            aria-label={t("notebook.stopAria", { n })}
          >
            <Icon name="stop" size={16} fill={1} />
          </button>
        ) : (
          <button
            type="button"
            className="nb-run"
            onClick={onRun}
            disabled={empty}
            title={t("notebook.runTitle")}
            aria-label={t("notebook.runAria", { n })}
          >
            <Icon name="play_arrow" size={17} fill={1} />
          </button>
        )}
        <span className="nb-n" aria-hidden="true">
          {n}
        </span>
      </div>
      <div className="nb-q-body">
        <div className="nb-code">
          <SqlCodeEditor
            value={cell.sql}
            onChange={(sql) => {
              if (sql === cell.sql) return;
              // Editing dismisses the write confirmation and the skip note.
              onChange({ sql, confirm: null, skipped: false });
            }}
            onRun={() => onRun()}
            onShiftEnter={onRunNext}
            onAltEnter={onRunInsert}
            schema={schema}
            snippets={snippets}
            engine={engine}
            lineNumbers={false}
            floatingTooltips
            autoFocus={autoFocus}
            readOnly={readOnly}
            ariaLabel={t("notebook.sqlAria", { n })}
          />
        </div>

        {c ? (
          <div className="nb-confirm" role="alert">
            <Icon name={c.readOnly ? "lock" : "edit_note"} size={17} />
            <div className="nb-confirm-text">
              <b>{t("notebook.confirm.title")}</b>
              <span>{confirmLine}</span>
            </div>
            <Btn small variant="text" onClick={() => onChange({ confirm: null })}>
              {t("common.cancel")}
            </Btn>
            {c.readOnly || c.error || c.counting ? null : (
              <Btn small variant="filled" onClick={onConfirm}>
                {t("notebook.confirm.run", { verb: c.verb })}
              </Btn>
            )}
          </div>
        ) : null}

        {cell.skipped && !c ? (
          <div className="nb-skip">
            <Icon name="skip_next" size={15} /> {t("notebook.skipped")}
          </div>
        ) : null}

        {cell.notice ? (
          <div className="nb-notice" role="status">
            <Icon name="check_circle" size={15} /> {cell.notice}
          </div>
        ) : null}

        {cell.error ? (
          <div className="nb-error" role="alert">
            <Icon name="error" size={16} />
            <div>
              <b>{t("notebook.queryFailed")}</b>
              <span>{cell.error}</span>
            </div>
          </div>
        ) : null}

        {r ? (
          <div className={"nb-result" + (stale ? " stale" : "")}>
            <div className="nb-result-bar">
              {stale ? (
                <span className="nb-stale">
                  <Icon name="history" size={14} /> {t("notebook.result.stale")}
                </span>
              ) : (
                <>
                  <span>
                    {r.truncated
                      ? t("notebook.rowsAtLeast", { n: total })
                      : t("notebook.rows", { count: r.rowCount })}
                  </span>
                  <span className="dim">·</span>
                  <span>{fmtNumber(r.ms)} ms</span>
                  <span className="dim">·</span>
                  <span className="dim">
                    {t(r.saved ? "notebook.result.fromFile" : "notebook.result.ran", {
                      when: ranWhen(t, r.at),
                    })}
                  </span>
                </>
              )}
              <div style={{ flex: 1 }} />
              {cell.collapsed || !r.columns.length ? null : (
                <SegSwitch
                  ariaLabel={t("chart.view.aria")}
                  value={cell.view}
                  onChange={(view) => onChange({ view })}
                  options={[
                    { value: "table", label: t("chart.view.table"), icon: "table_rows" },
                    { value: "chart", label: t("chart.view.chart"), icon: "bar_chart" },
                  ]}
                />
              )}
              <IconBtn
                icon={cell.collapsed ? "unfold_more" : "unfold_less"}
                size={15}
                title={cell.collapsed ? t("notebook.result.show") : t("notebook.result.hide")}
                aria-label={cell.collapsed ? t("notebook.result.show") : t("notebook.result.hide")}
                aria-expanded={!cell.collapsed}
                onClick={() => onChange({ collapsed: !cell.collapsed })}
              />
            </div>
            {cell.collapsed ? null : cell.view === "chart" && r.columns.length ? (
              <div className="nb-chart">
                <ResultChart columns={columns} rows={r.rows} />
              </div>
            ) : !r.columns.length ? (
              <div className="nb-none">{t("notebook.result.noColumns")}</div>
            ) : (
              // Sized to its rows, up to the cap — the grid is virtualized and
              // needs a definite height (see `.nb-grid`).
              <div
                className="nb-grid"
                role="region"
                aria-label={t("notebook.result.aria", { n })}
                style={{ "--nb-rows": Math.max(1, r.rows.length) } as CSSProperties}
              >
                <SqlResultGrid result={gridResult!} exportName={`query-${n}.csv`} />
              </div>
            )}
            {!cell.collapsed && more > 0 ? (
              <div className="nb-more">
                {r.saved
                  ? t("notebook.result.fileKeeps", { n: fmtNumber(r.rows.length), total })
                  : t("notebook.result.showing", { n: fmtNumber(MAX_SHOWN_ROWS), total })}
                <button type="button" onClick={onOpenSql}>
                  {t("notebook.openInSql")}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
