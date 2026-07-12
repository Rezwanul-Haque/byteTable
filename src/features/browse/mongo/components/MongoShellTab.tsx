// MongoDB mongosh terminal (M18 §18.6): the raw shell surface using the shared
// .rcli terminal chrome. Banner, db> prompt, ↑/↓ history, preset chips, and a
// guarded command set (find / findOne / aggregate / countDocuments / getIndexes,
// show dbs / show collections / use <db>) routed through the backend engine.
// Result cursors render via MongoTermTable.
//
// Scrollback/history/current-db are persisted in `useMongoShellStore`, keyed by
// the docked-panel session id, so they survive hiding the panel + switching
// workspaces — like the SQL/Redis terminals. Only the input box and the history
// cursor are transient local state.

import { useEffect, useRef, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import {
  mongoAggregate,
  mongoCount,
  mongoFind,
  mongoListCollections,
  mongoListDatabases,
  mongoListIndexes,
  type MongoDoc,
} from "../api";
import { useMongoActiveDbStore, useMongoShellStore, type ShellLine } from "../shellState";
import { fieldUnion, isDate, isOid, mongoStringify, mType, shortDate } from "../helpers";

const BANNER = (server: string, version: string): ShellLine[] => [
  { kind: "text", cls: "term-info", text: "Current Mongosh Log ID: 66a1f2…" },
  { kind: "text", cls: "term-info", text: "Connecting to: " + server },
  {
    kind: "text",
    cls: "term-info",
    text: "Using MongoDB: " + version.replace("MongoDB ", "") + "   Using Mongosh: 2.2.6",
  },
  { kind: "text", cls: "term-meta", text: "Type 'help' for a list of commands." },
];

const PRESETS = [
  'db.orders.find({ status: "paid" })',
  'db.orders.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])',
  "db.users.countDocuments()",
  "show collections",
];

function MongoTermTable({ rows, cols }: { rows: MongoDoc[]; cols: string[] }) {
  const cell = (v: unknown) => {
    if (v === undefined || v === null) return <span className="cell-null">—</span>;
    const t = mType(v);
    if (t === "objectId" && isOid(v)) return <span className="mg-oid">{v.$oid.slice(-8)}</span>;
    if (t === "date" && isDate(v)) return shortDate(v.$date).slice(0, 16);
    if (t === "array") return "[" + (v as unknown[]).length + "]";
    if (t === "object") return "{…}";
    return String(v);
  };
  return (
    <div className="term-grid-wrap">
      <table className="term-grid">
        <thead className="term-thead">
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{cell(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MongoShellTab({
  sessionId,
  workspaceId,
  handleId,
  db,
  serverVersion,
  serverHost,
  connName,
  onUseDb,
}: {
  sessionId: string;
  workspaceId: string;
  handleId: string;
  db: string;
  serverVersion: string;
  serverHost: string;
  connName: string;
  onUseDb: (db: string) => void;
}) {
  const ensure = useMongoShellStore((s) => s.ensure);
  const patch = useMongoShellStore((s) => s.patch);
  const session = useMongoShellStore((s) => s.sessions[sessionId]);
  // The sidebar's currently-selected database. The prompt follows it: switching
  // the sidebar db re-points a persisted session's prompt (a terminal-local
  // `use <db>` only changes `curDb`, not this, so it isn't clobbered).
  const selectedDb = useMongoActiveDbStore((s) => s.byWorkspace[workspaceId]);

  const [input, setInput] = useState("");
  const [hi, setHi] = useState(-1);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Seed the transcript once (restored from the store on reopen).
  useEffect(() => {
    ensure(sessionId, {
      lines: BANNER(serverHost, serverVersion),
      history: [],
      curDb: selectedDb ?? db,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Follow the sidebar: when the selected db changes, re-point the prompt.
  useEffect(() => {
    if (selectedDb && useMongoShellStore.getState().sessions[sessionId]?.curDb !== selectedDb) {
      patch(sessionId, { curDb: selectedDb });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDb, sessionId]);

  const lines = session?.lines ?? BANNER(serverHost, serverVersion);
  const hist = session?.history ?? [];
  const curDb = session?.curDb ?? selectedDb ?? db;

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines]);

  /** Current persisted session (read at call time to avoid stale closures). */
  const peek = () => useMongoShellStore.getState().sessions[sessionId];
  const out = (arr: ShellLine[]) => {
    const cur = peek()?.lines ?? lines;
    patch(sessionId, { lines: [...cur, ...arr] });
  };
  const setCurDb = (next: string) => patch(sessionId, { curDb: next });

  const docsTable = (docs: MongoDoc[]): ShellLine => ({
    kind: "table",
    rows: docs.slice(0, 20),
    cols: fieldUnion(docs).slice(0, 6),
  });

  async function runCmd(raw: string) {
    const cmd = raw.trim();
    if (!cmd) return;
    out([{ kind: "text", cls: "cli-prompt", text: curDb + "> " + cmd }]);
    patch(sessionId, { history: [cmd, ...(peek()?.history ?? [])] });
    setHi(-1);
    const low = cmd.toLowerCase();
    try {
      if (low === "help") {
        out([
          {
            kind: "text",
            cls: "term-meta",
            text: "db.<coll>.find({…})  ·  db.<coll>.aggregate([…])  ·  db.<coll>.countDocuments()  ·  db.<coll>.getIndexes()  ·  use <db>  ·  show dbs  ·  show collections  ·  cls",
          },
        ]);
        return;
      }
      if (low === "cls" || low === "clear") {
        patch(sessionId, { lines: [] });
        return;
      }
      if (low === "show dbs" || low === "show databases") {
        const names = await mongoListDatabases(handleId);
        out([{ kind: "table", rows: names.map((n) => ({ name: n })), cols: ["name"] }]);
        return;
      }
      let m = low.match(/^use\s+(\w+)/);
      if (m) {
        const target = cmd.split(/\s+/)[1] ?? "";
        const names = await mongoListDatabases(handleId);
        if (names.includes(target)) {
          setCurDb(target);
          onUseDb(target);
          out([{ kind: "text", cls: "term-meta", text: "switched to db " + target }]);
        } else {
          out([{ kind: "text", cls: "term-err", text: "database " + target + " not found" }]);
        }
        return;
      }
      if (low === "show collections" || low === "db.getcollectionnames()") {
        const colls = await mongoListCollections(handleId, curDb);
        out([{ kind: "text", cls: "term-row", text: colls.map((c) => c.name).join("\n") }]);
        return;
      }
      m = cmd.match(/^db\.(\w+)\.(\w+)\(([\s\S]*)\)\s*;?\s*$/);
      if (m) {
        const collName = m[1] ?? "";
        const op = m[2] ?? "";
        const argsRaw = m[3] ?? "";
        const parseArg = (s: string): unknown => (s.trim() ? JSON.parse(s) : undefined);
        if (op === "find") {
          const filter = parseArg(argsRaw.split(/,(?![^{}[\]]*[}\]])/)[0] ?? "") ?? {};
          const r = await mongoFind(handleId, curDb, collName, { filter, limit: 20 });
          out([
            docsTable(r.docs),
            {
              kind: "text",
              cls: "term-meta",
              text:
                r.matched +
                " document" +
                (r.matched === 1 ? "" : "s") +
                (r.matched > 20 ? " (showing 20)" : ""),
            },
          ]);
        } else if (op === "findOne") {
          const r = await mongoFind(handleId, curDb, collName, {
            filter: parseArg(argsRaw) ?? {},
            limit: 1,
          });
          out([{ kind: "json", text: r.docs.length ? mongoStringify(r.docs[0]) : "null" }]);
        } else if (op === "countDocuments" || op === "count") {
          const n = await mongoCount(handleId, curDb, collName, parseArg(argsRaw) ?? {});
          out([{ kind: "text", cls: "term-row", text: String(n) }]);
        } else if (op === "aggregate") {
          const pipeline = (parseArg(argsRaw) as unknown[]) ?? [];
          const r = await mongoAggregate(handleId, curDb, collName, pipeline);
          out([
            docsTable(r.docs),
            {
              kind: "text",
              cls: "term-meta",
              text: r.returned + " document" + (r.returned === 1 ? "" : "s"),
            },
          ]);
        } else if (op === "getIndexes") {
          const idx = await mongoListIndexes(handleId, curDb, collName);
          out([{ kind: "json", text: mongoStringify(idx) }]);
        } else {
          out([{ kind: "text", cls: "term-err", text: "unsupported op: " + op }]);
        }
        return;
      }
      out([
        {
          kind: "text",
          cls: "term-err",
          text: "SyntaxError: try db.<collection>.find({…}) or 'help'",
        },
      ]);
    } catch (e) {
      out([{ kind: "text", cls: "term-err", text: appErrorMessage(e, "Command failed") }]);
    }
  }

  return (
    <div className="rcli term mg-shell">
      <div className="rcli-body term-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {lines.map((l, i) =>
          l.kind === "table" ? (
            <MongoTermTable key={i} rows={l.rows} cols={l.cols} />
          ) : l.kind === "json" ? (
            <pre key={i} className="term-json">
              {l.text}
            </pre>
          ) : (
            <div key={i} className={"rcli-line " + l.cls}>
              {l.text}
            </div>
          ),
        )}
        <div className="rcli-inputline">
          <span className="rcli-prompt term-prompt-str">{curDb}&gt;</span>
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
          {connName} · {curDb}
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
              {p.length > 30 ? p.slice(0, 28) + "…" : p}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
