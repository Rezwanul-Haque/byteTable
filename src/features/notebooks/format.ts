// Query notebooks (M47) — the file format, ported exactly from the prototype's
// notebook.jsx (`window.BT_NOTEBOOK`).
//
// THE FILE IS THE NOTEBOOK. Notes are Markdown, each query is a ```sql block,
// and a result (optional) is a Markdown table between two bt:result comments.
// It reads correctly on any git host, diffs line by line, and holds no host,
// user, password or connection string — only the connection's NAME. There is
// no sidecar and no cell id: the app rebuilds the notebook from the text alone.
//
// One difference from the prototype: result rows are arrays, not objects keyed
// by column name, because `SELECT *` across a join returns two `id` columns.

import type { CellValue } from "../../shared/api/engine";

/** The format version this build writes and reads. */
export const VERSION = 1;
/** Rows of each result written to the file. */
export const MAX_SAVED_ROWS = 20;
/** Rows of each result drawn in a cell. */
export const MAX_SHOWN_ROWS = 200;

export interface NbResult {
  columns: string[];
  /** At most MAX_SHOWN_ROWS (MAX_SAVED_ROWS when read from a file). */
  rows: CellValue[][];
  /** Rows the query returned in total. */
  rowCount: number;
  /** The run hit the row ceiling, so `rowCount` is a lower bound. */
  truncated?: boolean;
  ms: number;
  /** UTC, to the minute: `2026-11-22T11:41Z`. */
  at: string;
  /** Read from the file rather than run in this session. */
  saved: boolean;
}

export interface NoteCell {
  id: string;
  type: "note";
  text: string;
}

/** What a confirmed-but-not-yet-run write is waiting on. */
export interface WriteConfirm {
  /** Rows the statement would change, when that could be counted. */
  rows: number | null;
  /** Why the count could not be made; the confirmation then offers Cancel only
   *  when it is an error, and a count-free Run otherwise. */
  error?: string;
  /** The workspace is read-only: no Run button at all (F5). */
  readOnly?: boolean;
  prod: boolean;
  /** The verb, for "Run UPDATE". */
  verb: string;
  /** Still counting. */
  counting?: boolean;
}

export interface QueryCell {
  id: string;
  type: "query";
  sql: string;
  /** The SQL that produced `result`; the result is CURRENT only while equal. */
  ranSql: string | null;
  result: NbResult | null;
  view: "table" | "chart";
  collapsed?: boolean;
  // ---- transient: never written to the file ----
  running?: boolean;
  /** The backend run id while running, for Stop. */
  runId?: string;
  error?: string | null;
  notice?: string | null;
  /** The write behind `notice` was recorded in the change history (M48). */
  recorded?: boolean;
  confirm?: WriteConfirm | null;
  skipped?: boolean;
}

export type Cell = NoteCell | QueryCell;

export interface Notebook {
  title: string;
  /** The connection's NAME only. Empty = not recorded. */
  connection: string;
  schema: string;
  cells: Cell[];
  /** `bytetable: notebook/N`; 1 when the file does not say. */
  version: number;
  /** The file held at least one result. */
  hadResults: boolean;
}

let seq = 0;
/** A cell id. Session-local: ids are never written to the file. */
export const uid = () => `nb${Date.now().toString(36)}${(++seq).toString(36)}`;

export const slug = (title: string) =>
  String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";

/** The suggested file name for a title: `cancelled-orders-review.md`. */
export const fileOf = (title: string) => slug(title) + ".md";

/** The title a new notebook starts with. */
export const UNTITLED = "Untitled notebook";

/** Still carrying the default title (or none): saving names it after its file. */
export const isUntitled = (title: string) => !title.trim() || title.trim() === UNTITLED;

/** A title from a file name, as Jupyter names a notebook after its file:
 *  `some-queries_notebook.md` → `Some queries notebook`. */
export function titleFromFile(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").replace(/\.(md|markdown)$/i, "");
  const words = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : UNTITLED;
}

/** Now (or `d`), as the file writes it: UTC to the minute. */
export const stamp = (d: Date = new Date()) => d.toISOString().slice(0, 16) + "Z";

// ---- one value <-> one Markdown table cell ----------------------------------

/** A value as one table cell: NULL, digits, compact JSON, or text with `|`
 *  and `\` escaped and line breaks folded to a space. */
export function toCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** One table cell back as a value. Digits under 16 characters are a number,
 *  so `007` and long ids stay text. */
export function fromCell(s: string): CellValue {
  if (s === "NULL") return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) && s.length < 16) return Number(s);
  return s;
}

/** Split `| a | b \| c |` on the pipes that are not escaped, unescaping. */
export function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  const t = line.trim();
  for (let i = t[0] === "|" ? 1 : 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === "\\" && i + 1 < t.length) {
      cur += t[i + 1];
      i++;
    } else if (ch === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function resultToMd(r: NbResult): string {
  const shown = r.rows.slice(0, MAX_SAVED_ROWS);
  const head =
    "<!-- bt:result rows=" +
    r.rowCount +
    (r.rowCount > shown.length ? " shown=" + shown.length : "") +
    " ms=" +
    r.ms +
    " at=" +
    r.at +
    " -->";
  const lines = [head];
  if (r.columns.length) {
    lines.push("| " + r.columns.map(toCell).join(" | ") + " |");
    lines.push("| " + r.columns.map(() => "---").join(" | ") + " |");
    for (const row of shown) {
      lines.push("| " + r.columns.map((_, i) => toCell(row[i])).join(" | ") + " |");
    }
  }
  lines.push("<!-- /bt:result -->");
  return lines.join("\n");
}

/** A query cell's result is current: it is what the SQL above it returns. */
export const isCurrent = (c: QueryCell) => c.result != null && c.ranSql === c.sql;

/** Notebook → file text. `results: false` leaves every result block out. */
export function toMarkdown(nb: Notebook, opts?: { results?: boolean }): string {
  const keep = opts?.results !== false;
  const out = [
    "---",
    "bytetable: notebook/" + VERSION,
    "title: " + (nb.title || "Untitled notebook"),
  ];
  if (nb.connection) out.push("connection: " + nb.connection);
  if (nb.schema) out.push("schema: " + nb.schema);
  out.push("---", "");
  for (const c of nb.cells) {
    if (c.type === "note") {
      const t = (c.text || "").trim();
      if (t) out.push(t, "");
    } else {
      out.push("```sql", (c.sql || "").replace(/\s+$/, ""), "```", "");
      // A result is only written while it still belongs to the query above it.
      if (keep && isCurrent(c)) out.push(resultToMd(c.result!), "");
    }
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

const newQuery = (sql = ""): QueryCell => ({
  id: uid(),
  type: "query",
  sql,
  ranSql: null,
  result: null,
  view: "table",
});

/**
 * File text → notebook. Any Markdown file with ```sql blocks opens as one; a
 * file with none opens as notes. Code blocks in other languages stay inside
 * their note. Consecutive note text between two queries is ONE note cell.
 */
export function fromMarkdown(md: string): Notebook {
  const lines = String(md || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const nb: Notebook = {
    title: "",
    connection: "",
    schema: "",
    cells: [],
    version: VERSION,
    hadResults: false,
  };
  let i = 0;
  if (lines[0]?.trim() === "---") {
    for (i = 1; i < lines.length && lines[i]!.trim() !== "---"; i++) {
      const m = /^([a-z_]+):\s*(.*)$/i.exec(lines[i]!);
      if (!m) continue;
      const [, key, raw] = m;
      const value = raw!.trim();
      if (key === "title") nb.title = value;
      else if (key === "connection") nb.connection = value;
      else if (key === "schema") nb.schema = value;
      else if (key === "bytetable") {
        const v = /^notebook\/(\d+)$/.exec(value);
        if (v) nb.version = Number(v[1]);
      }
      // Unknown keys are ignored.
    }
    i++;
  }
  let note: string[] = [];
  const flush = () => {
    const t = note.join("\n").trim();
    if (t) nb.cells.push({ id: uid(), type: "note", text: t });
    note = [];
  };
  // Inside another language's fence, a ```sql line is text, not a query.
  let otherFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!otherFence && /^```sql$/i.test(trimmed)) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && lines[i]!.trim() !== "```"; i++) body.push(lines[i]!);
      nb.cells.push(newQuery(body.join("\n")));
      continue;
    }
    if (trimmed.startsWith("```")) otherFence = !otherFence;
    const rm = /^<!--\s*bt:result\b(.*?)-->$/.exec(trimmed);
    const last = nb.cells[nb.cells.length - 1];
    if (rm && !otherFence && last?.type === "query" && !note.join("").trim()) {
      const attr: Record<string, string> = {};
      rm[1]!.replace(/(\w+)=(\S+)/g, (_, k: string, v: string) => {
        attr[k] = v;
        return "";
      });
      const tbl: string[] = [];
      for (i++; i < lines.length && !/^<!--\s*\/bt:result\s*-->/.test(lines[i]!.trim()); i++) {
        if (lines[i]!.trim().startsWith("|")) tbl.push(lines[i]!);
      }
      const columns = tbl.length ? splitRow(tbl[0]!) : [];
      const rows = tbl.slice(2).map((l) => {
        const cells = splitRow(l);
        return columns.map((_, ci) => fromCell(cells[ci] ?? "NULL"));
      });
      last.result = {
        columns,
        rows,
        rowCount: Number(attr.rows) || rows.length,
        ms: Number(attr.ms) || 0,
        at: attr.at ?? "",
        saved: true,
      };
      last.ranSql = last.sql;
      nb.hadResults = true;
      note = [];
      continue;
    }
    note.push(line);
  }
  flush();
  if (!nb.title) {
    const h = nb.cells.find((c): c is NoteCell => c.type === "note" && /^#\s+/.test(c.text));
    nb.title = h ? h.text.split("\n")[0]!.replace(/^#\s+/, "") : UNTITLED;
  }
  return nb;
}

/** A new notebook: one empty note, one empty query. */
export function blank(connection: string, schema: string, title = UNTITLED): Notebook {
  return {
    title,
    connection,
    schema,
    cells: [{ id: uid(), type: "note", text: "" }, newQuery()],
    version: VERSION,
    hadResults: false,
  };
}

export { newQuery };
