// Standalone CQL query tab (M19 §19.5) — mirrors the SQL query tab: the shared
// CodeMirror editor (`SqlCodeEditor`) with the in-editor Format wand, the editor
// GROWS to fill until a query is run (no results pane shown), and a multi-
// statement selection (⌘A + Run) runs each `;`-separated statement IN ORDER,
// one result tab per statement. Results render through the shared wide-column grid.

import { useEffect, useMemo, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { formatSql } from "../../../workspaces/formatSql";
import {
  SqlCodeEditor,
  type SqlCodeEditorHandle,
} from "../../../workspaces/components/SqlCodeEditor";
import { splitStatements, statementRanges } from "../../../workspaces/sqlStatement";
import { libraryForEngine } from "../../../snippets/builtins";
import { selectSnippetsForEngine, useSnippetsStore } from "../../../snippets/state";
import { cassRunCql, type CassColumn, type CassCqlResult, type TableDescriptor } from "../api";
import { csvOf, download } from "../cassIo";
import { CassRowGrid } from "./CassRowGrid";

const CONSISTENCY_LEVELS = ["ONE", "QUORUM", "LOCAL_ONE", "LOCAL_QUORUM", "ALL"];
/** Editor pane floor (px) when resizing the editor/results split. */
const EDITOR_H_MIN = 110;

interface CassRun {
  id: string;
  cql: string;
  result: CassCqlResult | null;
  error: string | null;
}

interface CassandraQueryTabProps {
  handleId: string;
  ks: string;
  tables: TableDescriptor[];
}

export function CassandraQueryTab({ handleId, ks, tables }: CassandraQueryTabProps) {
  const t = useT();
  // Open with an empty editor — no pre-seeded query.
  const [cqlText, setCqlText] = useState("");
  const [runs, setRuns] = useState<CassRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [allSelected, setAllSelected] = useState(false);
  const [consistency, setConsistency] = useState("LOCAL_QUORUM");
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const editorRef = useRef<SqlCodeEditorHandle>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLDivElement>(null);

  // The snippet library (global store + the CQL built-ins), offered in this
  // editor's completion exactly as in the SQL tab — the built-ins here are the
  // CQL shapes, so `sel` expands with a partition-key predicate rather than a
  // bare WHERE. Managing the library lives in the SQL workspaces' drawer; this
  // shell only consumes it.
  const allSnippets = useSnippetsStore((s) => s.snippets);
  const loadSnippets = useSnippetsStore((s) => s.load);
  useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);
  const editorSnippets = useMemo(
    () => libraryForEngine(selectSnippetsForEngine(allSnippets, "cassandra"), "cassandra"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSnippets, t],
  );

  const schema = useMemo(
    () => ({
      tables: tables.map((d) => ({
        name: d.name,
        columns: d.columns.map((c) => ({
          name: c.name,
          pk: c.kind === "partition_key" || c.kind === "clustering",
        })),
      })),
    }),
    [tables],
  );

  // Run CQL. The source (a picked statement, a multi-statement selection, or the
  // whole buffer) is split into top-level statements and run IN ORDER — the
  // driver's prepared path takes one statement at a time. Every statement's
  // outcome becomes a result tab; the first is focused.
  const run = (override?: string) => {
    const source = (override ?? cqlText).trim();
    if (running || source === "") return;
    const statements = splitStatements(source);
    if (statements.length === 0) return;
    setRunning(true);
    void (async () => {
      const out: CassRun[] = [];
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i]!;
        try {
          const result = await cassRunCql(handleId, ks, stmt, consistency);
          out.push({ id: `r${i}`, cql: stmt, result, error: null });
        } catch (e) {
          out.push({
            id: `r${i}`,
            cql: stmt,
            result: null,
            error: isAppErrorPayload(e) ? e.message : t("cass.query.failedDesktop"),
          });
        }
      }
      setRuns(out);
      setActiveRunId(out[0]?.id ?? null);
      setRunning(false);
    })();
  };
  const format = () => setCqlText(formatSql(cqlText));

  // Drag the splitter to resize the editor vs results panes.
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const wrap = editorWrapRef.current;
    const tabEl = tabRef.current;
    if (!wrap || !tabEl) return;
    const startY = e.clientY;
    const startH = wrap.getBoundingClientRect().height;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      const maxH = Math.max(EDITOR_H_MIN, tabEl.getBoundingClientRect().height - 140);
      setEditorHeight(Math.max(EDITOR_H_MIN, Math.min(maxH, startH + (ev.clientY - startY))));
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setDragging(false);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  // Select the statement behind a result tab in the editor and scroll it into
  // view — the failed result's "Go to statement". Matched by text against a
  // fresh split (the buffer may have been edited since the run), preferring the
  // occurrence at or after the run's own position.
  const goToStatement = (id: string) => {
    const idx = runs.findIndex((r) => r.id === id);
    const target = runs[idx];
    if (!target) return;
    const ranges = statementRanges(cqlText);
    const isTarget = (r: { from: number; to: number }) =>
      cqlText.slice(r.from, r.to) === target.cql;
    const hit = ranges.slice(idx).find(isTarget) ?? ranges.find(isTarget);
    if (hit) editorRef.current?.revealRange(hit.from, hit.to);
  };

  const closeRun = (id: string) =>
    setRuns((rs) => {
      const idx = rs.findIndex((r) => r.id === id);
      const next = rs.filter((r) => r.id !== id);
      if (id === activeRunId) setActiveRunId(next[Math.max(0, idx - 1)]?.id ?? null);
      return next;
    });

  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null;
  const resultsShown = runs.length > 0;

  return (
    <div className="table-tab" ref={tabRef}>
      <div className="table-toolbar ddb-toolbar">
        <label className="cass-consistency" title={t("cass.query.consistency")}>
          <Icon name="hub" size={13} />
          <select
            className="filter-select"
            value={consistency}
            onChange={(e) => setConsistency(e.target.value)}
          >
            {CONSISTENCY_LEVELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div style={{ flex: 1 }} />
        <Btn
          icon="play_arrow"
          variant="filled"
          small
          disabled={running}
          onClick={() => run(editorRef.current?.pickStatement())}
        >
          {running
            ? t("cass.query.running")
            : allSelected
              ? t("cass.query.runAll")
              : t("cass.query.runCql")}
        </Btn>
      </div>

      <div
        className={"cass-cql-editor-wrap cass-cql-editor-wrap-full" + (resultsShown ? "" : " grow")}
        ref={editorWrapRef}
        style={resultsShown && editorHeight != null ? { height: editorHeight } : undefined}
      >
        <div className="sql-editor-main">
          <button
            type="button"
            className="sql-format-fab"
            title={t("cass.query.beautifyTitle")}
            aria-label={t("cass.query.formatCql")}
            onClick={format}
          >
            <Icon name="auto_fix_high" size={15} />
          </button>
          <SqlCodeEditor
            ref={editorRef}
            value={cqlText}
            onChange={setCqlText}
            onRun={(sql) => run(sql)}
            onFormat={format}
            onAllSelected={setAllSelected}
            schema={schema}
            engine="cassandra"
            snippets={editorSnippets}
          />
        </div>
      </div>

      {resultsShown ? (
        <div
          className={"sql-vsplit" + (dragging ? " dragging" : "")}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("cass.query.resizeEditor")}
          title={t("cass.query.dragToResize")}
          onPointerDown={startResize}
        />
      ) : null}

      {resultsShown ? (
        <div className="sql-results">
          {runs.length > 1 ? (
            <div className="sqlres-tabs">
              {runs.map((r, i) => {
                // Failed = it carries an error, or nothing came back at all;
                // either way it must never be badged as a success.
                const failed = r.error != null || r.result == null;
                return (
                  <div
                    key={r.id}
                    className={
                      "sqlres-tab" +
                      (r.id === activeRun?.id ? " active" : "") +
                      (failed ? " failed" : "")
                    }
                    onClick={() => setActiveRunId(r.id)}
                    title={r.cql}
                  >
                    <Icon
                      name={failed ? "cancel" : "check_circle"}
                      size={13}
                      style={{ color: failed ? "var(--error)" : "var(--accent)" }}
                    />
                    <span className="sqlres-tab-title">
                      {failed
                        ? t("cass.query.resultFailedN", { n: i + 1 })
                        : t("cass.query.resultN", { n: i + 1 })}
                    </span>
                    <button
                      type="button"
                      className="sqlres-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeRun(r.id);
                      }}
                      title={t("cass.query.closeResultN", { n: i + 1 })}
                      aria-label={t("cass.query.closeResultN", { n: i + 1 })}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {activeRun ? (
            <CassRunResult
              run={activeRun}
              ks={ks}
              consistency={consistency}
              onGoTo={() => goToStatement(activeRun.id)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Renders a single statement's outcome (error / ddl / list / ok / rows). */
function CassRunResult({
  run,
  ks,
  consistency,
  onGoTo,
}: {
  run: CassRun;
  ks: string;
  consistency: string;
  onGoTo: () => void;
}) {
  const t = useT();
  const r = run.result;
  // A failed statement (or one that came back with nothing): the §5 message and
  // the CQL that broke — click either it or the button to land on that
  // statement in the editor.
  if (run.error != null || r == null) {
    return (
      <div className="sql-error">
        <Icon name="cancel" size={18} />
        <div>
          <div className="sql-error-title">{t("cass.query.error")}</div>
          <div className="sql-error-msg">{run.error ?? t("cass.query.noResult")}</div>
          <button
            type="button"
            className="sql-error-stmt"
            title={t("cass.query.goToStmtHint")}
            onClick={onGoTo}
          >
            {run.cql}
          </button>
          <Btn icon="my_location" variant="text" small onClick={onGoTo}>
            {t("cass.query.goToStmt")}
          </Btn>
        </div>
      </div>
    );
  }
  if (r.kind === "ddl") return <pre className="ddl-block cass-ddl-result">{r.text}</pre>;
  if (r.kind === "list")
    return (
      <div className="cass-list-result">
        {r.items.map((x) => (
          <div key={x} className="cass-list-item">
            {x}
          </div>
        ))}
      </div>
    );
  if (r.kind === "ok")
    return (
      <div className="cass-list-result">
        <div className="cass-list-item">{r.message}</div>
      </div>
    );
  if (r.kind === "use")
    return (
      <div className="cass-list-result">
        <div className="cass-list-item">{t("cass.query.usingKeyspace", { ks: r.keyspace })}</div>
      </div>
    );
  // rows
  return (
    <CassRowsResult
      columns={r.columns}
      rows={r.rows}
      warnings={r.warnings}
      returned={r.returned}
      ms={r.ms}
      ks={ks}
      consistency={consistency}
    />
  );
}

/** A SELECT result grid with multi-select + Export-selected-to-CSV (the bulk op
 *  available on a read-only query result — no delete, since arbitrary CQL rows
 *  carry no guaranteed full primary key). */
function CassRowsResult({
  columns,
  rows,
  warnings,
  returned,
  ms,
  ks,
  consistency,
}: {
  columns: CassColumn[];
  rows: Record<string, unknown>[];
  warnings: string[];
  returned: number;
  ms: number;
  ks: string;
  consistency: string;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggleRow = (i: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const toggleAll = () =>
    setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((_, i) => i))));
  const exportSelectedCsv = () => {
    const picked = [...selected].map((i) => rows[i]).filter(Boolean) as Record<string, unknown>[];
    if (!picked.length) return;
    download(ks + "-cql-result.csv", csvOf(columns, picked), "text/csv");
  };

  return (
    <>
      {warnings.length ? (
        <div className="cass-warn">
          <Icon name="warning" size={14} /> {warnings[0]}
        </div>
      ) : null}
      {selected.size > 0 ? (
        <div className="cass-selbar">
          <span className="cass-selbar-count">
            {t("cass.query.selectedCount", { count: selected.size })}
          </span>
          <div style={{ flex: 1 }} />
          <Btn icon="download" variant="tonal" small onClick={exportSelectedCsv}>
            {t("cass.query.exportCsv")}
          </Btn>
        </div>
      ) : null}
      <CassRowGrid
        table={{ columns }}
        rows={rows}
        selected={selected}
        onToggleRow={toggleRow}
        onToggleAll={toggleAll}
      />
      <div className="table-hint">
        {t("cass.query.statusLine", {
          consistency: consistency + " · " + ks,
          rows: returned,
          ms: ms.toFixed(1),
        })}
      </div>
    </>
  );
}
