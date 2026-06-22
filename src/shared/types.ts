// Shared domain types used across slices and shared UI primitives.

/**
 * Database engine. The three relational engines (SQLite, MySQL, PostgreSQL),
 * `redis` (the key-value engine, M13), and `dynamodb` (the NoSQL document
 * store, M17). Lowercase on the wire, matching Rust's `Engine`.
 */
export type Engine =
  | "sqlite"
  | "mysql"
  | "postgres"
  | "redis"
  | "dynamodb"
  | "mongodb"
  | "cassandra";

/**
 * Deployment environment a connection points at (drives the EnvTag tint).
 * The canonical set is `dev | staging | production` (m15 redesign — the env
 * picker in the new-connection modal). Connections persisted before m15 used
 * `"local"` for what is now `"dev"`; those still load via the tolerant
 * {@link normalizeEnv} on the TS side and a serde `alias = "local"` on the
 * Rust `Env::Dev` variant.
 */
export type Env = "dev" | "staging" | "production";

/**
 * Map any persisted/wire env value onto the canonical set. The only legacy
 * value is `"local"` → `"dev"` (pre-m15); anything else passes through (a
 * canonical value, or an unknown value the backend would have rejected).
 * Read-boundary normalizer: callers that deserialize a {@link Env} (the
 * connections store load) run values through this so the rest of the app only
 * ever sees canonical values.
 */
export function normalizeEnv(env: string): Env {
  return env === "local" ? "dev" : (env as Env);
}
