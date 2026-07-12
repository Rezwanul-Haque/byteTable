// Cassandra cqlsh session body (M19 §19.5) — the docked-terminal counterpart to
// SqlTerminalTab / RedisTerminalSession / MongoShellSession. A small REPL over
// the wide-column `run_cql` command (SELECT / DESCRIBE / USE) plus `nodetool
// status` (cluster metadata) and `clear`, using the shared `.rcli-*` chrome.
// Mounted by TerminalPanel's engine branch.

import { useEffect, useRef, useState } from "react";

import { isAppErrorPayload } from "../../shared/api/error";
import { CassValue } from "../browse/cassandra/components/CassValue";
import {
  cassClusterStatus,
  cassRunCql,
  type CassColumn,
  type NodeStatus,
} from "../browse/cassandra/api";
import type { Workspace } from "../workspaces/types";
import type { TermSession } from "./state";

interface TextLine {
  cls: string;
  text: string;
}
interface NodesLine {
  kind: "nodes";
  nodes: NodeStatus[];
}
interface RowsLine {
  kind: "rows";
  columns: CassColumn[];
  rows: Record<string, unknown>[];
}
type Line = TextLine | NodesLine | RowsLine;

const PRESETS = ["SELECT * FROM users_by_id LIMIT 5;", "DESCRIBE TABLES;", "nodetool status"];

export function CassandraShellSession({
  workspace,
}: {
  workspace: Workspace;
  session: TermSession;
}) {
  const handleId = workspace.handleId;
  const params = workspace.saved.params;
  const initialKs = params.engine === "cassandra" ? (params.keyspace ?? "system") : "system";

  const [lines, setLines] = useState<Line[]>([
    { cls: "term-info", text: "Connected to " + workspace.name + "." },
    { cls: "term-info", text: "[cqlsh | " + workspace.info.serverVersion + " | CQL spec 3.4.x]" },
    { cls: "term-meta", text: "Use HELP for help." },
  ]);
  const [input, setInput] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const [curKs, setCurKs] = useState(initialKs);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines]);

  const out = (arr: Line[]) => setLines((ls) => [...ls, ...arr]);

  const runCmd = async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    out([{ cls: "cli-prompt", text: "cqlsh:" + curKs + "> " + cmd }]);
    setHist((h) => [cmd, ...h]);
    setHi(-1);
    const low = cmd.toLowerCase().replace(/;$/, "");
    if (low === "help") {
      out([
        {
          cls: "term-meta",
          text: "SELECT … FROM table WHERE …  ·  DESCRIBE KEYSPACES|TABLES|<table>  ·  USE <keyspace>  ·  nodetool status  ·  CLEAR",
        },
      ]);
      return;
    }
    if (low === "clear" || low === "cls") {
      setLines([]);
      return;
    }
    if (low === "nodetool status") {
      try {
        const s = await cassClusterStatus(handleId);
        out([
          {
            cls: "term-meta",
            text: "Datacenter: " + (s.nodes[0]?.dc ?? "—") + "\n===============",
          },
          { kind: "nodes", nodes: s.nodes },
        ]);
      } catch (e) {
        out([{ cls: "term-err", text: isAppErrorPayload(e) ? e.message : "nodetool failed" }]);
      }
      return;
    }
    try {
      const r = await cassRunCql(handleId, curKs, cmd);
      if (r.kind === "use") {
        setCurKs(r.keyspace);
        out([{ cls: "term-meta", text: "now using " + r.keyspace }]);
      } else if (r.kind === "list") {
        out([{ cls: "term-row", text: r.items.join("\n") }]);
      } else if (r.kind === "ddl") {
        out([{ cls: "term-json", text: r.text }]);
      } else if (r.kind === "ok") {
        out([{ cls: "term-meta", text: r.message }]);
      } else if (r.kind === "rows") {
        if (r.warnings.length) out([{ cls: "term-warn", text: "Warning: " + r.warnings[0] }]);
        out([
          { kind: "rows", columns: r.columns, rows: r.rows },
          { cls: "term-meta", text: "(" + r.returned + " rows)" },
        ]);
      }
    } catch (e) {
      out([
        {
          cls: "term-err",
          text: "InvalidRequest: " + (isAppErrorPayload(e) ? e.message : String(e)),
        },
      ]);
    }
  };

  return (
    <div className="rcli term mg-shell">
      <div className="rcli-body term-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {lines.map((l, i) =>
          "kind" in l && l.kind === "nodes" ? (
            <NodeTable key={i} nodes={l.nodes} />
          ) : "kind" in l && l.kind === "rows" ? (
            <ShellRowTable key={i} columns={l.columns} rows={l.rows} />
          ) : "cls" in l && l.cls === "term-json" ? (
            <pre key={i} className="term-json">
              {l.text}
            </pre>
          ) : "cls" in l ? (
            <div key={i} className={"rcli-line " + l.cls}>
              {l.text}
            </div>
          ) : null,
        )}
        <div className="rcli-inputline">
          <span className="rcli-prompt term-prompt-str">cqlsh:{curKs}&gt;</span>
          <input
            ref={inputRef}
            className="rcli-input"
            value={input}
            spellCheck={false}
            autoFocus
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void runCmd(input);
                setInput("");
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                const n = Math.min(hist.length - 1, hi + 1);
                if (n >= 0) {
                  setHi(n);
                  setInput(hist[n] ?? "");
                }
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const n = hi - 1;
                if (n < 0) {
                  setHi(-1);
                  setInput("");
                } else {
                  setHi(n);
                  setInput(hist[n] ?? "");
                }
              }
            }}
          />
        </div>
      </div>
      <div className="term-foot">
        <span className="term-schema">
          {workspace.name} · {curKs}
        </span>
        <div className="sql-snippets">
          {PRESETS.map((p) => (
            <button
              key={p}
              className="snippet-chip"
              onClick={() => {
                setInput(p);
                inputRef.current?.focus();
              }}
            >
              {p.length > 32 ? p.slice(0, 30) + "…" : p}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NodeTable({ nodes }: { nodes: NodeStatus[] }) {
  const cols: (keyof NodeStatus)[] = ["status", "address", "load", "owns", "dc", "rack", "tokens"];
  return (
    <div className="term-table-wrap">
      <table className="term-result-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map((n, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>
                  {c === "status" ? (
                    <span className="cass-node-up">{n.status ?? "?"}</span>
                  ) : (
                    String(n[c] ?? "—")
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShellRowTable({
  columns,
  rows,
}: {
  columns: CassColumn[];
  rows: Record<string, unknown>[];
}) {
  const cols = columns.slice(0, 7);
  if (!rows.length) return <div className="term-meta rcli-line">(0 rows)</div>;
  return (
    <div className="term-table-wrap">
      <table className="term-result-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.name}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.name}>
                  <CassValue v={r[c.name]} type={c.type} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
