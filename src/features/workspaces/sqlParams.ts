// Query parameters for the SQL editor: find `:name` / `${name}` / `?`
// placeholders in a buffer, and resolve them into runnable SQL.
//
// RESOLUTION MODEL — substitution, not driver binding. A resolved statement is
// a plain string, so everything downstream of the editor keeps working
// unchanged on one value: `splitStatements`, the EXPLAIN panel, query history,
// and — importantly — the backend's read-only guard, which classifies the SQL
// it is actually handed. Driver-level binding would also rule out the
// identifier and fragment parameters (`FROM ${table}`) that are half the point
// of the feature, since no engine can bind an identifier.
//
// The trust model is the one this app already documents for the SQL editor and
// for the filter builder's raw mode (`features/browse/sql/filter.ts`): the user
// has full SQL access here, so a value they typed themselves is not an
// untrusted input. Even so, nothing is interpolated naively — every kind but
// `raw` renders through a quoting/validating path, and `raw` has to be chosen
// per parameter. A plain text parameter can never inject by accident.
//
// Placeholder syntax:
//   :name      canonical named form (JDBC / DataGrip / DBeaver convention)
//   ${name}    braced form — needed when the name touches word characters
//              (`${col}_id`) and the only form usable inside a word
//   ?          positional, named "1", "2", … in occurrence order
//
// `$name` is deliberately NOT a placeholder: it collides with Postgres's `$1`
// positional parameters and with dollar-quoting (`$body$`).

import type { Engine } from "../../shared/types";
import { skipNonCodeOrBracket } from "./sqlLex";

/**
 * How a parameter's value is rendered into SQL.
 *
 * - `text` — a quoted string literal, escaped.
 * - `number` — a bare numeric literal.
 * - `boolean` — the engine's truth literal.
 * - `date` — a quoted literal, like `text`; the kind exists so the UI can
 *   offer a date picker and so intent survives in the saved query.
 * - `list` — comma-separated input rendered as a comma-separated literal list,
 *   for `WHERE id IN (:ids)`. Numeric items stay bare, everything else is
 *   quoted, so `3, 4` and `paid, due` both do the right thing.
 * - `null` — always `NULL`; takes no value.
 * - `raw` — the user's text verbatim. The escape hatch for identifiers and SQL
 *   fragments (`FROM ${table}`, `ORDER BY ${sort}`). Opt-in per parameter.
 */
export type ParamKind = "text" | "number" | "boolean" | "date" | "list" | "null" | "raw";

/** Kinds in the order the UI offers them. */
export const PARAM_KINDS: ParamKind[] = [
  "text",
  "number",
  "boolean",
  "date",
  "list",
  "null",
  "raw",
];

/** The kind a parameter takes when nothing has declared one. */
export const DEFAULT_PARAM_KIND: ParamKind = "text";

/**
 * A parameter's declared metadata, carried by a saved query so the prompt can
 * show a real label, the right input, and a starting value.
 *
 * Only `name` is required: a parameter found in the buffer with no definition
 * behaves as `{ kind: "text" }`. Definitions outlive the text that produced
 * them (editing the SQL does not discard a declaration for a name you are
 * about to re-add), so the UI shows definitions for DETECTED names only.
 */
export interface ParamDef {
  /** The placeholder name, without the `:` / `${}` (or "1", "2", … for `?`). */
  name: string;
  /** Prompt label; falls back to the name. */
  label?: string;
  kind?: ParamKind;
  /** Starting value, used when no value has been entered yet. */
  default?: string;
  /** When non-empty, the prompt offers these instead of a free-text input. */
  choices?: string[];
}

/** One placeholder occurrence in the buffer. */
export interface ParamRef {
  name: string;
  /** Inclusive start offset of the placeholder token. */
  from: number;
  /** Exclusive end offset of the placeholder token. */
  to: number;
  /** True for a `?` placeholder (its name is its 1-based position). */
  positional: boolean;
}

/** A distinct parameter in the buffer, in first-appearance order. */
export interface DetectedParam {
  name: string;
  positional: boolean;
  /** How many placeholders in the buffer refer to this name. */
  count: number;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

/**
 * Whether a bare `?` is a parameter placeholder for this engine.
 *
 * Not for Postgres: there `?`, `?|` and `?&` are jsonb existence OPERATORS
 * (`data ? 'key'`), so treating `?` as a placeholder would turn a working
 * query into a prompt for a parameter the user never wrote. Every other SQL
 * engine here has no `?` operator, so the positional form is unambiguous.
 * Named placeholders work on every engine, Postgres included.
 */
function positionalEnabled(engine: Engine): boolean {
  return engine !== "postgres";
}

/**
 * Every placeholder occurrence in `sql`, in order.
 *
 * Lexically aware: a `:name` inside a string literal, a quoted identifier, a
 * comment or a Postgres dollar-quoted body is content, not a placeholder, and
 * a `::` cast is never read as one (`id::text` holds no parameter). SQL Server
 * bracket identifiers are skipped too, which also covers Postgres array
 * subscripts — neither can contain a placeholder.
 */
export function scanParams(sql: string, engine: Engine): ParamRef[] {
  const refs: ParamRef[] = [];
  const n = sql.length;
  const allowPositional = positionalEnabled(engine);
  let i = 0;
  let positionalCount = 0;

  while (i < n) {
    const skipped = skipNonCodeOrBracket(sql, i);
    if (skipped !== null) {
      // Guard against a zero-width skip looping forever.
      i = skipped > i ? skipped : i + 1;
      continue;
    }
    const c = sql[i];

    // `::` — a cast, not one-or-two placeholders. Step over both colons so the
    // second one cannot start a name (`id::text` must not yield `:text`).
    if (c === ":" && sql[i + 1] === ":") {
      i += 2;
      continue;
    }

    // `:name`
    if (c === ":" && sql[i + 1] !== undefined && NAME_START.test(sql[i + 1]!)) {
      let j = i + 1;
      while (j < n && NAME_CHAR.test(sql[j]!)) j++;
      refs.push({ name: sql.slice(i + 1, j), from: i, to: j, positional: false });
      i = j;
      continue;
    }

    // `${name}`
    if (c === "$" && sql[i + 1] === "{") {
      let j = i + 2;
      while (j < n && NAME_CHAR.test(sql[j]!)) j++;
      if (sql[j] === "}" && j > i + 2) {
        refs.push({ name: sql.slice(i + 2, j), from: i, to: j + 1, positional: false });
        i = j + 1;
        continue;
      }
    }

    // `?` — skip Postgres's jsonb operators `?|` / `?&`, and a `??` pair, which
    // are operators on no engine but are certainly not two placeholders.
    if (c === "?" && allowPositional) {
      const next = sql[i + 1];
      if (next !== "|" && next !== "&" && next !== "?") {
        positionalCount++;
        refs.push({ name: String(positionalCount), from: i, to: i + 1, positional: true });
        i++;
        continue;
      }
    }

    i++;
  }

  return refs;
}

/**
 * The distinct parameters in `sql`, in first-appearance order.
 *
 * Named placeholders collapse: `:from` written twice is ONE parameter asked
 * for once and substituted in both places. Positional `?` placeholders never
 * collapse — each is its own parameter, which is what positional means.
 */
export function detectParams(sql: string, engine: Engine): DetectedParam[] {
  const out: DetectedParam[] = [];
  const index = new Map<string, number>();
  for (const ref of scanParams(sql, engine)) {
    const key = (ref.positional ? "?" : ":") + ref.name;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push({ name: ref.name, positional: ref.positional, count: 1 });
    } else {
      out[at]!.count++;
    }
  }
  return out;
}

/** The definition for `name`, or undefined. */
export function findDef(defs: ParamDef[], name: string): ParamDef | undefined {
  return defs.find((d) => d.name === name);
}

/** The kind declared for `name`, defaulting to `text`. */
export function kindOf(defs: ParamDef[], name: string): ParamKind {
  return findDef(defs, name)?.kind ?? DEFAULT_PARAM_KIND;
}

/**
 * The value each detected parameter will run with: the entered value, else the
 * declared default, else "". Keyed by parameter name.
 *
 * This is the single place the value/default precedence is decided, so the
 * param bar, the prompt dialog and the run path cannot disagree about what is
 * about to be substituted.
 */
export function effectiveValues(
  detected: DetectedParam[],
  defs: ParamDef[],
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of detected) {
    const entered = values[p.name];
    out[p.name] =
      entered !== undefined && entered !== "" ? entered : (findDef(defs, p.name)?.default ?? "");
  }
  return out;
}

/**
 * Whether a parameter of this kind needs the user to supply something. Only
 * `null` does not — it renders `NULL` whatever the input is.
 */
export function kindNeedsValue(kind: ParamKind): boolean {
  return kind !== "null";
}

/**
 * Detected parameters with no value and no default — the ones a run has to ask
 * about. Names only, in buffer order.
 */
export function missingParams(
  detected: DetectedParam[],
  defs: ParamDef[],
  values: Record<string, string>,
): string[] {
  const effective = effectiveValues(detected, defs, values);
  return detected
    .filter((p) => kindNeedsValue(kindOf(defs, p.name)) && (effective[p.name] ?? "").trim() === "")
    .map((p) => p.name);
}

/**
 * What is wrong with a parameter value. A CODE rather than a message: this
 * module is pure and locale-free, so the UI maps these to its own strings.
 */
export type ParamValueError = "notNumber" | "notBoolean";

/**
 * The problem with `raw` as a value of `kind`, or null when it is usable.
 *
 * Drives inline validation in the parameter inputs only. `applyParams` stays
 * total and never consults this: a run with an invalid value still produces
 * SQL (with the value quoted as text), so the engine reports the real type
 * error instead of the run silently doing nothing.
 */
export function paramError(kind: ParamKind, raw: string): ParamValueError | null {
  switch (kind) {
    case "number":
      return numberLiteral(raw) === null ? "notNumber" : null;
    case "boolean":
      return parseBool(raw) === null ? "notBoolean" : null;
    default:
      return null;
  }
}

/** A finite numeric literal for `raw`, or null when it is not a number. */
function numberLiteral(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  // Reject the things Number() is too generous about (""/whitespace is already
  // out; "0x10", "1e5" and "-2.5" are all legitimate SQL numeric input).
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;
  return text;
}

/** `true` / `false` for the recognised spellings, else null. */
function parseBool(raw: string): boolean | null {
  switch (raw.trim().toLowerCase()) {
    case "true":
    case "t":
    case "yes":
    case "y":
    case "1":
      return true;
    case "false":
    case "f":
    case "no":
    case "n":
    case "0":
      return false;
    default:
      return null;
  }
}

/**
 * Whether this engine treats a backslash inside a string literal as an escape
 * character.
 *
 * MySQL does by default (`NO_BACKSLASH_ESCAPES` off) and so does ClickHouse,
 * so a literal backslash in a value has to be doubled there. Postgres (with
 * `standard_conforming_strings` on, the default since 9.1), SQLite, SQL Server
 * and CQL all treat it as an ordinary character — doubling it for them would
 * corrupt the value by inserting a second backslash.
 */
function usesBackslashEscapes(engine: Engine): boolean {
  return engine === "mysql" || engine === "clickhouse";
}

/**
 * `raw` as a quoted SQL string literal for `engine`: single quotes doubled
 * everywhere, backslashes doubled only where they are escapes.
 */
export function quoteLiteral(raw: string, engine: Engine): string {
  const escaped = usesBackslashEscapes(engine)
    ? raw.replace(/\\/g, "\\\\").replace(/'/g, "''")
    : raw.replace(/'/g, "''");
  return `'${escaped}'`;
}

/**
 * The engine's literal for a boolean.
 *
 * SQL Server has no boolean type and SQLite stores 0/1 (its `TRUE`/`FALSE`
 * keywords only arrived in 3.23), so both get the integer form, which is
 * comparable against a bit/integer column. Postgres, MySQL, ClickHouse and CQL
 * all accept the keywords.
 */
function booleanLiteral(value: boolean, engine: Engine): string {
  if (engine === "sqlite" || engine === "mssql") return value ? "1" : "0";
  return value ? "TRUE" : "FALSE";
}

/**
 * One list item: bare when it is numeric, a quoted literal otherwise — so
 * `1, 2, 3` compares against an integer column and `paid, due` against a text
 * one, without the user declaring which.
 */
function listItemLiteral(item: string, engine: Engine): string {
  return numberLiteral(item) ?? quoteLiteral(item.trim(), engine);
}

/**
 * The SQL text one parameter value becomes. Total: an invalid `number` or
 * `boolean` falls back to a quoted literal rather than emitting the user's
 * text unquoted, so a typo surfaces as a type error from the engine instead of
 * as arbitrary SQL.
 */
export function renderParam(raw: string, kind: ParamKind, engine: Engine): string {
  switch (kind) {
    case "null":
      return "NULL";
    case "raw":
      return raw;
    case "number":
      return numberLiteral(raw) ?? quoteLiteral(raw.trim(), engine);
    case "boolean": {
      const parsed = parseBool(raw);
      return parsed === null ? quoteLiteral(raw.trim(), engine) : booleanLiteral(parsed, engine);
    }
    case "list": {
      const items = raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      // An empty list still has to be a valid expression: `IN (NULL)` matches
      // nothing, which is what an empty list means, where `IN ()` is a syntax
      // error on every engine.
      if (items.length === 0) return "NULL";
      return items.map((item) => listItemLiteral(item, engine)).join(", ");
    }
    case "text":
    case "date":
    default:
      return quoteLiteral(raw, engine);
  }
}

/**
 * `sql` with every placeholder replaced by its resolved literal.
 *
 * Replacement runs right-to-left over the scanned occurrences so earlier
 * offsets stay valid as the string changes, and a substituted value is never
 * re-scanned — a value that itself contains `:name` is data, not a
 * placeholder.
 *
 * A placeholder with no value and no default is left EXACTLY as written. That
 * keeps the function honest when it is called with incomplete values (the run
 * path asks first, but the preview does not): the user sees the placeholder
 * still sitting there rather than a silent empty string or a stray `''`.
 */
export function applyParams(
  sql: string,
  values: Record<string, string>,
  defs: ParamDef[],
  engine: Engine,
): string {
  const refs = scanParams(sql, engine);
  if (refs.length === 0) return sql;

  let out = sql;
  for (let k = refs.length - 1; k >= 0; k--) {
    const ref = refs[k]!;
    const kind = kindOf(defs, ref.name);
    const entered = values[ref.name];
    const raw =
      entered !== undefined && entered !== "" ? entered : (findDef(defs, ref.name)?.default ?? "");
    if (raw === "" && kindNeedsValue(kind)) continue;
    out = out.slice(0, ref.from) + renderParam(raw, kind, engine) + out.slice(ref.to);
  }
  return out;
}

/**
 * The placeholder as it appears in SQL, for display in labels and messages
 * (`:status`, `?`). Positional parameters have no spelling of their own, so
 * they render as the bare `?` they were written as.
 */
export function paramToken(param: DetectedParam): string {
  return param.positional ? "?" : ":" + param.name;
}

/** A stable React key / map key that cannot confuse `:1` with a positional `?`. */
export function paramKey(param: DetectedParam): string {
  return (param.positional ? "?" : ":") + param.name;
}

/**
 * A declaration with its empty fields dropped, so a label the user typed and
 * then cleared stores as nothing rather than as `""`, and an explicit `text`
 * kind (the default) is not written out at all.
 */
export function pruneDef(def: ParamDef): ParamDef {
  const out: ParamDef = { name: def.name };
  if (def.label?.trim()) out.label = def.label;
  if (def.kind && def.kind !== DEFAULT_PARAM_KIND) out.kind = def.kind;
  if (def.default !== undefined && def.default !== "") out.default = def.default;
  if (def.choices && def.choices.length > 0) out.choices = def.choices;
  return out;
}

/** Whether a declaration says anything beyond "a text parameter called x". */
export function defIsMeaningful(def: ParamDef): boolean {
  const pruned = pruneDef(def);
  return (
    pruned.label !== undefined ||
    pruned.kind !== undefined ||
    pruned.default !== undefined ||
    pruned.choices !== undefined
  );
}

/**
 * `defs` with `name`'s declaration patched, appending one when the name has no
 * declaration yet. Declarations for OTHER names are left exactly as they are —
 * including names not currently in the buffer, so commenting a clause out for
 * a minute does not discard its types and defaults.
 */
export function mergeDefs(defs: ParamDef[], name: string, change: Partial<ParamDef>): ParamDef[] {
  const next = defs.some((d) => d.name === name)
    ? defs.map((d) => (d.name === name ? { ...d, ...change } : d))
    : [...defs, { name, ...change }];
  return next.map(pruneDef);
}

/**
 * The declarations worth saving with a query: the meaningful ones, for
 * parameters the query actually has.
 *
 * Filtered on save rather than on edit, so the store never accumulates rows
 * for placeholders that were edited away, and an all-defaults query saves with
 * no `params` at all — byte-identical to what a build without this feature
 * would have written.
 */
export function defsToStore(params: DetectedParam[], defs: ParamDef[]): ParamDef[] {
  return params
    .map((p) => findDef(defs, p.name))
    .filter((d): d is ParamDef => d !== undefined)
    .map(pruneDef)
    .filter(defIsMeaningful);
}

/**
 * The values worth saving with a query: every parameter's EFFECTIVE value,
 * minus the blanks.
 *
 * Effective, not entered — accepting a default and hitting Run has to make
 * that value the remembered one, which is what "remembers what it last ran
 * with" means from the user's side.
 */
export function valuesToStore(
  params: DetectedParam[],
  defs: ParamDef[],
  values: Record<string, string>,
): Record<string, string> {
  const effective = effectiveValues(params, defs, values);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(effective)) {
    if (value !== "") out[name] = value;
  }
  return out;
}
