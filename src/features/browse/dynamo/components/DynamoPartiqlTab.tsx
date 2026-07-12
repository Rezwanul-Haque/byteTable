// PartiQL terminal tab (M17 §17.4): run `SELECT … FROM table WHERE …` via the
// real `ExecuteStatement` command, render the results in the schemaless item
// grid, keep a per-tab history, and offer preset statements. Results come back
// already unmarshalled (plain JSON). Ported from `DynamoPartiql` in
// `dynamo-shell.jsx`.

import { useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { dynamoExecuteStatement, type StatementResult, type TableDescriptor } from "../api";
import { DynamoItemGrid } from "./DynamoItemGrid";

const HISTORY_MAX = 20;

interface DynamoPartiqlTabProps {
  handleId: string;
  tables: TableDescriptor[];
  /** Persisted editor buffer + history, lifted to the workspace so it survives
   *  tab switches within the workspace. */
  sql: string;
  history: string[];
  onChange: (patch: { sql?: string; history?: string[] }) => void;
}

export function DynamoPartiqlTab({
  handleId,
  tables,
  sql,
  history,
  onChange,
}: DynamoPartiqlTabProps) {
  const [result, setResult] = useState<StatementResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Presets seeded from the actual tables (first table + a couple of generic
  // shapes), mirroring the prototype's preset chips.
  const first = tables[0]?.name ?? "MyTable";
  const presets = [
    `SELECT * FROM "${first}"`,
    ...tables.slice(0, 3).map((t) => `SELECT * FROM "${t.name}" WHERE ${t.keySchema.pk} = '…'`),
  ];

  const run = async () => {
    const statement = sql.trim();
    if (!statement) return;
    setRunning(true);
    setError(null);
    try {
      const res = await dynamoExecuteStatement(handleId, statement);
      setResult(res);
      // Newest-first, deduped, capped.
      const next = [statement, ...history.filter((h) => h !== statement)].slice(0, HISTORY_MAX);
      onChange({ history: next });
    } catch (e) {
      setError(isAppErrorPayload(e) ? e.message : "PartiQL requires the desktop app");
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const gridKeySchema = {
    pk: result?.columns[0] ?? "",
    sk: result?.columns[1],
  };

  return (
    <div className="ddb-pq-tab">
      <div className="ddb-pq-toolbar">
        <Btn icon="play_arrow" variant="filled" small onClick={() => void run()} disabled={running}>
          Run
        </Btn>
        <span className="ddb-pq-hint">PartiQL · ⌘↩ / Ctrl+Enter</span>
        <div className="ddb-pq-snippets">
          {presets.map((p, i) => (
            <button
              key={i}
              type="button"
              className="ddb-snippet-chip"
              onClick={() => onChange({ sql: p })}
              title={p}
            >
              {p.replace(/SELECT .*? FROM /, "").slice(0, 22)}
            </button>
          ))}
        </div>
      </div>

      <div className="ddb-pq-editor-wrap">
        <textarea
          className="ddb-pq-input"
          value={sql}
          spellCheck={false}
          placeholder={`SELECT * FROM "${first}" WHERE ${tables[0]?.keySchema.pk ?? "PK"} = '…'`}
          onChange={(e) => onChange({ sql: e.target.value })}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
        />
        {history.length ? (
          <div className="ddb-pq-history">
            <div className="ddb-pq-history-label">History</div>
            {history.map((h, i) => (
              <button
                key={i}
                type="button"
                className="ddb-pq-history-item"
                title={h}
                onClick={() => onChange({ sql: h })}
              >
                {h}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="ddb-pq-results">
        {error ? (
          <div className="ddb-sql-error">
            <Icon name="error" size={18} />
            <div>
              <div className="ddb-sql-error-title">PartiQL error</div>
              <div className="ddb-sql-error-msg">{error}</div>
            </div>
          </div>
        ) : result ? (
          <>
            <div className="ddb-sql-result-bar">
              <span className={"ddb-op-tag " + (result.op === "Query" ? "q" : "s")}>
                {result.op}
              </span>
              <span>{result.count} items</span>
            </div>
            <div className="ddb-pq-grid">
              <DynamoItemGrid items={result.items} keySchema={gridKeySchema} />
            </div>
          </>
        ) : (
          <div className="ddb-sql-placeholder">
            <Icon name="terminal" size={26} style={{ color: "var(--text-faint)" }} />
            <span>Run a PartiQL statement to see items</span>
          </div>
        )}
      </div>
    </div>
  );
}
