// Zustand store for the assistant slice (M44): chat SESSIONS per workspace,
// each drawer's open flag (per SQL tab), the editor's Undo snapshot, and
// caches of each schema's table/column names and each endpoint's models.
//
// Sessions belong to the workspace, not to a SQL tab: "find all users" asked
// from Query 1 is still in the history when Query 2 opens the drawer. One
// session is active per workspace; "New chat" starts another and the old one
// stays in the history list. Threads live here rather than in the drawer
// because a SQL tab unmounts when it is not the active one — an answer still
// streaming keeps arriving, into the session it was asked from. Nothing is
// persisted: sessions do not survive a restart (M44 §1).

import { create } from "zustand";

import { appErrorMessage } from "../../shared/api/error";
import { useSettingsStore } from "../settings/state";
import {
  aiSettingsOf,
  assistantCancel,
  assistantDiscard,
  assistantModels,
  assistantSchema,
  assistantSend,
  type AiSettingsKeys,
  type ModelsReport,
  type Prepared,
  type SchemaTable,
} from "./api";
import type { AiKind } from "./logic";

export type MsgState = "load" | "done" | "neterr" | "setup" | "error" | "cancelled";

export interface UserMsg {
  id: string;
  role: "user";
  kind: AiKind;
  text: string;
  /** The exact prompt that was sent — the receipt shows it. */
  prompt: Prepared;
  peek?: boolean;
}

export interface AiMsg {
  id: string;
  role: "ai";
  kind: AiKind;
  st: MsgState;
  /** The streamed reply so far. */
  raw: string;
  /** The SQL this answer was asked to change (follow-ups). */
  prevSql: string | null;
  /** The statement an explain / plan / index answer is about. */
  sql: string;
  took?: number;
  error?: string;
  used?: boolean;
  /** Why no plan went with a plan / index question (C10 states it). */
  planNote?: string;
}

export type Msg = UserMsg | AiMsg;

/** A message waiting for the user's Send. */
export interface Pending {
  kind: AiKind;
  say: string;
  req: string;
  prevSql: string | null;
  sql: string;
  prompt: Prepared;
}

export interface Thread {
  /** When the session was started / last sent a message (ms since epoch). */
  createdAt: number;
  updatedAt: number;
  msgs: Msg[];
  pending: Pending | null;
  peek: boolean;
  /** Building a prompt (introspecting) — the composer waits. */
  preparing: boolean;
  /** The id of the answer currently streaming, if any. */
  streaming: string | null;
}

const EMPTY: Thread = {
  createdAt: 0,
  updatedAt: 0,
  msgs: [],
  pending: null,
  peek: false,
  preparing: false,
  streaming: null,
};

/** One workspace's sessions, newest first, and the one the drawer shows. */
export interface SessionList {
  ids: string[];
  active: string | null;
}

const NO_SESSIONS: SessionList = { ids: [], active: null };

export const schemaKey = (handleId: string, schema: string) => handleId + "\u0000" + schema;

/** The open-flag key for a non-SQL workspace's drawer (one per workspace; a
 *  SQL workspace keys its drawers by tab id). */
export const hostKey = (workspaceId: string) => "ws:" + workspaceId;

/** Which endpoint a model list belongs to: provider, runtime, URLs, vendor. */
export function modelsKey(s: AiSettingsKeys): string {
  return [
    s.aiProvider,
    s.aiRuntime,
    s.aiOllamaUrl,
    s.aiLmUrl,
    s.aiCustomUrl,
    s.aiVendor,
    s.aiKeyUrl,
  ].join("\u0000");
}

/** A request from outside the tab (palette, menu) to open its drawer. */
export interface OpenRequest {
  what: "ask" | "panel";
  nonce: number;
  /** Ask the assistant this (the palette's "Ask assistant: …"). */
  text?: string;
}

interface AssistantFeatureState {
  /** Threads by session id. */
  threads: Record<string, Thread>;
  /** Sessions by workspace id. */
  sessions: Record<string, SessionList>;
  open: Record<string, boolean>;
  /** Editor text before the assistant's last edit, per SQL tab. */
  undo: Record<string, string | null>;
  schemas: Record<string, SchemaTable[]>;
  schemaErrors: Record<string, string>;
  /** The destination's model list, keyed by `modelsKey`. */
  models: Record<string, ModelsReport>;
  openRequest: OpenRequest | null;

  thread: (sid: string | null) => Thread;
  patch: (sid: string, p: Partial<Thread>) => void;
  patchMsg: (sid: string, id: string, p: Partial<AiMsg> | Partial<UserMsg>) => void;
  /** The workspace's active session, started on demand. */
  ensureSession: (ws: string) => string;
  /** Start a new session (unless the active one is still empty). */
  newSession: (ws: string) => void;
  switchSession: (ws: string, sid: string) => void;
  /** Drop a session; stops its answer if one is streaming. */
  deleteSession: (ws: string, sid: string) => void;
  setOpen: (tabId: string, open: boolean) => void;
  setUndo: (tabId: string, text: string | null) => void;
  requestOpen: (what: OpenRequest["what"], text?: string) => void;
  consumeOpenRequest: () => OpenRequest | null;
  loadSchema: (handleId: string, schema: string, force?: boolean) => Promise<SchemaTable[] | null>;
  /** Ask the destination for its models (the drawer's model switcher). */
  loadModels: (settings: AiSettingsKeys, connectionId: string, force?: boolean) => Promise<void>;
  /** Send the session's pending message and stream the answer into it. */
  deliver: (sid: string) => void;
  cancel: (sid: string) => void;
}

const uid = () => Math.random().toString(36).slice(2, 10);

export const useAssistantStore = create<AssistantFeatureState>((set, get) => {
  const patch = (sid: string, p: Partial<Thread>) =>
    set((s) => ({ threads: { ...s.threads, [sid]: { ...(s.threads[sid] ?? EMPTY), ...p } } }));
  const patchMsg = (sid: string, id: string, p: Partial<AiMsg> | Partial<UserMsg>) =>
    set((s) => {
      const t = s.threads[sid] ?? EMPTY;
      return {
        threads: {
          ...s.threads,
          [sid]: { ...t, msgs: t.msgs.map((m) => (m.id === id ? ({ ...m, ...p } as Msg) : m)) },
        },
      };
    });
  /** A fresh session at the top of the workspace's list, made active. */
  const start = (ws: string): string => {
    const sid = uid();
    const now = Date.now();
    set((s) => {
      const list = s.sessions[ws] ?? NO_SESSIONS;
      return {
        threads: { ...s.threads, [sid]: { ...EMPTY, createdAt: now, updatedAt: now } },
        sessions: { ...s.sessions, [ws]: { ids: [sid, ...list.ids], active: sid } },
      };
    });
    return sid;
  };
  const isEmpty = (t: Thread | undefined) => !t || (!t.msgs.length && !t.pending && !t.preparing);

  return {
    threads: {},
    sessions: {},
    open: {},
    undo: {},
    schemas: {},
    schemaErrors: {},
    models: {},
    openRequest: null,

    thread: (sid) => (sid ? get().threads[sid] : undefined) ?? EMPTY,
    patch,
    patchMsg,
    ensureSession: (ws) => get().sessions[ws]?.active ?? start(ws),
    newSession: (ws) => {
      const active = get().sessions[ws]?.active;
      if (active && isEmpty(get().threads[active])) return;
      start(ws);
    },
    switchSession: (ws, sid) =>
      set((s) => {
        const list = s.sessions[ws];
        if (!list?.ids.includes(sid)) return s;
        return { sessions: { ...s.sessions, [ws]: { ...list, active: sid } } };
      }),
    deleteSession: (ws, sid) => {
      const t = get().threads[sid];
      if (t?.streaming) void assistantCancel(t.streaming).catch(() => {});
      if (t?.pending) void assistantDiscard(t.pending.prompt.id).catch(() => {});
      set((s) => {
        const list = s.sessions[ws] ?? NO_SESSIONS;
        const ids = list.ids.filter((x) => x !== sid);
        const threads = { ...s.threads };
        delete threads[sid];
        return {
          threads,
          sessions: {
            ...s.sessions,
            [ws]: { ids, active: list.active === sid ? (ids[0] ?? null) : list.active },
          },
        };
      });
    },
    setOpen: (tabId, open) => set((s) => ({ open: { ...s.open, [tabId]: open } })),
    setUndo: (tabId, text) => set((s) => ({ undo: { ...s.undo, [tabId]: text } })),
    requestOpen: (what, text) => set({ openRequest: { what, nonce: Date.now(), text } }),
    consumeOpenRequest: () => {
      const r = get().openRequest;
      if (r) set({ openRequest: null });
      return r;
    },

    loadSchema: async (handleId, schema, force) => {
      const key = schemaKey(handleId, schema);
      const cached = get().schemas[key];
      if (cached && !force) return cached;
      try {
        const tables = await assistantSchema(handleId, schema);
        set((s) => ({
          schemas: { ...s.schemas, [key]: tables },
          schemaErrors: { ...s.schemaErrors, [key]: "" },
        }));
        return tables;
      } catch (err) {
        set((s) => ({ schemaErrors: { ...s.schemaErrors, [key]: appErrorMessage(err, "") } }));
        return null;
      }
    },

    loadModels: async (settings, connectionId, force) => {
      const key = modelsKey(settings);
      if (get().models[key] && !force) return;
      let report: ModelsReport;
      try {
        report = await assistantModels(settings, connectionId);
      } catch (err) {
        report = {
          reachable: false,
          models: [],
          error: { kind: "failed", message: appErrorMessage(err, "") },
        };
      }
      set((s) => ({ models: { ...s.models, [key]: report } }));
    },

    deliver: (sid) => {
      const t = get().thread(sid);
      const p = t.pending;
      if (!p || t.streaming) return;
      const id = p.prompt.id;
      const user: UserMsg = {
        id: uid(),
        role: "user",
        kind: p.kind,
        text: p.say,
        prompt: p.prompt,
      };
      const at = p.prompt.parts.findIndex((x) => x.t === "[plan] unavailable");
      const ai: AiMsg = {
        id,
        role: "ai",
        kind: p.kind,
        st: "load",
        raw: "",
        prevSql: p.prevSql,
        sql: p.sql,
        planNote: at >= 0 ? p.prompt.parts[at + 1]?.t : undefined,
      };
      patch(sid, {
        msgs: [...t.msgs, user, ai],
        pending: null,
        peek: false,
        streaming: id,
        updatedAt: Date.now(),
      });
      const t0 = performance.now();
      let raw = "";
      let settled = false;
      const settle = (p2: Partial<AiMsg>) => {
        if (settled) return;
        settled = true;
        patchMsg(sid, id, { ...p2, took: Math.round(performance.now() - t0) });
        patch(sid, { streaming: null });
      };
      assistantSend(id, aiSettingsOf(useSettingsStore.getState().settings), (e) => {
        if (e.event === "token") {
          raw += e.text;
          patchMsg(sid, id, { raw });
        } else if (e.event === "done") settle({ st: "done", raw });
        else if (e.event === "cancelled") settle({ st: "cancelled", raw });
        else if (e.kind === "unreachable") settle({ st: "neterr", error: e.message });
        else if (e.kind === "setup") settle({ st: "setup", error: e.message });
        else settle({ st: "error", error: e.message, raw });
      })
        .then(() =>
          settle({ st: raw ? "done" : "error", raw, error: raw ? undefined : "No reply." }),
        )
        .catch((err: unknown) =>
          settle({ st: "error", error: appErrorMessage(err, "Couldn’t send.") }),
        );
    },

    cancel: (sid) => {
      const s = get().thread(sid).streaming;
      if (s) void assistantCancel(s).catch(() => {});
    },
  };
});
