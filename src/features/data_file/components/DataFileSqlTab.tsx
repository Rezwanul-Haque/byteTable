// SQL over the file (M35 Task 6) — ported from the prototype's `CsvSqlTab`.
//
// The file's rows already live in a private in-memory SQLite database (loaded
// when the workspace opened), so every query here goes through the ordinary
// `query_run` path — the same command, result shape, timings and §5 error
// messages as a real connection. There is no second query engine.
//
// SELECT only: a file has nothing to write back to, and saying so plainly beats
// letting an UPDATE succeed against a scratch database the user will never see
// again.

import { useCallback, useEffect, useRef, useState } from "react";

import type { QueryResult } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { SqlResultGrid } from "../../workspaces/components/SqlResultGrid";
import type { DataFileDoc } from "../doc";
import { runDataFileQuery, sampleQueries } from "../sqlSession";

interface DataFileSqlTabProps {
  doc: DataFileDoc;
  /** The scratch database's handle — the workspace's connection handle. */
  handleId: string;
  /** True while this tab is the visible one (gates the ⌘↩ shortcut). */
  active: boolean;
  /** A query handed over from elsewhere (the filter panel's "open in SQL"). */
  seedSql?: string | null;
  /** Clear the seed once it has been loaded, so it applies exactly once. */
  onSeedConsumed?: () => void;
}

export function DataFileSqlTab({
  doc,
  handleId,
  active,
  seedSql,
  onSeedConsumed,
}: DataFileSqlTabProps) {
  const samples = sampleQueries(doc.schema, doc.analysis.cols);
  const starter = samples[0]!.sql;

  const [sql, setSql] = useState(starter);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Read inside the shortcut handler so it never runs a stale buffer.
  const sqlRef = useRef(sql);
  sqlRef.current = sql;

  const run = useCallback(
    (text?: string) => {
      const q = (text ?? sqlRef.current).trim();
      if (!q) return;
      setRunning(true);
      runDataFileQuery(handleId, q)
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((e: unknown) => {
          setError(appErrorMessage(e, "The query could not be run."));
          setResult(null);
        })
        .finally(() => setRunning(false));
    },
    [handleId],
  );

  // Run the starter query once, on mount. The workspace keys this tab by the
  // scratch database's handle, so re-opening on another file remounts it —
  // which is also what resets the buffer, without a state-clearing effect.
  useEffect(() => {
    run(starter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A query handed over by the filter panel replaces the buffer and runs, then
  // clears itself — so returning to this tab later does not re-load it over
  // whatever the user has since typed.
  useEffect(() => {
    if (!seedSql) return;
    setSql(seedSql);
    run(seedSql);
    onSeedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedSql]);

  // ⌘↩ / Ctrl+Enter from inside the editor, matching the SQL editor tab.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "Enter" &&
        document.activeElement === taRef.current
      ) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, run]);

  return (
    <div className="csvv-pane" data-screen-label={"Data file SQL: " + doc.name}>
      <div className="csvv-sql-head">
        <Icon name="code" size={14} style={{ color: "var(--accent)" }} />
        <span>
          Querying <code>{doc.table}</code> — a virtual table backed by this file
        </span>
        <div style={{ flex: 1 }} />
        <div className="csvv-sql-samples">
          {samples.map((s) => (
            <button
              type="button"
              key={s.label}
              className="csvv-sample-q"
              onClick={() => {
                setSql(s.sql);
                run(s.sql);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="csvv-sql-editor">
        <textarea
          ref={taRef}
          className="csvv-sql-input"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          spellCheck={false}
          rows={4}
          aria-label={"SQL over " + doc.name}
        />
        <div className="csvv-sql-actions">
          <Btn icon="play_arrow" variant="filled" disabled={running} onClick={() => run()}>
            {running ? "Running…" : "Run"}
          </Btn>
          <span className="csvv-sql-hint">⌘↩ / Ctrl+Enter</span>
        </div>
      </div>

      {error ? (
        <div className="sql-error" style={{ margin: "12px 16px" }}>
          <Icon name="error" size={18} />
          <div>
            <div className="sql-error-title">Query failed</div>
            <div className="sql-error-msg">{error}</div>
          </div>
        </div>
      ) : result ? (
        <div className="csvv-sql-results">
          <SqlResultGrid result={result} exportName={doc.table + "-query.csv"} />
          <div className="table-footer">
            <span className="table-hint">
              {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? "" : "s"} ·{" "}
              {result.elapsedMs} ms
              {result.truncated ? " · truncated by the row limit" : ""} · queries never change the
              file
            </span>
            <div className="pager">
              <span className="pager-range">SELECT only</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
