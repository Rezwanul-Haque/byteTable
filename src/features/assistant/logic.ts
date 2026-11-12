// Pure logic for the assistant slice (M44) — the renderer half of the
// prototype's `window.BT_AI`: reading a model's answer (the SQL block, its
// `-- assume:` lines) and a local check of that SQL against the introspected
// schema (`validate`). The destination rule and the production lock are NOT
// here: they live once, in Rust (`assistant::domain::dest`), and the renderer
// asks for them through `assistant_describe`.

import { functionsFor, keywordsFor } from "../workspaces/sqlKeywords";
import { parseSelectShape } from "../workspaces/explainParse";
import type { Engine } from "../../shared/types";
import type { Settings } from "../settings/api";
import type { SchemaTable } from "./api";

/** Engines the assistant serves; every other workspace has no entry point. */
const SQL_ENGINES: ReadonlySet<Engine> = new Set<Engine>([
  "postgres",
  "mysql",
  "sqlite",
  "mssql",
  "clickhouse",
]);

export function isAssistantEngine(engine: Engine): boolean {
  return SQL_ENGINES.has(engine);
}

/** The workspace a surface is about: its SAVED connection (the production
 *  allow-list is keyed by that id), env and name. */
export interface AiConn {
  id: string;
  env: string;
  name: string;
}

// ---------------------------------------------------------------- slots
//
// A message with a styled part (a bold connection name, a link) is ONE string
// with a placeholder, never fragments around the element — word order differs
// per locale. `slot(name)` is passed as the placeholder's value; `splitSlots`
// finds it again so the component can put the element there.

const SLOT_OPEN = "\uE000";
const SLOT_CLOSE = "\uE001";

export const slot = (name: string): string => SLOT_OPEN + name + SLOT_CLOSE;

export type SlotSeg = { slot: string } | { text: string };

export function splitSlots(text: string): SlotSeg[] {
  const out: SlotSeg[] = [];
  const re = new RegExp(SLOT_OPEN + "([^" + SLOT_CLOSE + "]*)" + SLOT_CLOSE, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ slot: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The runtimes the drawer can switch between: three local ones and the two
 *  hosted vendors that take the user's key. */
export type RuntimeId = "ollama" | "lmstudio" | "custom" | "anthropic" | "openai";
export const RUNTIMES: readonly RuntimeId[] = [
  "ollama",
  "lmstudio",
  "custom",
  "anthropic",
  "openai",
];

type RuntimeKeys = Pick<Settings, "aiProvider" | "aiRuntime" | "aiVendor">;

/** Which runtime the settings point at. */
export function runtimeOf(s: RuntimeKeys): RuntimeId {
  if (s.aiProvider === "key") return s.aiVendor === "openai" ? "openai" : "anthropic";
  return s.aiRuntime;
}

/** The settings keys that select `id` — the same keys the Settings tab writes,
 *  so the drawer and Settings never disagree. The other runtimes' URLs, models
 *  and keys are left as they are. */
export function runtimeKeys(id: RuntimeId): Partial<RuntimeKeys> {
  if (id === "anthropic" || id === "openai") return { aiProvider: "key", aiVendor: id };
  return { aiProvider: "local", aiRuntime: id };
}

/** The settings key that holds `id`'s model. */
export function modelKeyOf(
  id: RuntimeId,
): "aiKeyModel" | "aiCustomModel" | "aiLmModel" | "aiLocalModel" {
  if (id === "anthropic" || id === "openai") return "aiKeyModel";
  if (id === "custom") return "aiCustomModel";
  return id === "lmstudio" ? "aiLmModel" : "aiLocalModel";
}

// ---------------------------------------------------------------- @ and /

/** The token the caret is in, when it opens a suggestion list: `@` at the
 *  start of a word (tables), or `/` at the start of the message (commands and
 *  models). `start` is where the token begins, `query` what follows the sign. */
export interface Trigger {
  sign: "@" | "/";
  query: string;
  start: number;
}

export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\s*\/([\w.:-]*)$/.exec(before);
  if (slash) return { sign: "/", query: slash[1]!, start: before.indexOf("/") };
  const at = /(^|[\s(,])@([\w$.]*)$/.exec(before);
  if (at) return { sign: "@", query: at[2]!, start: caret - at[2]!.length - 1 };
  return null;
}

/** Replace the trigger token with `insert`, returning the new text and caret. */
export function replaceTrigger(
  text: string,
  caret: number,
  trig: Trigger,
  insert: string,
): { text: string; caret: number } {
  const next = text.slice(0, trig.start) + insert + text.slice(caret);
  return { text: next, caret: trig.start + insert.length };
}

/** Where the word before `caret` starts — what ⌘⌫ / Ctrl+⌫ deletes back to
 *  in the message box: trailing spaces, then one run of word characters
 *  (`@orders` counts as one word) or of punctuation. */
export function prevWordStart(text: string, caret: number): number {
  let i = caret;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  const word = /[\w@$]/;
  if (i > 0 && word.test(text[i - 1]!)) {
    while (i > 0 && word.test(text[i - 1]!)) i--;
  } else {
    while (i > 0 && !word.test(text[i - 1]!) && !/\s/.test(text[i - 1]!)) i--;
  }
  return i;
}

/** The real tables a message @-mentions, in order, case-insensitively. */
export function mentionedTables(text: string, tables: readonly string[]): string[] {
  const byLower = new Map(tables.map((t) => [t.toLowerCase(), t]));
  const out: string[] = [];
  const re = /(^|[\s(,])@([\w$.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const hit = byLower.get(m[2]!.replace(/[.,]+$/, "").toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

// ---------------------------------------------------------------- starters

/** An empty-state starter, built from the connected schema (never canned). */
export type Starter =
  | { kind: "latest"; table: string }
  | { kind: "countBy"; table: string; column: string }
  | { kind: "count"; table: string };

const TIME_COL =
  /^(created|updated|modified|inserted|logged|occurred|event)_?(at|on|time|date|ts)$|^(timestamp|created|ts)$/i;
const GROUP_COL =
  /^(status|state|type|kind|category|role|country|level|action|method|source|channel|plan|tier)$/i;

/**
 * Up to three starters for this schema: the newest rows of a table that has a
 * timestamp column, a count of a table by a category-like column, and a row
 * count — each on a different table where the schema allows. Built from table
 * and column names only; no model is asked. Empty when nothing is loaded.
 */
export function startersFor(schema: readonly SchemaTable[]): Starter[] {
  const used = new Set<string>();
  const pick = (test: (t: SchemaTable) => boolean) => {
    const t = schema.find((x) => !used.has(x.name) && test(x)) ?? schema.find(test);
    if (t) used.add(t.name);
    return t;
  };
  const out: Starter[] = [];
  const latest = pick((t) => t.columns.some((c) => TIME_COL.test(c)));
  if (latest) out.push({ kind: "latest", table: latest.name });
  const grouped = pick((t) => t.columns.some((c) => GROUP_COL.test(c)));
  if (grouped)
    out.push({
      kind: "countBy",
      table: grouped.name,
      column: grouped.columns.find((c) => GROUP_COL.test(c))!,
    });
  const counted = pick(() => true);
  if (counted && !out.some((x) => x.kind === "count"))
    out.push({ kind: "count", table: counted.name });
  return out.slice(0, 3);
}

/** Popular services that speak OpenAI's API, for the OpenAI-compatible key
 *  provider's Base URL help. Base URLs only — the client appends `/models` and
 *  `/chat/completions`. Providers move these; the help says to check. */
export const OPENAI_COMPATIBLE: readonly { name: string; url: string }[] = [
  { name: "OpenAI", url: "https://api.openai.com/v1" },
  { name: "Groq", url: "https://api.groq.com/openai/v1" },
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { name: "Together AI", url: "https://api.together.xyz/v1" },
  { name: "Mistral", url: "https://api.mistral.ai/v1" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { name: "Fireworks", url: "https://api.fireworks.ai/inference/v1" },
  { name: "xAI", url: "https://api.x.ai/v1" },
  { name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { name: "Cerebras", url: "https://api.cerebras.ai/v1" },
  { name: "Perplexity", url: "https://api.perplexity.ai" },
];

export type AiKind = "ask" | "explain" | "plan" | "index" | "fix";

/** What a typed message asks for: an action on the editor's query, or SQL. */
export function aiIntent(text: string, hasSql: boolean): AiKind {
  const r = text.toLowerCase();
  if (!hasSql) return "ask";
  if (/\b(plan|slow|performance|faster|speed)\b/.test(r) && /\b(why|explain|what|how|is)\b/.test(r))
    return "plan";
  if (/\bindex(es)?\b/.test(r)) return "index";
  if (
    /^(explain|what does|what is this|walk me through|describe)\b/.test(r) &&
    /\b(this|it|query|sql|the editor)\b/.test(r)
  )
    return "explain";
  return "ask";
}

// ---------------------------------------------------------------- answers

/** Language tags a model or gateway may put on (or in front of) SQL. */
const SQL_TAG =
  /^(?:sql|postgres(?:ql)?|psql|mysql|mariadb|sqlite3?|t-?sql|mssql|clickhouse|ddl)$/i;
/** How a statement's first line can start. */
const STATEMENT =
  /^[ \t]*(?:select|with|insert|update|delete|create|alter|drop|explain|show|pragma|merge|truncate)\b/i;

/**
 * Pull the SQL out of a model's answer, and what it said around it.
 *
 * Models and the gateways in front of them don't agree on one shape, so three
 * are read, in order:
 *   1. a fenced block — ```` ```sql ```` + newline, a bare ```` ``` ````, or
 *      the tag and the statement on one line (```` ```sql SELECT …``` ````);
 *   2. a bare statement anywhere in the answer, optionally after a `sql` tag
 *      line (a fence some gateway stripped), running to its `;` or the first
 *      blank line, with any `-- assume:` lines gathered from wherever they
 *      sit;
 *   3. nothing — the answer is prose.
 */
export function extractSql(text: string): { code: string | null; rest: string } {
  const src = String(text ?? "");
  const open = src.indexOf("```");
  if (open >= 0) {
    let body = src.slice(open + 3);
    const close = body.indexOf("```");
    const after = close >= 0 ? body.slice(close + 3) : "";
    if (close >= 0) body = body.slice(0, close);
    // The info string: a lone tag on the first line, or a tag glued to the
    // statement on the same line.
    const nl = body.indexOf("\n");
    const first = (nl >= 0 ? body.slice(0, nl) : body).trim();
    if (SQL_TAG.test(first) || first === "") body = nl >= 0 ? body.slice(nl + 1) : "";
    else body = body.replace(/^[ \t]*(?:sql|postgres(?:ql)?|mysql|sqlite)[ \t]+(?=\S)/i, "");
    const code = body.replace(/\s+$/, "").replace(/^\n+/, "");
    // `-- assume:` lines written outside the fence still belong to the code.
    const around = (src.slice(0, open) + "\n\n" + after).split("\n");
    const assumeOut = around.filter((l) => /^\s*--\s*assume[sd]?\s*:/i.test(l));
    const rest = around
      .filter((l) => !/^\s*--\s*assume[sd]?\s*:/i.test(l))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!code) return { code: null, rest };
    return { code: [...assumeOut, code].join("\n"), rest };
  }

  // No fence: look for a bare statement anywhere in the answer. `-- assume:`
  // lines are gathered wherever they sit (a model may put them before the
  // statement, separated by a blank line); they ride along with the code so
  // `parseSqlAnswer` lifts them into the Assumed list.
  const all = src.split("\n");
  const assume = all.filter((l) => /^\s*--\s*assume[sd]?\s*:/i.test(l));
  const lines = all.filter((l) => !/^\s*--\s*assume[sd]?\s*:/i.test(l));
  for (let k = 0; k < lines.length; k++) {
    // A `sql` tag line (a fence some gateway stripped) or a `sql ` prefix.
    let i = k;
    let first = lines[i]!;
    if (SQL_TAG.test(first.trim())) {
      i++;
      while (i < lines.length && !lines[i]!.trim()) i++;
      first = lines[i] ?? "";
    } else if (/^[ \t]*sql[ \t]+(?=\S)/i.test(first)) {
      first = first.replace(/^[ \t]*sql[ \t]+/i, "");
    }
    if (!STATEMENT.test(first)) continue;
    const out: string[] = [first];
    let j = i + 1;
    if (!/;\s*$/.test(first)) {
      for (; j < lines.length; j++) {
        const line = lines[j]!;
        if (!line.trim()) break;
        out.push(line);
        if (/;\s*$/.test(line)) {
          j++;
          break;
        }
      }
    }
    const code = out.join("\n").trim();
    // Prose can start with "With …" or "Select …" too: a bare statement only
    // counts when it reads as SQL — a CTE head, an uppercase keyword, or a `;`.
    const sqlish =
      /^\s*with\s+(?:recursive\s+)?[\w"`]+\s+as\s*\(/i.test(code) ||
      /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|EXPLAIN|SHOW|PRAGMA|MERGE|TRUNCATE)\b/.test(
        code,
      ) ||
      /;\s*$/.test(code);
    if (!sqlish) continue;
    const rest = [...lines.slice(0, k), ...lines.slice(j)].join("\n").replace(/\n{3,}/g, "\n\n");
    return { code: [...assume, code].join("\n"), rest: rest.trim() };
  }
  return { code: null, rest: src.trim() };
}

export interface SqlAnswer {
  sql: string | null;
  /** The `-- assume:` lines, lifted out of the SQL. */
  assumptions: string[];
  /** Whatever the model said outside the block. */
  note: string;
}

/** Split an ask answer into SQL, assumption chips and prose. */
export function parseSqlAnswer(text: string): SqlAnswer {
  const { code: block, rest } = extractSql(text);
  const assumptions: string[] = [];
  let sql: string | null = null;
  if (block !== null) {
    const kept: string[] = [];
    for (const line of block.split("\n")) {
      const m = /^\s*--\s*assume[sd]?\s*:\s*(.*)$/i.exec(line);
      if (m) {
        if (m[1]!.trim()) assumptions.push(m[1]!.trim());
      } else kept.push(line);
    }
    sql = kept.join("\n").trim() || null;
  }
  return { sql, assumptions, note: rest };
}

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();

/** Did a follow-up actually change the draft? */
export function sameSql(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

export type IndexAnswer =
  | { outcome: "ddl"; ddl: string; why: string }
  | { outcome: "exists"; index: string; why: string }
  | { outcome: "none"; why: string };

/** Read an index answer into one of the three outcomes (C11). */
export function parseIndexAnswer(text: string, schema: SchemaTable[]): IndexAnswer {
  const { code: block, rest: why } = extractSql(text);
  if (block && /\bcreate\s+(unique\s+)?index\b/i.test(block)) {
    return { outcome: "ddl", ddl: block.trim(), why };
  }
  const names = schema.flatMap((t) => t.indexes);
  const named = names.find((n) => new RegExp("\\b" + escapeRe(n) + "\\b", "i").test(text));
  if (named && /\b(already|existing|covers|covered)\b/i.test(text)) {
    return { outcome: "exists", index: named, why };
  }
  return { outcome: "none", why };
}

export interface DiffLine {
  n: number;
  old: string;
  now: string;
}

/** Line diff for the fix card: changed lines when the line count holds, else
 *  the whole statement as one change (the prototype's rule). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length === b.length) {
    const out: DiffLine[] = [];
    a.forEach((l, i) => {
      if (l !== b[i]) out.push({ n: i + 1, old: l, now: b[i]! });
    });
    return out;
  }
  return [{ n: 1, old: before, now: after }];
}

export type FixAnswer =
  | { ok: true; sql: string; note: string; lines: DiffLine[] }
  | { ok: false; note: string };

/** Read a fix answer. No block, or a block identical to the failed statement,
 *  is "no small, safe fix" — and nothing is proposed. */
export function parseFixAnswer(text: string, failed: string): FixAnswer {
  const { code: block, rest: note } = extractSql(text);
  if (!block || sameSql(block, failed)) {
    return {
      ok: false,
      note:
        note ||
        "I can’t see a small, safe fix for this error. It needs a change only you can decide on.",
    };
  }
  const sql = block.trim();
  return { ok: true, sql, note, lines: lineDiff(failed.trim(), sql) };
}

/** Bullet lines of an explain answer, or null when it is a paragraph. */
export function bullets(text: string): string[] | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const items = lines.filter((l) => /^([-*•]|\d+[.)])\s+/.test(l));
  if (items.length < 2 || items.length < lines.length / 2) return null;
  return items.map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, ""));
}

export type RichSeg = { k: "text" | "code" | "bold"; t: string };

/** `code` and **bold** in a model answer. */
export function richSegments(str: string): RichSeg[] {
  return String(str)
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
    .filter((p) => p !== "")
    .map((p) =>
      p[0] === "`"
        ? { k: "code", t: p.slice(1, -1) }
        : p.startsWith("**") && p.endsWith("**") && p.length > 4
          ? { k: "bold", t: p.slice(2, -2) }
          : { k: "text", t: p },
    );
}

// ---------------------------------------------------------------- validation

export interface Validation {
  /** The statement writes data or changes structure. */
  write?: boolean;
  parseError?: string;
  /** Tables and columns the schema does not have. */
  unknown: string[];
  tables: number;
  cols: number;
}

const WRITE_RE =
  /^\s*(insert|update|delete|merge|upsert|replace|create|drop|alter|truncate|rename|grant|revoke)\b/i;
const CTE_WRITE_RE = /\)\s*(insert|update|delete|merge)\b/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Tok {
  t: "id" | "str" | "num" | "punct";
  v: string;
  /** Lowercased, unquoted. */
  lc: string;
  quoted: boolean;
}

/** A small lexer: identifiers (bare or quoted), strings, numbers, punctuation.
 *  Comments are dropped. Good enough to find names; not a SQL parser. */
function lex(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out.push({ t: "str", v: sql.slice(i, j + 1), lc: "", quoted: false });
      i = j + 1;
      continue;
    }
    const close = c === '"' ? '"' : c === "`" ? "`" : c === "[" ? "]" : null;
    if (close) {
      const j = sql.indexOf(close, i + 1);
      const end = j < 0 ? sql.length : j;
      const name = sql.slice(i + 1, end);
      out.push({ t: "id", v: name, lc: name.toLowerCase(), quoted: true });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < sql.length && /[0-9.eE]/.test(sql[j]!)) j++;
      out.push({ t: "num", v: sql.slice(i, j), lc: "", quoted: false });
      i = j;
      continue;
    }
    if (/[A-Za-z_À-￿]/.test(c)) {
      let j = i;
      while (j < sql.length && /[\w$À-￿]/.test(sql[j]!)) j++;
      const v = sql.slice(i, j);
      out.push({ t: "id", v, lc: v.toLowerCase(), quoted: false });
      i = j;
      continue;
    }
    if (c === ":" && sql[i + 1] === ":") {
      out.push({ t: "punct", v: "::", lc: "::", quoted: false });
      i += 2;
      continue;
    }
    out.push({ t: "punct", v: c, lc: c, quoted: false });
    i++;
  }
  return out;
}

/** Words that are never column names in generated SQL. */
const EXTRA_WORDS = [
  "interval",
  "current_date",
  "current_time",
  "current_timestamp",
  "localtime",
  "localtimestamp",
  "true",
  "false",
  "null",
  "unknown",
  "asc",
  "desc",
  "nulls",
  "first",
  "last",
  "over",
  "partition",
  "rows",
  "range",
  "unbounded",
  "preceding",
  "following",
  "current",
  "row",
  "filter",
  "within",
  "day",
  "days",
  "month",
  "months",
  "year",
  "years",
  "week",
  "weeks",
  "hour",
  "hours",
  "minute",
  "minutes",
  "second",
  "seconds",
  "quarter",
  "epoch",
  "dow",
  "doy",
  "isodow",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "text",
  "integer",
  "int",
  "bigint",
  "smallint",
  "numeric",
  "decimal",
  "real",
  "float",
  "double",
  "precision",
  "varchar",
  "char",
  "boolean",
  "bool",
  "json",
  "jsonb",
  "uuid",
  "bytea",
  "signed",
  "unsigned",
  "zone",
  "at",
  "recursive",
  "lateral",
  "ties",
  "only",
  "fetch",
  "next",
  "offset",
  "top",
  "percent",
  "ilike",
  "similar",
  "escape",
  "collate",
  "using",
  "natural",
  "cross",
  "outer",
  "full",
  "inner",
  "left",
  "right",
  "exists",
  "any",
  "some",
  "all",
  "distinct",
  "case",
  "when",
  "then",
  "else",
  "end",
  "cast",
  "between",
  "is",
  "not",
  "and",
  "or",
  "in",
  "like",
  "as",
  "on",
  "with",
  "union",
  "intersect",
  "except",
  "values",
  "default",
  "limit",
];

let wordCache: { engine: Engine; words: Set<string> } | null = null;
function reserved(engine: Engine): Set<string> {
  if (wordCache?.engine === engine) return wordCache.words;
  const words = new Set<string>(EXTRA_WORDS);
  for (const k of keywordsFor(engine)) for (const w of k.split(/\s+/)) words.add(w.toLowerCase());
  for (const f of functionsFor(engine)) words.add(f.toLowerCase());
  wordCache = { engine, words };
  return words;
}

/** Functions whose argument list may contain FROM (`EXTRACT(YEAR FROM x)`). */
const FROM_IN_ARGS = new Set(["extract", "substring", "trim", "overlay", "position"]);

/**
 * Check generated SQL against the introspected schema (Task A10): every table
 * it reads and every column it names must exist. Writes are classified, not
 * checked — they go through the normal run confirm.
 *
 * Conservative in one direction only: a name it can't place (a CTE's column, a
 * derived table's output, a correlated alias) is let through rather than
 * reported, so a warning always names something that is really missing.
 */
export function validate(sql: string, schema: SchemaTable[], engine: Engine): Validation {
  const s = String(sql ?? "").trim();
  if (!s) return { parseError: "the statement is empty", unknown: [], tables: 0, cols: 0 };
  if (WRITE_RE.test(s) || (/^\s*with\b/i.test(s) && CTE_WRITE_RE.test(s))) {
    return { write: true, unknown: [], tables: 0, cols: 0 };
  }
  const shape = parseSelectShape(s);
  if (!shape.isSelect) {
    return { parseError: "it isn’t a SELECT statement", unknown: [], tables: 0, cols: 0 };
  }
  if ((s.match(/\(/g) ?? []).length !== (s.match(/\)/g) ?? []).length) {
    return { parseError: "unbalanced parentheses", unknown: [], tables: 0, cols: 0 };
  }

  const byName = new Map(schema.map((t) => [t.name.toLowerCase(), t]));
  const words = reserved(engine);
  const toks = lex(s);

  // CTE names: `WITH a AS (`, `, b AS (`.
  const ctes = new Set<string>();
  for (let i = 0; i + 2 < toks.length; i++) {
    const x = toks[i]!;
    if (x.t === "id" && toks[i + 1]?.lc === "as" && toks[i + 2]?.v === "(") {
      const prev = toks[i - 1];
      if (prev && (prev.lc === "with" || prev.lc === "recursive" || prev.v === ",")) ctes.add(x.lc);
    }
  }

  // Relations after FROM / JOIN, with their aliases. Positions they occupy are
  // not column references.
  const consumed = new Set<number>();
  const aliases = new Map<string, string | null>(); // alias → base table (null = derived/CTE)
  const relations = new Set<string>();
  const unknown: string[] = [];
  const parenFn: string[] = [];
  let opaque = false; // a derived table or CTE is in play: bare names may be its output
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i]!;
    if (x.v === "(") {
      const prev = toks[i - 1];
      parenFn.push(prev?.t === "id" ? prev.lc : "");
      continue;
    }
    if (x.v === ")") {
      parenFn.pop();
      continue;
    }
    if (x.t !== "id" || x.quoted || (x.lc !== "from" && x.lc !== "join")) continue;
    if (x.lc === "from" && FROM_IN_ARGS.has(parenFn[parenFn.length - 1] ?? "")) continue;
    let j = i + 1;
    if (toks[j]?.v === "(") {
      opaque = true;
      // Skip to the matching paren; the alias after it names a derived table.
      let d = 0;
      for (; j < toks.length; j++) {
        if (toks[j]!.v === "(") d++;
        else if (toks[j]!.v === ")" && --d === 0) break;
      }
      let k = j + 1;
      if (toks[k]?.lc === "as") k++;
      if (toks[k]?.t === "id" && !words.has(toks[k]!.lc)) {
        aliases.set(toks[k]!.lc, null);
        consumed.add(k);
      }
      continue;
    }
    // `FROM a x, b y` — a comma list of relations; JOIN takes one.
    for (;;) {
      const parts: number[] = [];
      while (toks[j]?.t === "id") {
        parts.push(j);
        if (toks[j + 1]?.v === ".") j += 2;
        else break;
      }
      if (!parts.length) break;
      parts.forEach((p) => consumed.add(p));
      const table = toks[parts[parts.length - 1]!]!.lc;
      let k = parts[parts.length - 1]! + 1;
      if (toks[k]?.lc === "as") k++;
      const al = toks[k];
      const hasAlias = al?.t === "id" && (al.quoted || !words.has(al.lc));
      if (hasAlias) consumed.add(k);
      const alias = hasAlias ? al!.lc : null;
      if (ctes.has(table)) {
        opaque = true;
        aliases.set(table, null);
        if (alias) aliases.set(alias, null);
      } else if (!byName.has(table)) {
        if (!unknown.includes(table)) unknown.push(table);
        aliases.set(table, null);
        if (alias) aliases.set(alias, null);
      } else {
        relations.add(table);
        aliases.set(table, table);
        if (alias) aliases.set(alias, table);
      }
      const after = hasAlias ? k + 1 : k;
      if (x.lc !== "from" || toks[after]?.v !== ",") break;
      j = after + 1;
    }
  }
  if (ctes.size) opaque = true;

  // Output aliases (`AS revenue`, or a bare trailing name) are usable in
  // ORDER BY / HAVING, never columns to look up.
  const outAliases = new Set<string>();
  for (let i = 1; i < toks.length; i++) {
    if (toks[i - 1]!.lc === "as" && toks[i]!.t === "id") outAliases.add(toks[i]!.lc);
  }
  for (const it of shape.items) if (it.alias) outAliases.add(it.alias.toLowerCase());

  const cols = new Set<string>();
  const hasCol = (table: string, col: string) =>
    !!byName.get(table)?.columns.some((c) => c.toLowerCase() === col);
  const referenced = [...relations];

  for (let i = 0; i < toks.length; i++) {
    const x = toks[i]!;
    if (x.t !== "id" || consumed.has(i)) continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (prev?.lc === "as" || prev?.v === "::" || (prev?.v === "." && !x.quoted)) continue;
    if (next?.v === "(") continue; // a function call
    if (next?.v === "." && toks[i + 2]?.t === "id") {
      // qualified: q.col
      const q = x.lc;
      const colTok = toks[i + 2]!;
      i += 2;
      if (!aliases.has(q)) continue; // a schema qualifier or something we can't place
      const base = aliases.get(q);
      if (!base) continue;
      cols.add(colTok.lc);
      if (!hasCol(base, colTok.lc)) {
        const name = x.v + "." + colTok.v;
        if (!unknown.includes(name)) unknown.push(name);
      }
      continue;
    }
    if (next?.v === "." && toks[i + 2]?.v === "*") continue;
    if (!x.quoted && words.has(x.lc)) continue;
    if (aliases.has(x.lc) || outAliases.has(x.lc) || ctes.has(x.lc)) continue;
    cols.add(x.lc);
    if (referenced.some((t) => hasCol(t, x.lc))) continue;
    if (opaque || referenced.length === 0) continue;
    if (!unknown.includes(x.v)) unknown.push(x.v);
  }

  return { unknown, tables: relations.size, cols: cols.size };
}
