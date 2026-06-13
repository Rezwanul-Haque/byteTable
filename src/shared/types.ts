// Shared domain types used across slices and shared UI primitives.

/**
 * Database engine. The three relational engines (SQLite, MySQL, PostgreSQL)
 * plus `redis`, the key-value engine added in M13. Lowercase on the wire,
 * matching Rust's `Engine`.
 */
export type Engine = "sqlite" | "mysql" | "postgres" | "redis";

/** Deployment environment a connection points at (drives the EnvTag tint). */
export type Env = "local" | "staging" | "production";
