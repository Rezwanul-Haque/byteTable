// Processes feature (M26) — backend wrappers + per-engine source metadata.
//
// `processList` / `processKill` invoke the Rust `process_*` commands (see
// `src-tauri/src/features/processes`). PROC_SOURCES carries the per-engine
// display bits the UI needs: the system source tag, the PID column label, the
// human-readable kill-statement PREVIEW (the authoritative kill runs in the
// backend), and — for Mongo/Redis — the column-header overrides.

import { invoke } from "@tauri-apps/api/core";

import type { Engine } from "../../shared/types";

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
  Record<"user" | "host" | "db" | "state" | "time" | "query", string>
>;

/** Per-engine display metadata for the Processes tab. */
export interface ProcSource {
  /** System source tag shown in the toolbar (e.g. `pg_stat_activity`). */
  src: string;
  /** The PID column header (MySQL `Id`, Postgres `PID`, …). */
  pidLabel: string;
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
    pidLabel: "Id",
    kill: (p) => "KILL " + p.pid + ";",
  },
  postgres: {
    src: "pg_stat_activity",
    pidLabel: "PID",
    kill: (p) => "SELECT pg_terminate_backend(" + p.pid + ");",
  },
  mssql: {
    src: "sys.dm_exec_sessions",
    pidLabel: "SPID",
    kill: (p) => "KILL " + p.pid + ";",
  },
  clickhouse: {
    src: "system.processes",
    pidLabel: "Query ID",
    kill: (p) => "KILL QUERY WHERE query_id = '" + (p.qid ?? p.pid) + "';",
  },
  mongodb: {
    src: "db.currentOp()",
    pidLabel: "OpId",
    kill: (p) => "db.killOp(" + p.pid + ")",
    labels: { user: "Op", host: "Client", db: "Namespace", query: "Command" },
  },
  redis: {
    src: "CLIENT LIST",
    pidLabel: "ID",
    kill: (p) => "CLIENT KILL ID " + p.pid,
    labels: {
      user: "Name",
      host: "Addr",
      db: "DB",
      state: "Flags",
      time: "Age",
      query: "Last command",
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
