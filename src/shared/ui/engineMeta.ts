// Per-engine display name, badge initials and accent — the source EngineBadge
// renders from. Its own module rather than a const inside EngineBadge.tsx so
// non-badge callers (the connect modal's import dialog names the engine a
// pasted string resolved to) can read the label without a component file
// exporting a constant, which react-refresh forbids.

import type { BadgeEngine } from "../types";

export const ENGINE_META: Record<BadgeEngine, { label: string; short: string; color: string }> = {
  sqlite: { label: "SQLite", short: "SQ", color: "#56b6c2" },
  mysql: { label: "MySQL", short: "My", color: "#e2b340" },
  postgres: { label: "PostgreSQL", short: "Pg", color: "#61afef" },
  // SQL Server (M21): crimson `MSS` badge (prototype ui.jsx ENGINE_META),
  // distinct from Redis's vermilion and the production/error reds.
  mssql: { label: "MS SQL Server", short: "MSS", color: "#d1495b" },
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
  // distinct from every other engine tint.
  clickhouse: { label: "ClickHouse", short: "CH", color: "#faff69" },
  // Typesense (M30): the Typesense amber (prototype ui.jsx ENGINE_META),
  // warmer than MySQL's gold and unlike ClickHouse's acid yellow.
  typesense: { label: "Typesense", short: "Ts", color: "#e0a458" },
  // Data file (M35): not a database engine — the violet badge a CSV/TSV
  // workspace wears in the rail, title bar and sidebar (prototype ui.jsx
  // ENGINE_META.csv), distinct from Cassandra's cyan and Redis's vermilion.
  csv: { label: "Data file", short: "Cv", color: "#a78bfa" },
};
