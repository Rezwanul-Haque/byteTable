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
import { useT } from "../../../../shared/i18n/useT";
import {
  mongoAggregate,
  mongoCount,
  mongoFind,
  mongoListCollections,
  mongoListDatabases,
  mongoListIndexes,
  type FindRequest,
  type MongoDoc,
} from "../api";
import { useMongoActiveDbStore, useMongoShellStore, type ShellLine } from "../shellState";
import {
  fieldUnion,
  isDate,
  isOid,
  mongoStringify,
  mType,
  shellCalls,
  shellJson,
  shortDate,
} from "../helpers";
import { recordHistory } from "../../../console/state";

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
  injected,
}: {
  sessionId: string;
  workspaceId: string;
  handleId: string;
  db: string;
  serverVersion: string;
  serverHost: string;
  connName: string;
  onUseDb: (db: string) => void;
  /** Text handed to the prompt line from outside (the assistant) — set, focused,
   *  never run. A new `nonce` applies it again. */
  injected?: { text: string; nonce: number } | null;
}) {
  const ensure = useMongoShellStore((s) => s.ensure);
  const patch = useMongoShellStore((s) => s.patch);
  const session = useMongoShellStore((s) => s.sessions[sessionId]);
  // The sidebar's currently-selected database. The prompt follows it: switching
  // the sidebar db re-points a persisted session's prompt (a terminal-local
  // `use <db>` only changes `curDb`, not this, so it isn't clobbered).
  const selectedDb = useMongoActiveDbStore((s) => s.byWorkspace[workspaceId]);
  const t = useT();

  const [input, setInput] = useState("");
  const [hi, setHi] = useState(-1);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!injected) return;
    setInput(injected.text);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [injected]);

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
    // Mirrored to the docked panel's session, which the assistant reads to
    // explain the last command.
    recordHistory(workspaceId, sessionId, cmd);
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
      const m = low.match(/^use\s+(\w+)/);
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
      const chain = shellCalls(cmd);
      if (chain) {
        const collName = chain.coll;
        const [first, ...rest] = chain.calls;
        const op = first?.name ?? "";
        const parseArg = (s: string | undefined): unknown => (s?.trim() ? shellJson(s) : undefined);
        const arg = (k: number): unknown => parseArg(first?.args[k]);
        /** Chained calls that only shape the output, which the table already does. */
        const cosmetic = (name: string) => name === "pretty" || name === "toArray";
        if (op !== "find") {
          const bad = rest.find((c) => !cosmetic(c.name));
          if (bad) throw new Error(t("mongo.shell.badChain", { name: bad.name, op }));
        }
        if (op === "find") {
          // Cursor modifiers, as mongosh chains them. The terminal shows 20 by
          // default; .limit(n) asks for more, capped so a typo can't pull a
          // whole collection into the scrollback.
          const req: FindRequest = { filter: arg(0) ?? {}, projection: arg(1), limit: 20 };
          let count = false;
          for (const c of rest) {
            const v = parseArg(c.args[0]);
            if (c.name === "sort") req.sort = v;
            else if (c.name === "limit") req.limit = Math.min(Math.max(Number(v) || 20, 1), 1000);
            else if (c.name === "skip") req.skip = Math.max(Number(v) || 0, 0);
            else if (c.name === "projection") req.projection = v;
            else if (c.name === "count" || c.name === "countDocuments") count = true;
            else if (!cosmetic(c.name))
              throw new Error(t("mongo.shell.badChain", { name: c.name, op }));
          }
          if (count) {
            const n = await mongoCount(handleId, curDb, collName, req.filter);
            out([{ kind: "text", cls: "term-row", text: String(n) }]);
            return;
          }
          const shown = req.limit ?? 20;
          const r = await mongoFind(handleId, curDb, collName, req);
          out([
            docsTable(r.docs),
            {
              kind: "text",
              cls: "term-meta",
              text:
                t("mongo.shell.matched", { count: r.matched }) +
                (r.matched > r.returned
                  ? t("mongo.shell.showing", { count: r.returned || shown })
                  : ""),
            },
          ]);
        } else if (op === "findOne") {
          const r = await mongoFind(handleId, curDb, collName, {
            filter: arg(0) ?? {},
            projection: arg(1),
            limit: 1,
          });
          out([{ kind: "json", text: r.docs.length ? mongoStringify(r.docs[0]) : "null" }]);
        } else if (op === "countDocuments" || op === "count") {
          const n = await mongoCount(handleId, curDb, collName, arg(0) ?? {});
          out([{ kind: "text", cls: "term-row", text: String(n) }]);
        } else if (op === "aggregate") {
          const pipeline = (arg(0) as unknown[]) ?? [];
          const r = await mongoAggregate(handleId, curDb, collName, pipeline);
          out([
            docsTable(r.docs),
            {
              kind: "text",
              cls: "term-meta",
              text: t("mongo.shell.matched", { count: r.returned }),
            },
          ]);
        } else if (op === "getIndexes") {
          const idx = await mongoListIndexes(handleId, curDb, collName);
          out([{ kind: "json", text: mongoStringify(idx) }]);
        } else {
          out([{ kind: "text", cls: "term-err", text: t("mongo.shell.unsupported", { op }) }]);
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
      // A local parse error says what's wrong; a backend one comes as an AppError.
      const msg = e instanceof Error ? e.message : appErrorMessage(e, t("mongo.shell.cmdFail"));
      out([{ kind: "text", cls: "term-err", text: msg }]);
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
