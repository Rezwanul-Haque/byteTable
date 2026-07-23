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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { connectionSchemas, connectionTables } from "../connections/api";
import { queryRun, tableMeta, type CellValue, type QueryResult } from "../../shared/api/engine";
import { appErrorMessage } from "../../shared/api/error";
import type { Engine } from "../../shared/types";
import { Icon } from "../../shared/ui/Icon";
import { IconBtn } from "../../shared/ui/IconBtn";
import { CopyButton } from "../../shared/ui/CopyButton";
import { columnsKey, tablesKey, useIntrospectionStore } from "../introspection/state";
import {
  suggestSql,
  SUGGEST_KIND_LABEL,
  type EditorSchema,
  type Suggestion,
} from "../workspaces/components/sqlSuggest";
import { useWorkspacesStore } from "../workspaces/state";
import type { Workspace } from "../workspaces/types";
import { usePanelStore, type TermLine, type TermSession, type TermTextLine } from "./state";
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
  if (engine === "mssql") {
    // sqlcmd: numbered line prompts (`1>`/`2>`), `:`-prefixed meta commands, and
    // a `GO` batch terminator. The error prefix mimics a T-SQL parse error.
    return {
      shell: "sqlcmd",
      metaChar: ":",
      prompt: "1> ",
      cont: "2> ",
      banner: "sqlcmd · type :help for usage. Batch ends with GO.",
      errPrefix: "Msg 102, Level 15, State 1: ",
    };
  }
  if (engine === "clickhouse") {
    // clickhouse-client: `:)` prompt, `:-]` continuation, no meta-char (plain
    // SQL), PrettyCompact default output. The error prefix mimics a ClickHouse
    // DB::Exception.
    return {
      shell: "clickhouse-client",
      metaChar: null,
      prompt: ":) ",
      cont: ":-] ",
      banner:
        "ClickHouse client · type \\? for help, exit to close. Statements end with ; · FORMAT PrettyCompact by default.",
      errPrefix: "Code: 60. DB::Exception: ",
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
function asciiTableCore(headers: string[], cells: string[][], numeric: boolean[]): TermTextLine[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length), 0),
  );
  const lines: TermTextLine[] = [];
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

// Build an ASCII table from named string rows (meta-command output: \dt, \d).
function asciiObjTable(
  headers: string[],
  rows: Record<string, string>[],
  numeric?: boolean[],
): TermTextLine[] {
  const cells = rows.map((r) => headers.map((h) => r[h] ?? ""));
  return asciiTableCore(headers, cells, numeric ?? headers.map(() => false));
}

/** Open-autocomplete state for the terminal input: the replace range within
 *  the live input line, the ranked items, and the highlighted row. */
interface AcState {
  /** Replace [from, to) within the input string with the chosen insert. */
  from: number;
  to: number;
  items: Suggestion[];
  sel: number;
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
  // Autocomplete popup state (null = closed). `sel` is the highlighted row.
  const [ac, setAc] = useState<AcState | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // --- Autocomplete schema (shares the editor's suggester, sqlSuggest) -------
  // Same source as the SQL editor: the active connection's introspected schema
  // (table list + cached columns), read live so columns appear as they warm.
  const tablesCache = useIntrospectionStore((s) => s.tables);
  const columnsCache = useIntrospectionStore((s) => s.columns);
  const loadTables = useIntrospectionStore((s) => s.loadTables);
  const loadColumns = useIntrospectionStore((s) => s.loadColumns);
  const tableEntries = tablesCache[tablesKey(workspace.handleId, schemaName)]?.tables;

  const editorSchema = useMemo<EditorSchema>(
    () => ({
      tables: (tableEntries ?? []).map((t) => ({
        name: t.name,
        columns: (
          columnsCache[columnsKey(workspace.handleId, schemaName, t.name)]?.columns ?? []
        ).map((c) => ({ name: c.name, pk: c.pk })),
      })),
    }),
    [tableEntries, columnsCache, workspace.handleId, schemaName],
  );
  // Read the latest schema from the keystroke handlers without stale closures.
  const schemaRef = useRef(editorSchema);
  schemaRef.current = editorSchema;

  // Warm the table list (cache-first; a no-op once the sidebar has fetched it).
  useEffect(() => {
    void loadTables(workspace.handleId, schemaName);
  }, [loadTables, workspace.handleId, schemaName]);

  // Warm columns for tables referenced in the pending statement (buffer + the
  // live input line). Cache-first, so re-runs are free — no per-keystroke call.
  const pendingText = (session.buffer ? session.buffer + "\n" : "") + input;
  const referencedNames = useMemo(() => {
    const set = new Set<string>();
    const re = /\b(?:from|join|into|update)\s+([a-z_][\w$]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pendingText)) !== null) set.add(m[1]!.toLowerCase());
    return set;
  }, [pendingText]);
  useEffect(() => {
    for (const t of tableEntries ?? []) {
      if (referencedNames.has(t.name.toLowerCase())) {
        void loadColumns(workspace.handleId, schemaName, t.name);
      }
    }
  }, [referencedNames, tableEntries, loadColumns, workspace.handleId, schemaName]);

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
    if (engine === "mssql") {
      // `SELECT name FROM sys.tables` — a single `name` column + sqlcmd's
      // "(N rows affected)" trailer.
      return asciiObjTable(
        ["name"],
        names.map((n) => ({ name: n })),
      ).concat([{ cls: "term-meta", text: "(" + names.length + " rows affected)" }]);
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
    if (engine === "mssql") {
      return asciiObjTable(
        ["name"],
        names.map((s) => ({ name: s })),
      ).concat([{ cls: "term-meta", text: "(" + names.length + " rows affected)" }]);
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
    } else if (engine === "mssql") {
      rows = [
        "SELECT name FROM sys.tables;    list tables",
        "SELECT name FROM sys.schemas;   list schemas",
        "sp_help name                    describe table",
        "USE schema;                     switch schema",
        "GO                              end/run the batch",
        ":clear                          clear screen",
        ":quit / exit / quit             close terminal",
        "",
        "Any T-SQL runs against the engine (GO ends a batch).",
      ];
    } else if (engine === "clickhouse") {
      rows = [
        "SELECT ...;      run a query",
        "SHOW TABLES;     list tables",
        "DESCRIBE name;   describe table",
        "SHOW DATABASES;  list databases",
        "USE db;          switch database",
        "exit / quit      close terminal",
        "",
        "Any SQL ending in ; runs · results FORMAT PrettyCompact.",
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

    // universal quit (`:quit`/`:exit` are the sqlcmd forms)
    if (["\\q", ".quit", ".exit", "exit", "quit", "\\quit", ":quit", ":exit"].includes(low)) {
      onClose();
      return true;
    }
    // clear (forgiving across flavors; `:clear` for sqlcmd)
    if (
      low === "clear" ||
      low === ".clear" ||
      low === "\\! clear" ||
      low === "\\clear" ||
      low === ":clear"
    ) {
      setLines([]);
      return true;
    }
    if (low === "\\c" && (engine === "mysql" || engine === "sqlite")) {
      setLines([]);
      return true;
    }
    // help (`:help` is the sqlcmd form)
    if (["\\?", "\\h", ".help", "help", "\\help", ":help"].includes(low)) {
      appendLines(helpText());
      return true;
    }

    // SQL Server (sqlcmd) T-SQL meta forms: `SELECT … FROM sys.tables` lists
    // tables, `SELECT … FROM sys.schemas` lists schemas, `sp_help <name>` (or
    // `EXEC sp_help <name>`) describes a table. These give the sqlcmd REPL the
    // familiar catalog shortcuts (M21 §22.3). `USE <schema>` is handled by the
    // shared switch-schema branch below.
    if (engine === "mssql") {
      if (/^select\b[\s\S]*\bfrom\s+sys\.tables\b/i.test(low)) {
        void listTables()
          .then(appendLines)
          .catch((e: unknown) =>
            appendLines([{ cls: "term-err", text: cfg.errPrefix + appErrorMessage(e, "failed") }]),
          );
        return true;
      }
      if (/^select\b[\s\S]*\bfrom\s+sys\.schemas\b/i.test(low)) {
        void listSchemas()
          .then(appendLines)
          .catch((e: unknown) =>
            appendLines([{ cls: "term-err", text: cfg.errPrefix + appErrorMessage(e, "failed") }]),
          );
        return true;
      }
      const spHelp = t.replace(/;$/, "").match(/^(?:exec\s+)?sp_help\s+(.+)$/i);
      if (spHelp) {
        // Tolerate `dbo.`-qualified, bracket-, and quote-wrapped names.
        const name = spHelp[1]!
          .trim()
          .replace(/^dbo\./i, "")
          .replace(/^[[\]"']+|[[\]"']+$/g, "");
        void describe(name)
          .then(appendLines)
          .catch((e: unknown) =>
            appendLines([{ cls: "term-err", text: cfg.errPrefix + appErrorMessage(e, "failed") }]),
          );
        return true;
      }
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
          // SELECT results render as a real HTML table (not ASCII art), then
          // the conventional "(N rows)" line.
          out.push({
            kind: "grid",
            columns: res.columns.map((c) => c.name),
            rows: res.rows,
          });
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

    // SQL Server (sqlcmd): a lone `GO` runs the accumulated batch (M21 §22.3).
    // `;`-terminated statements still run immediately below (a friendlier REPL
    // than real sqlcmd); `GO` covers multi-statement / no-`;` batches.
    if (engine === "mssql" && rawLine.trim().toUpperCase() === "GO") {
      appendLines([echo]);
      const batch = buffer.trim();
      if (batch) runSql(batch);
      setBuffer("");
      pushHistory(rawLine);
      setHi(-1);
      setInput("");
      return;
    }

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

  // --- autocomplete helpers --------------------------------------------------
  // Recompute suggestions for the current line + caret. Context spans the whole
  // pending statement (any buffered lines + the live input), but the replace
  // range is mapped back into input-line coordinates (the typed word is always
  // within the live line). null result closes the popup.
  const computeAc = (value: string, caret: number, explicit: boolean) => {
    const prefix = session.buffer ? session.buffer + "\n" : "";
    const res = suggestSql(prefix + value, prefix.length + caret, schemaRef.current, { explicit });
    if (!res) {
      setAc(null);
      return;
    }
    setAc({
      from: Math.max(0, res.from - prefix.length),
      to: res.to - prefix.length,
      items: res.items,
      sel: 0,
    });
  };

  // Accept a suggestion: splice its insert into the line, close the popup, and
  // restore focus + caret just past the inserted text.
  const acceptItem = (state: AcState, item: Suggestion | undefined) => {
    if (!item) return;
    const next = input.slice(0, state.from) + item.insert + input.slice(state.to);
    const pos = state.from + item.insert.length;
    setInput(next);
    setAc(null);
    setHi(-1);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // While the popup is open it owns navigation / accept / dismiss.
    if (ac && ac.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAc({ ...ac, sel: (ac.sel + 1) % ac.items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAc({ ...ac, sel: (ac.sel - 1 + ac.items.length) % ac.items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptItem(ac, ac.items[ac.sel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAc(null);
        return;
      }
      // Caret-moving keys close the popup, then perform their default move
      // (onKeyUp re-derives context at the new caret).
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) setAc(null);
    }

    // Ctrl/Cmd+Space triggers the popup manually (even with no partial word).
    if ((e.ctrlKey || e.metaKey) && e.key === " ") {
      e.preventDefault();
      const el = e.currentTarget;
      computeAc(el.value, el.selectionStart ?? el.value.length, true);
      return;
    }

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

  // Re-derive suggestions after caret-only moves (Arrow Left/Right, Home/End)
  // that don't fire onChange.
  const onKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      const el = e.currentTarget;
      computeAc(el.value, el.selectionStart ?? el.value.length, false);
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
        : engine === "mssql"
          ? [
              "SELECT name FROM sys.tables;",
              "sp_help users",
              "SELECT * FROM users WHERE country = 'DE';",
            ]
          : engine === "clickhouse"
            ? [
                "SHOW TABLES;",
                "DESCRIBE orders;",
                "SELECT status, count() FROM orders GROUP BY status ORDER BY count() DESC;",
              ]
            : ["\\dt", "\\d orders", "SELECT * FROM users WHERE country = 'DE';"];

  const promptStr = session.buffer ? cfg.cont : cfg.prompt;

  // Keep the highlighted row visible as ↑/↓ move the selection.
  const acRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ac) return;
    acRef.current?.querySelector<HTMLElement>(".ac-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [ac]);

  // Caret-x of the popup: width of the line up to the replace start, measured in
  // the input's own font (canvas), offset by the prompt width (input.offsetLeft)
  // and any horizontal scroll. The popup is portaled to <body> with fixed
  // positioning so the terminal body's `overflow-y: auto` can't clip it; coords
  // come from the input's viewport rect (anchored just ABOVE the input line).
  const measureRef = useRef<CanvasRenderingContext2D | null>(null);
  const acPos = (() => {
    const el = inputRef.current;
    if (!ac || !el) return null;
    const rect = el.getBoundingClientRect();
    let x = rect.left;
    let ctx = measureRef.current;
    if (!ctx) {
      ctx = document.createElement("canvas").getContext("2d");
      measureRef.current = ctx;
    }
    if (ctx) {
      // Build the font from components — WKWebView (Tauri/macOS) often returns
      // an empty `font` shorthand, which would silently fall back to 10px sans.
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      x = rect.left + ctx.measureText(input.slice(0, ac.from)).width - el.scrollLeft;
    }
    return { left: Math.max(8, x), bottom: window.innerHeight - rect.top + 4 };
  })();

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
                setAc(null);
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
        {session.lines.map((l, i) =>
          "kind" in l ? (
            <TermGrid key={i} columns={l.columns} rows={l.rows} />
          ) : (
            <div key={i} className={"rcli-line " + l.cls}>
              {l.text || " "}
            </div>
          ),
        )}
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
            onChange={(e) => {
              setInput(e.target.value);
              computeAc(e.target.value, e.target.selectionStart ?? e.target.value.length, false);
            }}
            onKeyDown={onKey}
            onKeyUp={onKeyUp}
            onBlur={() => setAc(null)}
          />
        </div>
      </div>
      {ac && ac.items.length > 0 && acPos
        ? createPortal(
            <div
              ref={acRef}
              className="ac-popup term-ac"
              style={{ left: acPos.left, bottom: acPos.bottom }}
              role="listbox"
            >
              {ac.items.map((it, i) => (
                <div
                  key={i}
                  className={"ac-item" + (i === ac.sel ? " sel" : "")}
                  role="option"
                  aria-selected={i === ac.sel}
                  // mousedown (not click) so accept runs before the input blurs.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptItem(ac, it);
                  }}
                  onMouseEnter={() => setAc({ ...ac, sel: i })}
                >
                  <span
                    className={"msym ac-icon ac-icon-" + it.kind + (it.pk ? " ac-icon-pk" : "")}
                  >
                    {it.icon}
                  </span>
                  <span className="ac-label">{it.label}</span>
                  {it.kind === "column" && it.source ? (
                    <span className="ac-hint">{it.source}</span>
                  ) : null}
                  <span className="ac-kind">{SUGGEST_KIND_LABEL[it.kind]}</span>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// ---- compact HTML result table for terminal SELECT output ----
// A bordered grid with a header row, monospace cells, right-aligned blue
// numbers, italic NULLs, hover row highlight, and horizontal scroll when wider
// than the panel (.term-grid-wrap). Ported from the prototype's TermGrid;
// adapted to positional CellValue rows.
//
// Each cell has a hover copy button (mirrors the browse DataGrid's `.dg-copy`):
// the terminal refocuses its input on any body click, which collapses a text
// selection, so dragging to select a value is unreliable — the copy button is
// the dependable way to grab a single value.
function TermGrid({ columns, rows }: { columns: string[]; rows: CellValue[][] }) {
  if (columns.length === 0) return null;
  return (
    <div className="term-grid-wrap">
      <table className="term-grid">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="term-grid-empty" colSpan={columns.length}>
                0 rows
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>
                {columns.map((_, j) => {
                  const v = r[j] ?? null;
                  if (v === null || v === undefined) {
                    return (
                      <td key={j} className="term-grid-null">
                        NULL
                      </td>
                    );
                  }
                  const isNum = typeof v === "number";
                  const text = typeof v === "boolean" ? (v ? "t" : "f") : String(v);
                  return (
                    <td key={j} className={isNum ? "term-grid-num" : ""}>
                      <span className="term-cell-val">{text}</span>
                      <CopyButton className="term-copy" text={text} />
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
