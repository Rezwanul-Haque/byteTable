// Standalone CQL query tab (M19 §19.5) — mirrors the SQL query tab: the shared
// CodeMirror editor (`SqlCodeEditor`) with the in-editor Format wand, the editor
// GROWS to fill until a query is run (no results pane shown), and a multi-
// statement selection (⌘A + Run) runs each `;`-separated statement IN ORDER,
// one result tab per statement. Results render through the shared wide-column grid.

import { useMemo, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { formatSql } from "../../../workspaces/components/formatSql";
import {
  SqlCodeEditor,
  type SqlCodeEditorHandle,
} from "../../../workspaces/components/SqlCodeEditor";
import { splitStatements } from "../../../workspaces/components/sqlStatement";
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
            error: isAppErrorPayload(e) ? e.message : "Query failed (desktop app required)",
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
        <label className="cass-consistency" title="Consistency level">
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
          {running ? "Running…" : allSelected ? "Run All" : "Run CQL"}
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
            title="Beautify / format CQL (⇧⌥F)"
            aria-label="Format CQL"
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
          />
        </div>
      </div>

      {resultsShown ? (
        <div
          className={"sql-vsplit" + (dragging ? " dragging" : "")}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize editor"
          title="Drag to resize"
          onPointerDown={startResize}
        />
      ) : null}

      {resultsShown ? (
        <div className="sql-results">
          {runs.length > 1 ? (
            <div className="sqlres-tabs">
              {runs.map((r, i) => (
                <div
                  key={r.id}
                  className={"sqlres-tab" + (r.id === activeRun?.id ? " active" : "")}
                  onClick={() => setActiveRunId(r.id)}
                  title={r.cql}
                >
                  <Icon
                    name={r.error ? "error" : "check_circle"}
                    size={13}
                    style={{ color: r.error ? "#e06c75" : "var(--accent)" }}
                  />
                  <span className="sqlres-tab-title">Result {i + 1}</span>
                  <button
                    type="button"
                    className="sqlres-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeRun(r.id);
                    }}
                    title="Close result"
                    aria-label={`Close result ${i + 1}`}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {activeRun ? <CassRunResult run={activeRun} ks={ks} consistency={consistency} /> : null}
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
}: {
  run: CassRun;
  ks: string;
  consistency: string;
}) {
  if (run.error) {
    return (
      <div className="sql-error">
        <Icon name="error" size={18} />
        <div>
          <div className="sql-error-title">Query error</div>
          <div className="sql-error-msg">{run.error}</div>
        </div>
      </div>
    );
  }
  const r = run.result;
  if (!r) return null;
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
        <div className="cass-list-item">Now using keyspace {r.keyspace}</div>
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
          <span className="cass-selbar-count">{selected.size} selected</span>
          <div style={{ flex: 1 }} />
          <Btn icon="download" variant="tonal" small onClick={exportSelectedCsv}>
            Export CSV
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
        {ks} · consistency {consistency} · {returned} rows · {ms.toFixed(1)} ms · ⌘/Ctrl + Enter to
        run
      </div>
    </>
  );
}
