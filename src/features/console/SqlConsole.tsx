// SQL console body (M14, spec §"SQL console") — the engine-specific body the
// ConsolePanel host mounts for SQL workspaces. A scrolling output log of past
// entries (echoed `{prompt} {command}` + status line + a compact inline result
// grid) over a sticky `{schema}>` input line.
//
// REUSE: query execution mirrors SqlEditorTab.run (queryRun + appErrorMessage)
// and the result rendering reuses SqlResultGrid/GridCell verbatim — the panel
// is the ephemeral scratch console; the editor tab stays the full surface. The
// console log + history live in the per-workspace console store (state.ts) so
// they survive workspace switches; `running` is transient local state (a
// concurrent run is guarded). "↗ open in tab" promotes a row result to a SQL
// editor tab via the existing openSqlTabWith action (runs there for the full
// grid + history/save).

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { queryRun } from "../../shared/api/engine";
import { appErrorMessage } from "../../shared/api/error";
import { Icon } from "../../shared/ui/Icon";
import { SqlResultGrid } from "../workspaces/components/SqlResultGrid";
import { useWorkspacesStore } from "../workspaces/state";
import type { Workspace } from "../workspaces/types";
import { selectConsole, useConsoleStore, type ConsoleEntry } from "./state";

export function SqlConsole({ workspace }: { workspace: Workspace }) {
  const wsId = workspace.id;
  const cons = useConsoleStore((s) => selectConsole(s, wsId));
  const pushEntry = useConsoleStore((s) => s.pushEntry);
  const pushHistory = useConsoleStore((s) => s.pushHistory);
  const clearLog = useConsoleStore((s) => s.clearLog);
  const openSqlTabWith = useWorkspacesStore((s) => s.openSqlTabWith);

  const [input, setInput] = useState("");
  // History cursor: -1 = the live (unsubmitted) input, 0 = most recent command.
  const [histIdx, setHistIdx] = useState(-1);
  const [running, setRunning] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Active schema this console runs against — mirrors SqlEditorTab's resolution
  // (sidebar switcher, falling back to the connection's first schema).
  const schemaName =
    (workspace.ui.schemaName !== undefined &&
    workspace.schemas.some((s) => s.name === workspace.ui.schemaName)
      ? workspace.ui.schemaName
      : workspace.schemas[0]?.name) ?? "main";

  const log = cons.log;

  // Auto-scroll the log to the bottom on a new entry / while running.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [log.length, running]);

  // Focus the input when the body first mounts (panel opened).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = () => {
    const sql = input.trim();
    if (running || sql === "") return; // empty input = no-op; guard concurrent runs.
    pushHistory(wsId, sql);
    setHistIdx(-1);
    setInput("");
    setRunning(true);
    queryRun(workspace.handleId, sql, { schema: schemaName })
      .then((result) => {
        const entry: ConsoleEntry = {
          id: crypto.randomUUID(),
          command: sql,
          status: "ok",
          schema: schemaName,
          // Only carry a grid for row-returning queries (columns present).
          ...(result.columns.length > 0 ? { result } : {}),
        };
        pushEntry(wsId, entry);
      })
      .catch((err: unknown) => {
        pushEntry(wsId, {
          id: crypto.randomUUID(),
          command: sql,
          status: "error",
          error: appErrorMessage(err, "Query failed."),
        });
      })
      .finally(() => {
        setRunning(false);
        inputRef.current?.focus();
      });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter runs; this also covers ⌘↩ / Ctrl+Enter (the modifier is irrelevant
    // for a single-line input — the spec's run shortcut).
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    } else if (e.key === "l" && e.ctrlKey) {
      // Ctrl+L clears the log (spec §"History").
      e.preventDefault();
      clearLog(wsId);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.min(histIdx + 1, cons.history.length - 1);
      if (n >= 0 && cons.history[n] != null) {
        setHistIdx(n);
        setInput(cons.history[n] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = histIdx - 1;
      if (n < 0) {
        setHistIdx(-1);
        setInput("");
      } else {
        setHistIdx(n);
        setInput(cons.history[n] ?? "");
      }
    }
    // ⌃` (toggle) is handled globally in WorkspaceShell; we let it bubble.
  };

  const prompt = schemaName + ">";

  return (
    <div className="sqlc">
      <div className="sqlc-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {log.length === 0 ? (
          <div className="sqlc-hint">
            Type SQL and press Enter to run against{" "}
            <span className="sqlc-hint-em">{schemaName}</span>. ↑/↓ for history · Ctrl+L to clear.
          </div>
        ) : null}

        {log.map((entry) => (
          <div key={entry.id} className="sqlc-entry">
            <div className="sqlc-echo">
              <span className="sqlc-echo-prompt">{prompt}</span>
              <span className="sqlc-echo-cmd">{entry.command}</span>
            </div>
            {entry.status === "error" ? (
              <div className="sqlc-status sqlc-status-err">
                <Icon name="close" size={13} />
                <span>{entry.error}</span>
              </div>
            ) : entry.result ? (
              <>
                <div className="sqlc-status">
                  <Icon name="check" size={13} />
                  <span>
                    {entry.result.rowCount} row{entry.result.rowCount === 1 ? "" : "s"}
                  </span>
                  {entry.result.truncated ? <span className="dim">(truncated)</span> : null}
                  <span className="dim">·</span>
                  <span className="dim">{entry.result.elapsedMs} ms</span>
                  <span className="dim">·</span>
                  <span className="dim">{entry.schema}</span>
                  <button
                    type="button"
                    className="sqlc-send"
                    title="Open this query in a SQL editor tab"
                    onClick={() => openSqlTabWith(entry.command)}
                  >
                    <Icon name="open_in_new" size={12} /> open in tab
                  </button>
                </div>
                {entry.result.rows.length === 0 ? (
                  <div className="sqlc-norows">Query returned no rows</div>
                ) : (
                  <div className="sqlc-grid">
                    <SqlResultGrid result={entry.result} />
                  </div>
                )}
              </>
            ) : (
              <div className="sqlc-status">
                <Icon name="check" size={13} />
                <span>Query OK</span>
                <span className="dim">·</span>
                <span className="dim">{entry.schema}</span>
              </div>
            )}
          </div>
        ))}

        <div className="sqlc-inputline">
          <span className="sqlc-prompt">{prompt}</span>
          <input
            ref={inputRef}
            className="sqlc-input"
            value={input}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="SQL command"
            disabled={running}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {running ? <Icon name="progress_activity" size={14} className="sqlc-spin" /> : null}
        </div>
      </div>
    </div>
  );
}
