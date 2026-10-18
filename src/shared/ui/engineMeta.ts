// Per-engine display name, short tag and accent — the app's one engine
// identity. EngineMark paints its logo in `color`, the import sheet tints its
// detection dot with it, and SchemaDiff stamps `short` on a connection card.
//
// A module of its own rather than a const inside the component that renders
// it: react-refresh forbids a component file exporting a constant, and the
// non-rendering callers (the import dialog naming the engine a pasted string
// resolved to) need the label without pulling in a component at all.

import { t, type StringKey } from "../i18n";
import type { BadgeEngine } from "../types";

interface EngineMeta {
  label: string;
  short: string;
  color: string;
  /** i18n key overriding `label` — set only where the label is not a product
   *  name (the data-file workspace). Every engine name is a brand: do not
   *  translate those. */
  labelKey?: StringKey;
}

export const ENGINE_META: Record<BadgeEngine, EngineMeta> = {
  sqlite: { label: "SQLite", short: "SQ", color: "#56b6c2" },
  mysql: { label: "MySQL", short: "My", color: "#e2b340" },
  postgres: { label: "PostgreSQL", short: "Pg", color: "#61afef" },
  // SQL Server (M21): crimson `MSS` badge (prototype ui.jsx ENGINE_META),
  // distinct from Redis's vermilion and the production/error reds.
  mssql: { label: "SQL Server", short: "MSS", color: "#d1495b" },
  // Redis (M13, REDIS_SPEC §1): vermilion, deliberately distinct from the
  // pinkish production/error red.
  redis: { label: "Redis", short: "Rd", color: "#e8533d" },
  // DynamoDB (M17): AWS-blue, distinct from Postgres's lighter blue.
  dynamodb: { label: "DynamoDB", short: "Dy", color: "#4d77ff" },
  // MongoDB (M18): MongoDB-green, distinct from every other engine tint.
  mongodb: { label: "MongoDB", short: "Mg", color: "#13aa52" },
  // Cassandra (M19): the Cassandra accent (prototype ui.jsx ENGINE_META),
  // a cyan-blue distinct from Postgres/Dynamo blues and SQLite's teal.
  cassandra: { label: "Cassandra", short: "Cs", color: "#1798c1" },
  // ClickHouse (M25): the ClickHouse yellow (prototype ui.jsx ENGINE_META),
  // distinct from every other engine tint. It is also the BRAND's own neon
  // yellow, which is why it stays this colour on a light theme even though it
  // measures 1.07:1 against white: a darker twin was tried and read as the
  // wrong logo. If the legibility ever has to be solved, solve it with a
  // container behind the mark — never by shifting the yellow.
  clickhouse: { label: "ClickHouse", short: "CH", color: "#faff69" },
  // Typesense (M30): the Typesense amber (prototype ui.jsx ENGINE_META),
  // warmer than MySQL's gold and unlike ClickHouse's acid yellow.
  typesense: { label: "Typesense", short: "Ts", color: "#e0a458" },
  // Data file (M35): not a database engine — the violet badge a CSV/TSV
  // workspace wears in the rail, title bar and sidebar (prototype ui.jsx
  // ENGINE_META.csv), distinct from Cassandra's cyan and Redis's vermilion.
  csv: { label: "Data file", short: "Cv", color: "#a78bfa", labelKey: "ws.rail.dataFile" },
};

/**
 * Display label for an engine: the localized string where one is keyed (only
 * the data-file workspace — every other label is a product name that must not
 * be translated), else the literal `label`.
 */
export function engineLabel(engine: BadgeEngine): string {
  const m = ENGINE_META[engine];
  return m.labelKey ? t(m.labelKey) : m.label;
}
