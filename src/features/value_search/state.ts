// Zustand store driving the value-search modal: type a value → sweep every
// table → watch hits land live, cancel at any point. Renderer-internal UI state
// only; the backend owns the sweep. Errors surface as the §5 human message
// (`{ kind, message }`).

import { create } from "zustand";

import { isAppErrorPayload } from "../../shared/api/error";
import {
  valueSearchCancel,
  valueSearchRun,
  type MatchMode,
  type SearchProgress,
  type TableHit,
  type ValueSearchSummary,
} from "./api";

type Status = "idle" | "running" | "done" | "error";

/** Pull a human message out of an unknown rejection. */
function errorMessage(err: unknown): string {
  if (isAppErrorPayload(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

interface ValueSearchState {
  open: boolean;
  handleId: string | null;
  /** The schema the modal was opened from; `null` means every user schema. */
  schema: string | null;
  /** Restrict the sweep to `schema`, or let it cover the whole database. */
  scopeToSchema: boolean;
  needle: string;
  mode: MatchMode;
  includeSystemSchemas: boolean;
  status: Status;
  /** Hits in arrival order (smallest tables first). */
  hits: TableHit[];
  /** The table currently being read, for the progress line. */
  current: { schema: string; table: string; done: number; total: number } | null;
  summary: ValueSearchSummary | null;
  error: string | null;
  runId: string | null;

  /** Open the modal for a (connection handle, schema); resets prior state. */
  openModal: (handleId: string, schema: string | null) => void;
  setNeedle: (needle: string) => void;
  setMode: (mode: MatchMode) => void;
  setScopeToSchema: (scoped: boolean) => void;
  setIncludeSystemSchemas: (include: boolean) => void;
  /** Start the sweep; streams hits into `hits` and stores the summary. */
  run: () => Promise<void>;
  /** Cancel an in-flight sweep (takes effect at the next table boundary). */
  cancel: () => Promise<void>;
  /** Close and reset the modal. */
  close: () => void;
}

const INITIAL = {
  open: false,
  handleId: null,
  schema: null,
  scopeToSchema: true,
  needle: "",
  mode: "contains" as MatchMode,
  includeSystemSchemas: false,
  status: "idle" as Status,
  hits: [],
  current: null,
  summary: null,
  error: null,
  runId: null,
};

export const useValueSearchStore = create<ValueSearchState>((set, get) => ({
  ...INITIAL,

  openModal: (handleId, schema) =>
    set({ ...INITIAL, open: true, handleId, schema, scopeToSchema: schema !== null }),

  setNeedle: (needle) => set({ needle }),
  setMode: (mode) => set({ mode }),
  setScopeToSchema: (scopeToSchema) => set({ scopeToSchema }),
  setIncludeSystemSchemas: (includeSystemSchemas) => set({ includeSystemSchemas }),

  run: async () => {
    const { handleId, schema, scopeToSchema, needle, mode, includeSystemSchemas } = get();
    if (!handleId || !needle.trim()) return;
    const runId = crypto.randomUUID();
    set({ status: "running", error: null, hits: [], current: null, summary: null, runId });
    try {
      const summary = await valueSearchRun(
        handleId,
        needle,
        runId,
        {
          mode,
          schemas: scopeToSchema && schema ? [schema] : [],
          includeSystemSchemas,
        },
        (p: SearchProgress) => {
          // Ignore ticks from a run the user already replaced.
          if (get().runId !== runId) return;
          set((s) => ({
            current: { schema: p.schema, table: p.table, done: p.done, total: p.total },
            hits: p.hit ? [...s.hits, p.hit] : s.hits,
          }));
        },
      );
      if (get().runId !== runId) return;
      // The summary is authoritative — it repeats every streamed hit, so
      // taking it wholesale also repairs any tick lost to a dropped message.
      set({ status: "done", summary, hits: summary.hits, current: null });
    } catch (err) {
      if (get().runId !== runId) return;
      set({ status: "error", error: errorMessage(err), current: null });
    } finally {
      if (get().runId === runId) set({ runId: null });
    }
  },

  cancel: async () => {
    const { runId } = get();
    if (!runId) return;
    try {
      await valueSearchCancel(runId);
    } catch {
      // Best-effort: if the sweep already finished the flag is gone.
    }
  },

  close: () => set({ ...INITIAL }),
}));
