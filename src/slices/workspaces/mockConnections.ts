// Mock saved connections — ported verbatim from the prototype's data.js
// `connections` array. M1 is UI-only; M2's connection manager replaces this
// with real, persisted connections.
//
// Placement note: these live in the workspaces slice rather than a separate
// `connections` slice. A slice for one static array is premature, and the
// architecture forbids cross-slice imports (workspaces → connections) outside
// src/shared — when M2 introduces a real connections slice, the connect
// screen ownership moves with it.

import type { Connection } from "./types";

export const MOCK_CONNECTIONS: Connection[] = [
  {
    id: "local-sqlite",
    name: "shop_local",
    engine: "sqlite",
    detail: "~/dev/byteshop/shop_local.db",
    env: "local",
    envColor: "#56b6c2",
    version: "SQLite 3.46.0",
    schemas: ["main"],
    defaultSchema: "main",
  },
  {
    id: "staging-mysql",
    name: "byteshop_staging",
    engine: "mysql",
    detail: "staging.byteshop.dev:3306 · shop",
    env: "staging",
    envColor: "#e2b340",
    version: "MySQL 8.4.2",
    schemas: ["shop"],
    defaultSchema: "shop",
    tunnel: "SSH · bastion.byteshop.dev",
  },
  {
    id: "prod-pg",
    name: "byteshop_prod",
    engine: "postgres",
    detail: "db.byteshop.io:5432 · shop",
    env: "production",
    envColor: "#e06c75",
    version: "PostgreSQL 16.3",
    schemas: ["public", "analytics", "audit"],
    defaultSchema: "public",
    tunnel: "SSH · bastion.byteshop.io",
  },
];
