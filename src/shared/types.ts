// Shared domain types used across slices and shared UI primitives.

/** Database engine — the three engines ByteTable supports in M1. */
export type Engine = "sqlite" | "mysql" | "postgres";

/** Deployment environment a connection points at (drives the EnvTag tint). */
export type Env = "local" | "staging" | "production";
