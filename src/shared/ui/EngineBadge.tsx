// Engine badge — ported from ui.jsx EngineBadge. Formula per spec §1.3:
// {color}22 fill, {color}55 1px border, color text, radius 7, mono 600,
// font-size = 0.42 × badge size. Hexes mirror --engine-* in tokens.css;
// literals are kept so the prototype's alpha-suffix pattern stays exact.

import type { Engine } from "../types";

import "./EngineBadge.css";

// Re-exported for back-compat — Engine now lives in src/shared/types.ts.
export type { Engine };

const ENGINE_META: Record<Engine, { label: string; short: string; color: string }> = {
  sqlite: { label: "SQLite", short: "SQ", color: "#56b6c2" },
  mysql: { label: "MySQL", short: "My", color: "#e2b340" },
  postgres: { label: "PostgreSQL", short: "Pg", color: "#61afef" },
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
};

interface EngineBadgeProps {
  engine: Engine;
  size?: number;
}

export function EngineBadge({ engine, size = 22 }: EngineBadgeProps) {
  const m = ENGINE_META[engine];
  return (
    <span
      className="engine-badge"
      title={m.label}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: m.color + "22",
        color: m.color,
        border: "1px solid " + m.color + "55",
      }}
    >
      {m.short}
    </span>
  );
}
