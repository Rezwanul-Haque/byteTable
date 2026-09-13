// Processes feature (M26) — backend wrappers + per-engine source metadata.
//
// `processList` / `processKill` invoke the Rust `process_*` commands (see
// `src-tauri/src/features/processes`). PROC_SOURCES carries the per-engine
// display bits the UI needs: the system source tag, the PID column label, the
// human-readable kill-statement PREVIEW (the authoritative kill runs in the
// backend), and — for Mongo/Redis — the column-header overrides.

import { invoke } from "@tauri-apps/api/core";

import type { Engine } from "../../shared/types";
import type { StringKey } from "../../shared/i18n";

/** One live server session / operation / client (mirrors Rust `ProcessInfo`). */
export interface ProcessInfo {
  pid: string;
  serial?: string;
  qid?: string;
  user: string;
  host: string;
  db: string;
  state: string;
  timeS: number;
  query: string;
  isSelf: boolean;
}

/** The id(s) sent back to kill one process (mirrors Rust `ProcessKill`). */
export interface ProcessKill {
  pid: string;
  serial?: string;
  qid?: string;
}

/** List the engine's live sessions / operations / clients. */
export function processList(handleId: string): Promise<ProcessInfo[]> {
  return invoke<ProcessInfo[]>("process_list", { handleId });
}

/** Kill one session / operation / client. */
export function processKill(handleId: string, target: ProcessKill): Promise<void> {
  return invoke("process_kill", { handleId, target });
}

/** Column-header overrides for the engines whose columns aren't SQL sessions. */
export type ProcLabels = Partial<
  Record<"user" | "host" | "db" | "state" | "time" | "query", StringKey>
>;

/** Per-engine display metadata for the Processes tab. */
export interface ProcSource {
  /** System source tag shown in the toolbar (e.g. `pg_stat_activity`). */
  src: string;
  /**
   * The PID column header (MySQL `Id`, Postgres `PID`, …), as an i18n key: the
   * engines name this column themselves, so the label is engine vocabulary —
   * a key lets the header stay native in English while still being translatable.
   */
  pidKey: StringKey;
  /** The human-readable kill statement previewed in the confirm modal. */
  kill: (p: ProcessInfo | ProcessKill) => string;
  /** Column-header overrides (Mongo / Redis rename the session columns). */
  labels?: ProcLabels;
}

/**
 * Per-engine sources & kill statements (M26). Oracle is intentionally absent —
 * the Oracle engine is not built on this branch. An engine with no entry here
 * (SQLite, DynamoDB, Cassandra, Typesense) has no server process list; the tab
 * shows an embedded/empty state.
 */
export const PROC_SOURCES: Partial<Record<Engine, ProcSource>> = {
  mysql: {
    src: "SHOW FULL PROCESSLIST",
    pidKey: "proc.pid.mysql",
    kill: (p) => "KILL " + p.pid + ";",
  },
  postgres: {
    src: "pg_stat_activity",
    pidKey: "proc.pid.postgres",
    kill: (p) => "SELECT pg_terminate_backend(" + p.pid + ");",
  },
  mssql: {
    src: "sys.dm_exec_sessions",
    pidKey: "proc.pid.mssql",
    kill: (p) => "KILL " + p.pid + ";",
  },
  clickhouse: {
    src: "system.processes",
    pidKey: "proc.pid.clickhouse",
    kill: (p) => "KILL QUERY WHERE query_id = '" + (p.qid ?? p.pid) + "';",
  },
  mongodb: {
    src: "db.currentOp()",
    pidKey: "proc.pid.mongo",
    kill: (p) => "db.killOp(" + p.pid + ")",
    labels: {
      user: "proc.col.op",
      host: "proc.col.client",
      db: "proc.col.namespace",
      query: "proc.col.command",
    },
  },
  redis: {
    src: "CLIENT LIST",
    pidKey: "proc.pid.redis",
    kill: (p) => "CLIENT KILL ID " + p.pid,
    labels: {
      user: "proc.col.name",
      host: "proc.col.addr",
      db: "proc.col.db",
      state: "proc.col.flags",
      time: "proc.col.age",
      query: "proc.col.lastCommand",
    },
  },
};

/** State-chip class: accent (run) / amber (warn) / faint (idle). */
export function procStateCls(s: string): "run" | "warn" | "idle" {
  if (s === "active" || s === "pubsub") return "run";
  if (s.indexOf("waiting") === 0 || s.indexOf("blocked") === 0 || s === "idle in transaction")
    return "warn";
  return "idle";
}

/** Format elapsed seconds as `MMs` / `MMm SSs` / `HHh MMm`. */
export function fmtProcTime(t: number): string {
  if (t < 60) return t + "s";
  if (t < 3600) return Math.floor(t / 60) + "m " + (t % 60) + "s";
  return Math.floor(t / 3600) + "h " + Math.floor((t % 3600) / 60) + "m";
}

/** Plural noun for the toolbar stat / footer: sessions / operations / clients. */
export function procNounPlural(engine: Engine): string {
  return engine === "redis" ? "clients" : engine === "mongodb" ? "operations" : "sessions";
}

/** Singular noun for the kill modal: process / operation / client. */
export function procNoun(engine: Engine): string {
  return engine === "redis" ? "client" : engine === "mongodb" ? "operation" : "process";
}
