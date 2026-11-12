// Typed invoke() wrappers for the Rust assistant slice
// (`src-tauri/src/features/assistant`). The backend builds every prompt, holds
// it under an id, and sends exactly those bytes — this file never assembles a
// prompt of its own. Every call that can reach a model carries the assistant's
// settings keys as they are right now (`aiSettingsOf`), so a switch flipped a
// moment ago is what the backend gates on.

import { Channel, invoke } from "@tauri-apps/api/core";

import type { Settings } from "../settings/api";
import type { AiKind } from "./logic";

/** What a URL says about its host. Mirrors Rust `dest::HostOf`. */
export interface HostOf {
  host: string;
  name: string;
  /** The host is this machine: `localhost`, `127.x` or `[::1]`. */
  loopback: boolean;
  /** A full `http://` / `https://` URL. */
  ok: boolean;
}

/** Where prompts go. Mirrors Rust `dest::Dest`. */
export interface Dest {
  local: boolean;
  host: string;
  via: string;
  model: string;
  custom: boolean;
  ready: boolean;
}

export type AiState = "off" | "locked" | "on";

/** The destination rule and lock state, as the backend computes them. */
export interface Described {
  dest: Dest;
  state: AiState;
  rowsAllowed: boolean;
  runtime: HostOf;
  custom: HostOf;
}

/** One line of a prompt and how the review view styles it. */
export interface PromptPart {
  k: "sec" | "sec-rows" | "rows" | "req" | "";
  t: string;
}

/** A parked prompt, as the review line and the receipt show it. */
export interface Prepared {
  id: string;
  parts: PromptPart[];
  text: string;
  tokens: number;
  tables: number;
  cols: number;
  rowTables: string[];
}

export interface PrepareRequest {
  handleId: string;
  schema: string;
  kind: AiKind;
  scope: string[];
  request?: string;
  sql?: string;
  prevSql?: string | null;
  error?: string;
  rowData?: boolean;
  /** Tables the message @-mentions: the backend sends only their structure
   *  (and their foreign-key targets) for this message. */
  focus?: string[];
  /** The workspace's saved-connection id (used when its handle was opened ad
   *  hoc, so the backend has no saved origin to key the switch by). */
  connectionId?: string;
}

/** A base table's names — structure only, never rows. */
export interface SchemaTable {
  name: string;
  columns: string[];
  indexes: string[];
}

export type StreamEvent =
  | { event: "token"; text: string }
  | { event: "done"; ms: number }
  | { event: "cancelled" }
  | {
      event: "error";
      /** `unreachable` and `setup` mean nothing was sent. */
      kind: "unreachable" | "auth" | "failed" | "setup" | "refused";
      message: string;
    };

export interface ProviderError {
  kind: "unreachable" | "auth" | "failed";
  message: string;
}

export interface ModelInfo {
  name: string;
  size: number | null;
  tag: string | null;
}

export interface ModelsReport {
  reachable: boolean;
  models: ModelInfo[];
  error: ProviderError | null;
}

export interface TestReport {
  ok: boolean;
  ms: number;
  error: ProviderError | null;
}

export type KeyAccount = "anthropic" | "openai" | "custom";

export interface KeyInfo {
  account: KeyAccount;
  /** `sk-ant-••••3f9a` — the key itself never reaches the renderer. */
  masked: string | null;
  keychain: string;
}

export interface LogEntry {
  time: string;
  kind: string;
  tokens: number;
  host: string;
  rows: boolean;
  text: string;
}

export interface LogPage {
  total: number;
  entries: LogEntry[];
}

/** The assistant's settings keys — the slice of `Settings` the backend reads. */
export type AiSettingsKeys = {
  [K in keyof Settings as K extends `ai${string}` ? K : never]: Settings[K];
};

/** The `ai*` keys of a settings object — what the assistant's commands take. */
export function aiSettingsOf(s: Settings): AiSettingsKeys {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (k.startsWith("ai")) out[k] = v;
  return out as AiSettingsKeys;
}

/** Ask the backend where prompts would go, and whether this workspace is
 *  locked, under the settings the renderer is showing. Gates nothing. */
export function assistantDescribe(
  settings: AiSettingsKeys,
  production: boolean,
  connectionId: string | null,
): Promise<Described> {
  return invoke<Described>("assistant_describe", { settings, production, connectionId });
}

export function assistantSchema(handleId: string, schema: string): Promise<SchemaTable[]> {
  return invoke<SchemaTable[]>("assistant_schema", { handleId, schema });
}

/** Build and park the exact prompt. Sends nothing. */
export function assistantPrepare(
  request: PrepareRequest,
  settings: AiSettingsKeys,
): Promise<Prepared> {
  return invoke<Prepared>("assistant_prepare", { request, settings });
}

/** Send a parked prompt; `onEvent` receives the streamed reply. */
export function assistantSend(
  id: string,
  settings: AiSettingsKeys,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  return invoke("assistant_send", { id, settings, onEvent: channel });
}

export function assistantCancel(id: string): Promise<void> {
  return invoke("assistant_cancel", { id });
}

export function assistantDiscard(id: string): Promise<void> {
  return invoke("assistant_discard", { id });
}

/** The endpoint's models — only while the assistant is on for `connectionId`
 *  (the active workspace); off or no workspace = no call. */
export function assistantModels(
  settings: AiSettingsKeys,
  connectionId: string | null,
): Promise<ModelsReport> {
  return invoke<ModelsReport>("assistant_models", { settings, connectionId });
}

export function assistantTest(
  settings: AiSettingsKeys,
  connectionId: string | null,
): Promise<TestReport> {
  return invoke<TestReport>("assistant_test", { settings, connectionId });
}

export function keyInfo(account: KeyAccount): Promise<KeyInfo> {
  return invoke<KeyInfo>("assistant_key_info", { account });
}

export function keySet(account: KeyAccount, key: string): Promise<KeyInfo> {
  return invoke<KeyInfo>("assistant_key_set", { account, key });
}

export function keyRemove(account: KeyAccount): Promise<KeyInfo> {
  return invoke<KeyInfo>("assistant_key_remove", { account });
}

export function logRead(limit = 50): Promise<LogPage> {
  return invoke<LogPage>("assistant_log_read", { limit });
}

export function logClear(): Promise<void> {
  return invoke("assistant_log_clear");
}
