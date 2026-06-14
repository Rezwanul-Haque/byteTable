// SQL terminal tab (M14) — a psql / mysql / sqlite3-style ASCII REPL, ported
// from ByteTable_latest/bytetable/terminal.jsx `SqlTerminalTab` + `termConfig`
// + `asciiTable`. The engine-aware REPL the TerminalPanel mounts for SQL
// sessions: engine-specific prompt/banner/errPrefix, meta-commands (\dt \d \dn
// \l \c \timing \! clear \q; SHOW TABLES/DATABASES, DESCRIBE, USE; .tables
// .schema .databases .timing .clear .quit), multi-line statement buffering
// until `;`, history (↑/↓), Ctrl+L clear, Ctrl+C cancel-line.
//
// The prototype runs against a SYNCHRONOUS mock (window.BT_ENGINE / BT_DATA);
// here the meta-commands and SQL are wired to the REAL async backend
// (queryRun / connectionTables / tableMeta / connectionSchemas) and the
// workspace store (setWorkspaceSchema = patchWorkspaceUi). Each handler echoes
// the input line immediately and pushes its result lines when the awaited call
// resolves; a concurrent submit is guarded while a call is in flight.
//
// Session state (lines / history / buffer / timing) lives in the panel store
// (state.ts) per session, so it survives workspace switches + panel hide.

import { useLayoutEffect, useRef, useState } from "react";

import { connectionSchemas, connectionTables } from "../connections/api";
import {
  queryRun,
  tableMeta,
  type CellValue,
  type ColumnMeta,
  type QueryResult,
} from "../../shared/api/engine";
import { appErrorMessage } from "../../shared/api/error";
import type { Engine } from "../../shared/types";
import { Icon } from "../../shared/ui/Icon";
import { IconBtn } from "../../shared/ui/IconBtn";
import { useWorkspacesStore } from "../workspaces/state";
import type { Workspace } from "../workspaces/types";
import { usePanelStore, type TermLine, type TermSession } from "./state";
import "./SqlTerminalTab.css";

// ---- engine-specific shell config (ported verbatim from termConfig) ----
interface TermConfig {
  shell: string;
  metaChar: string | null;
  prompt: string;
  cont: string;
  banner: string;
  errPrefix: string;
}

function termConfig(engine: Engine, connName: string): TermConfig {
  if (engine === "mysql") {
    return {
      shell: "mysql",
      metaChar: null,
      prompt: "mysql> ",
      cont: "    -> ",
      banner: "mysql · type \\h for help, \\q to close. Statements end with ;",
      errPrefix: "ERROR 1064 (42000): ",
    };
  }
  if (engine === "sqlite") {
    return {
      shell: "sqlite3",
      metaChar: ".",
      prompt: "sqlite> ",
      cont: "   ...> ",
      banner: 'SQLite version 3.46.0 · type ".help" for usage hints. Statements end with ;',
      errPrefix: "Parse error: ",
    };
  }
  // postgres
  return {
    shell: "psql",
    metaChar: "\\",
    prompt: connName + "=# ",
    cont: connName + "-# ",
    banner: "psql · type \\? for help, \\q to close. Statements end with ;",
    errPrefix: "ERROR:  ",
  };
}

// ---- psql-style ASCII table (ported from asciiTable) ----
// Core builder: `headers` are column titles, `cells` is a row-major grid of
// already-stringified values, `numeric` flags right-aligned columns. Returns
// { cls, text } lines: a centered header, a `--+--` rule, then one row each.
function asciiTableCore(headers: string[], cells: string[][], numeric: boolean[]): TermLine[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length), 0),
  );
  const lines: TermLine[] = [];
  // header: centered like psql (" col1 | col2 ").
  const head = headers
    .map((h, i) => {
      const pad = (widths[i] ?? 0) - h.length;
      const left = Math.floor(pad / 2);
      const right = pad - left;
      return " ".repeat(left + 1) + h + " ".repeat(right + 1);
    })
    .join("|");
  lines.push({ cls: "term-thead", text: head });
  lines.push({ cls: "term-rule", text: widths.map((w) => "-".repeat(w + 2)).join("+") });
  cells.forEach((r) => {
    const line = headers
      .map((_, i) => {
        const v = r[i] ?? "";
        const padN = (widths[i] ?? 0) - v.length;
        return numeric[i] ? " " + " ".repeat(padN) + v + " " : " " + v + " ".repeat(padN) + " ";
      })
      .join("|");
    lines.push({ cls: "term-row", text: line });
  });
  return lines;
}

// Render a CellValue per psql conventions: null/undefined → "", boolean → t/f,
// else String(v).
function fmtCell(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "t" : "f";
  return String(v);
}

const NUMERIC_TYPE = /INT|NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT/;

// Build an ASCII table from a QueryResult (right-align numeric columns: by the
// column's type hint, or all-numeric values when the hint is uninformative).
function asciiTable(columns: ColumnMeta[], rows: CellValue[][]): TermLine[] {
  const headers = columns.map((c) => c.name);
  const numeric = columns.map((c, i) =>
    NUMERIC_TYPE.test((c.typeHint || "").toUpperCase())
      ? true
      : rows.length > 0 && rows.every((r) => r[i] == null || typeof r[i] === "number"),
  );
  const cells = rows.map((r) => columns.map((_, i) => fmtCell(r[i] ?? null)));
  return asciiTableCore(headers, cells, numeric);
}

// Build an ASCII table from named string rows (meta-command output: \dt, \d).
function asciiObjTable(
  headers: string[],
  rows: Record<string, string>[],
  numeric?: boolean[],
): TermLine[] {
  const cells = rows.map((r) => headers.map((h) => r[h] ?? ""));
  return asciiTableCore(headers, cells, numeric ?? headers.map(() => false));
}

interface SqlTerminalTabProps {
  workspace: Workspace;
  session: TermSession;
  /** Kill this session (the `\q` / quit meta-command). */
  onClose: () => void;
  /** True when hosted inside the panel (hides the title/schema in the toolbar). */
  embedded?: boolean;
}

export function SqlTerminalTab({ workspace, session, onClose, embedded }: SqlTerminalTabProps) {
  const wsId = workspace.id;
  const engine = workspace.saved.engine;
  const connName = workspace.name;
  const cfg = termConfig(engine, connName);

  const patchSession = usePanelStore((s) => s.patchSession);
  const patchWorkspaceUi = useWorkspacesStore((s) => s.patchWorkspaceUi);

  // Active schema this session runs against — mirrors SqlEditorTab's resolution
  // (sidebar switcher, falling back to the connection's first schema).
  const schemaName =
    (workspace.ui.schemaName !== undefined &&
    workspace.schemas.some((s) => s.name === workspace.ui.schemaName)
      ? workspace.ui.schemaName
      : workspace.schemas[0]?.name) ?? "main";

  const serverVersion = workspace.info.serverVersion;
  const schemaNames = workspace.schemas.map((s) => s.name);

  const [input, setInput] = useState("");
  // History cursor: -1 = the live (unsubmitted) input, 0 = most recent.
  const [hi, setHi] = useState(-1);
  const [running, setRunning] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Banner: seed on first mount when the session has no lines yet.
  const seeded = useRef(false);
  useLayoutEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (session.lines.length === 0) {
      patchSession(wsId, session.id, {
        lines: [
          { cls: "term-info", text: "Connected to " + connName + " (" + serverVersion + ")." },
          { cls: "term-info", text: cfg.banner },
        ],
      });
    }
    // Run once on mount; session identity is stable for this component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to the bottom on a new line / while running.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [session.lines.length, running]);

  // --- transcript helpers (read latest state via the store, never stale) ---
  const appendLines = (more: TermLine[]) => {
    if (more.length === 0) return;
    const cur = usePanelStore
      .getState()
      .byWorkspace[wsId]?.sessions.find((s) => s.id === session.id);
    patchSession(wsId, session.id, { lines: [...(cur?.lines ?? []), ...more] });
  };
  const setLines = (lines: TermLine[]) => patchSession(wsId, session.id, { lines });
  const setBuffer = (buffer: string) => patchSession(wsId, session.id, { buffer });
  const setTiming = (timing: boolean) => patchSession(wsId, session.id, { timing });
  const pushHistory = (line: string) => {
    if (!line.trim()) return;
    const cur = usePanelStore
      .getState()
      .byWorkspace[wsId]?.sessions.find((s) => s.id === session.id);
    patchSession(wsId, session.id, {
      history: [line, ...(cur?.history ?? [])].slice(0, 80),
    });
  };

  // ---- meta-command formatters (wired to the REAL backend) ----
  const listTables = async (): Promise<TermLine[]> => {
    const tables = await connectionTables(workspace.handleId, schemaName);
    const names = tables.map((t) => t.name);
    if (engine === "mysql") {
      const col = "Tables_in_" + schemaName;
      return asciiObjTable(
        [col],
        names.map((n) => ({ [col]: n })),
      ).concat([{ cls: "term-meta", text: names.length + " rows in set" }]);
    }
    if (engine === "sqlite") {
      return [{ cls: "term-row", text: names.join("  ") }];
    }
    // postgres \dt
    const rows = names.map((n) => ({
      Schema: schemaName,
      Name: n,
      Type: "table",
      Owner: connName,
    }));
    return [{ cls: "term-meta", text: "List of relations" }]
      .concat(asciiObjTable(["Schema", "Name", "Type", "Owner"], rows))
      .concat([{ cls: "term-meta", text: "(" + names.length + " rows)" }]);
  };

  const listSchemas = async (): Promise<TermLine[]> => {
    let names = schemaNames;
    if (names.length === 0) {
      const fetched = await connectionSchemas(workspace.handleId);
      names = fetched.map((s) => s.name);
    }
    if (engine === "mysql") {
      return asciiObjTable(
        ["Database"],
        names.map((s) => ({ Database: s })),
      );
    }
    const rows = names.map((s) => ({ Name: s, Owner: connName }));
    return [{ cls: "term-meta", text: "List of schemas" }].concat(
      asciiObjTable(["Name", "Owner"], rows),
    );
  };

  const describe = async (name: string): Promise<TermLine[]> => {
    let meta;
    try {
      meta = await tableMeta(workspace.handleId, schemaName, name);
    } catch {
      return [{ cls: "term-err", text: cfg.errPrefix + 'relation "' + name + '" does not exist' }];
    }
    const out: TermLine[] = [
      {
        cls: "term-meta",
        text: engine === "postgres" ? 'Table "' + schemaName + "." + name + '"' : "Table: " + name,
      },
    ];
    const rows = meta.columns.map((c) => ({
      Column: c.name,
      Type: (c.dataType || "").toLowerCase(),
      Nullable: c.nullable ? "" : "not null",
      Default: c.default == null ? "" : c.default,
    }));
    asciiObjTable(["Column", "Type", "Nullable", "Default"], rows).forEach((x) => out.push(x));
    if (meta.indexes.length) {
      out.push({ cls: "term-meta", text: "Indexes:" });
      meta.indexes.forEach((ix) =>
        out.push({
          cls: "term-row",
          text:
            '    "' +
            ix.name +
            '"' +
            (ix.primary ? " PRIMARY KEY," : ix.unique ? " UNIQUE," : "") +
            " (" +
            ix.columns.join(", ") +
            ")",
        }),
      );
    }
    if (meta.foreignKeys.length) {
      out.push({ cls: "term-meta", text: "Foreign-key constraints:" });
      meta.foreignKeys.forEach((fk) =>
        out.push({
          cls: "term-row",
          text:
            '    "' +
            (fk.name ?? "") +
            '" FOREIGN KEY (' +
            fk.columns.join(", ") +
            ") REFERENCES " +
            fk.refTable +
            "(" +
            fk.refColumns.join(", ") +
            ")",
        }),
      );
    }
    return out;
  };

  const showSchema = async (name: string): Promise<TermLine[]> => {
    if (name) {
      let meta;
      try {
        meta = await tableMeta(workspace.handleId, schemaName, name);
      } catch {
        return [{ cls: "term-err", text: "no such table: " + name }];
      }
      const ddl = meta.ddl ?? "";
      return ddl.split("\n").map((x) => ({ cls: "term-row", text: x }));
    }
    // all tables' DDL
    const tables = await connectionTables(workspace.handleId, schemaName);
    if (tables.length === 0) return [{ cls: "term-meta", text: "no tables" }];
    const out: TermLine[] = [];
    for (const t of tables) {
      try {
        const meta = await tableMeta(workspace.handleId, schemaName, t.name);
        (meta.ddl ?? "").split("\n").forEach((x) => out.push({ cls: "term-row", text: x }));
      } catch {
        // skip a table that vanished mid-iteration
      }
    }
    return out;
  };

  const helpText = (): TermLine[] => {
    let rows: string[];
    if (engine === "postgres") {
      rows = [
        "\\dt            list tables",
        "\\d  NAME       describe table",
        "\\dn            list schemas",
        "\\l             list databases",
        "\\c  SCHEMA     switch schema",
        "\\timing        toggle timing",
        "\\! clear       clear screen",
        "\\q             close terminal",
        "",
        "Any SQL ending in ; runs against the engine.",
      ];
    } else if (engine === "mysql") {
      rows = [
        "SHOW TABLES;       list tables",
        "SHOW DATABASES;    list schemas",
        "DESCRIBE name;     describe table",
        "USE schema;        switch schema",
        "\\c                 clear screen",
        "\\q / exit / quit   close terminal",
        "",
        "Any SQL ending in ; runs against the engine.",
      ];
    } else {
      rows = [
        ".tables          list tables",
        ".schema NAME     show CREATE statement",
        ".databases       list schemas/attached",
        ".timing on|off   toggle timing",
        ".clear           clear screen",
        ".quit            close terminal",
        "",
        "Any SQL ending in ; runs against the engine.",
      ];
    }
    return rows.map((t) => ({ cls: "term-help", text: t }));
  };

  // Run a meta-command. Returns true when handled (so submit skips SQL). Async
  // results are appended when resolved. `synchronous` results (clear/quit/help/
  // timing) push immediately. Be forgiving across engine flavors (ported).
  const runMeta = (raw: string): boolean => {
    const t = raw.trim();
    const low = t.toLowerCase().replace(/;$/, "");
    const arg = (t.replace(/;$/, "").split(/\s+/)[1] || "").trim();

    // universal quit
    if (["\\q", ".quit", ".exit", "exit", "quit", "\\quit"].includes(low)) {
      onClose();
      return true;
    }
    // clear (forgiving across flavors)
    if (low === "clear" || low === ".clear" || low === "\\! clear" || low === "\\clear") {
      setLines([]);
      return true;
    }
    if (low === "\\c" && (engine === "mysql" || engine === "sqlite")) {
      setLines([]);
      return true;
    }
    // help
    if (["\\?", "\\h", ".help", "help", "\\help"].includes(low)) {
      appendLines(helpText());
      return true;
    }

    // timing toggles
    if (low === "\\timing" || low === ".timing on" || low === ".timing") {
      setTiming(true);
      appendLines([{ cls: "term-meta", text: "Timing is on." }]);
      return true;
    }
    if (low === ".timing off") {
      setTiming(false);
      appendLines([{ cls: "term-meta", text: "Timing is off." }]);
      return true;
    }

    // list tables
    if (["\\dt", "\\d", ".tables", "show tables"].includes(low)) {
      void listTables()
        .then(appendLines)
        .catch((e: unknown) =>
          appendLines([{ cls: "term-err", text: cfg.errPrefix + appErrorMessage(e, "failed") }]),
        );
      return true;
    }
    // list schemas / databases
    if (["\\dn", "\\l", ".databases", "show databases", "show schemas"].includes(low)) {
      void listSchemas()
        .then(appendLines)
        .catch((e: unknown) =>
          appendLines([{ cls: "term-err", text: cfg.errPrefix + appErrorMessage(e, "failed") }]),
        );
      return true;
    }

    // describe: \d name | describe name | desc name | show columns from name
    let descName: string | null = null;
    if (/^\\d\s+\S/.test(t)) descName = arg;
    else if (/^(describe|desc)\s+\S/i.test(t)) descName = arg;
    else if (/^show\s+columns\s+from\s+\S/i.test(low))
      descName = low.replace(/;$/, "").split(/\s+/).pop() ?? null;
    if (descName) {
      const name = descName;
      void describe(name)
        .then(appendLines)
        .catch((e: unknown) =>
          appendLines([{ cls: "term-err", text: cfg.errPrefix + appErrorMessage(e, "failed") }]),
        );
      return true;
    }

    // .schema [NAME] (sqlite DDL)
    if (/^\.schema(\s|$)/.test(low)) {
      void showSchema(arg)
        .then(appendLines)
        .catch((e: unknown) =>
          appendLines([{ cls: "term-err", text: cfg.errPrefix + appErrorMessage(e, "failed") }]),
        );
      return true;
    }

    // switch schema: \c name | use name
    if (/^\\c\s+\S/.test(t) || /^use\s+\S/i.test(low)) {
      const target = arg.replace(/;$/, "");
      if (schemaNames.includes(target)) {
        patchWorkspaceUi(wsId, { schemaName: target });
        appendLines([
          {
            cls: "term-meta",
            text:
              engine === "mysql"
                ? "Database changed"
                : 'You are now connected to schema "' + target + '".',
          },
        ]);
      } else {
        appendLines([
          { cls: "term-err", text: cfg.errPrefix + 'schema "' + target + '" does not exist' },
        ]);
      }
      return true;
    }

    // unknown backslash/dot command
    if (
      (cfg.metaChar && t.startsWith(cfg.metaChar)) ||
      (engine === "mysql" && t.startsWith("\\"))
    ) {
      appendLines([{ cls: "term-err", text: "unknown command: " + t.split(/\s+/)[0] }]);
      return true;
    }
    return false;
  };

  // Run a SQL statement against the real engine; append the formatted result.
  const runSql = (sql: string) => {
    setRunning(true);
    const started = performance.now();
    queryRun(workspace.handleId, sql, { schema: schemaName })
      .then((res: QueryResult) => {
        const out: TermLine[] = [];
        if (res.columns.length > 0) {
          asciiTable(res.columns, res.rows).forEach((x) => out.push(x));
          out.push({
            cls: "term-meta",
            text: "(" + res.rowCount + " row" + (res.rowCount === 1 ? "" : "s") + ")",
          });
        } else {
          // non-SELECT: a sensible "Query OK" line (mysql-style affected count).
          out.push({
            cls: "term-meta",
            text:
              engine === "mysql"
                ? "Query OK, " +
                  res.rowCount +
                  " row" +
                  (res.rowCount === 1 ? "" : "s") +
                  " affected"
                : "Query OK",
          });
        }
        // Read the latest timing flag (the user may have toggled \timing).
        const cur = usePanelStore
          .getState()
          .byWorkspace[wsId]?.sessions.find((s) => s.id === session.id);
        if (cur?.timing) {
          const ms = res.elapsedMs || Math.round(performance.now() - started);
          out.push({ cls: "term-meta", text: "Time: " + ms + " ms" });
        }
        appendLines(out);
      })
      .catch((e: unknown) => {
        appendLines([
          { cls: "term-err", text: cfg.errPrefix + appErrorMessage(e, "query failed") },
        ]);
      })
      .finally(() => {
        setRunning(false);
        inputRef.current?.focus();
      });
  };

  const submit = (rawLine: string) => {
    if (running) return; // guard concurrent submit while a call is in flight.
    const buffer = session.buffer;
    const promptStr = buffer ? cfg.cont : cfg.prompt;
    const echo: TermLine = { cls: "term-prompt", text: promptStr + rawLine };

    // meta-commands only when the buffer is empty (a fresh statement).
    if (!buffer) {
      // Echo first so meta output appears below the typed line.
      appendLines([echo]);
      const handled = runMeta(rawLine);
      if (handled) {
        pushHistory(rawLine);
        setHi(-1);
        setInput("");
        return;
      }
      // Not a meta-command: fall through to SQL accumulation, but the echo is
      // already pushed — accumulate/run without re-echoing.
      const combined = rawLine;
      if (combined.includes(";")) {
        const stmt = combined.slice(0, combined.lastIndexOf(";"));
        runSql(stmt);
        setBuffer("");
      } else {
        setBuffer(combined);
      }
      pushHistory(rawLine);
      setHi(-1);
      setInput("");
      return;
    }

    // mid multi-line buffer: echo + accumulate/run.
    appendLines([echo]);
    const combined = buffer + "\n" + rawLine;
    if (combined.includes(";")) {
      const stmt = combined.slice(0, combined.lastIndexOf(";"));
      runSql(stmt);
      setBuffer("");
    } else {
      setBuffer(combined);
    }
    pushHistory(rawLine);
    setHi(-1);
    setInput("");
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.min(hi + 1, session.history.length - 1);
      if (n >= 0 && session.history[n] != null) {
        setHi(n);
        setInput(session.history[n] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = hi - 1;
      if (n < 0) {
        setHi(-1);
        setInput("");
      } else {
        setHi(n);
        setInput(session.history[n] ?? "");
      }
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      appendLines([
        { cls: "term-prompt", text: (session.buffer ? cfg.cont : cfg.prompt) + input + "^C" },
      ]);
      setBuffer("");
      setInput("");
    }
  };

  const snippets =
    engine === "sqlite"
      ? [".tables", ".schema users", "SELECT * FROM users LIMIT 5;"]
      : engine === "mysql"
        ? [
            "SHOW TABLES;",
            "DESCRIBE orders;",
            "SELECT status, COUNT(*) FROM orders GROUP BY status;",
          ]
        : ["\\dt", "\\d orders", "SELECT * FROM users WHERE country = 'DE';"];

  const promptStr = session.buffer ? cfg.cont : cfg.prompt;

  return (
    <div className="rcli term">
      <div className="rcli-toolbar">
        <Icon name="terminal" size={15} style={{ color: "var(--accent)" }} />
        {!embedded ? <span className="rcli-title">{cfg.shell}</span> : null}
        {!embedded ? (
          <span className="term-schema">
            {connName} · {schemaName}
          </span>
        ) : null}
        <div className="sql-snippets">
          {snippets.map((c) => (
            <button
              key={c}
              type="button"
              className="snippet-chip"
              onClick={() => {
                setInput(c);
                inputRef.current?.focus();
              }}
            >
              {c}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {session.timing ? <span className="term-timing">timing on</span> : null}
        <IconBtn
          icon="delete_sweep"
          size={15}
          title="Clear (Ctrl+L)"
          onClick={() => setLines([])}
        />
      </div>
      <div className="rcli-body term-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {session.lines.map((l, i) => (
          <div key={i} className={"rcli-line " + l.cls}>
            {l.text || " "}
          </div>
        ))}
        <div className="rcli-inputline">
          <span className="rcli-prompt term-prompt-str">{promptStr}</span>
          <input
            ref={inputRef}
            className="rcli-input"
            value={input}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="SQL command"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
      </div>
    </div>
  );
}
