// Zustand store driving the Generate-data modal (M16): pick size → preview the
// plan → run with live per-table progress and cancel. Renderer-internal UI
// state only; the backend owns the actual generation. Errors surface as the §5
// human message (`{ kind, message }`).

import { create } from "zustand";

import { isAppErrorPayload } from "../../shared/api/error";
import {
  generateCancel,
  generatePreview,
  generateRun,
  type GeneratePlan,
  type GenerateSize,
  type GenerateSummary,
  type GenProgress,
} from "./api";

type Status = "idle" | "previewing" | "running" | "done" | "error";

/** Pull a human message out of an unknown rejection. */
function errorMessage(err: unknown): string {
  if (isAppErrorPayload(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

interface GenerateModalState {
  open: boolean;
  handleId: string | null;
  schema: string | null;
  size: GenerateSize | null;
  plan: GeneratePlan | null;
  status: Status;
  /** Per-table progress, keyed by table name. */
  progress: Record<string, GenProgress>;
  summary: GenerateSummary | null;
  error: string | null;
  runId: string | null;

  /** Open the modal for a (connection handle, schema); resets prior state. */
  openModal: (handleId: string, schema: string) => void;
  /** Pick a size and load its preview plan. */
  setSize: (size: GenerateSize) => Promise<void>;
  /** Run generation; streams progress and stores the summary. */
  run: () => Promise<void>;
  /** Cancel an in-flight run. */
  cancel: () => Promise<void>;
  /** Close and reset the modal. */
  close: () => void;
}

const INITIAL = {
  open: false,
  handleId: null,
  schema: null,
  size: null,
  plan: null,
  status: "idle" as Status,
  progress: {},
  summary: null,
  error: null,
  runId: null,
};

export const useGenerateStore = create<GenerateModalState>((set, get) => ({
  ...INITIAL,

  openModal: (handleId, schema) => set({ ...INITIAL, open: true, handleId, schema }),

  setSize: async (size) => {
    const { handleId, schema } = get();
    if (!handleId || !schema) return;
    set({ size, status: "previewing", error: null, plan: null, summary: null });
    try {
      const plan = await generatePreview(handleId, schema, size);
      // Ignore a stale response if the user changed size meanwhile.
      if (get().size !== size) return;
      set({ plan, status: "idle" });
    } catch (err) {
      set({ status: "error", error: errorMessage(err) });
    }
  },

  run: async () => {
    const { handleId, schema, size } = get();
    if (!handleId || !schema || !size) return;
    const runId = crypto.randomUUID();
    set({ status: "running", error: null, progress: {}, summary: null, runId });
    try {
      const summary = await generateRun(handleId, schema, size, runId, (p: GenProgress) => {
        set((s) => ({ progress: { ...s.progress, [p.table]: p } }));
      });
      set({ status: "done", summary });
    } catch (err) {
      set({ status: "error", error: errorMessage(err) });
    } finally {
      set({ runId: null });
    }
  },

  cancel: async () => {
    const { runId } = get();
    if (!runId) return;
    try {
      await generateCancel(runId);
    } catch {
      // Best-effort: if the run already finished the flag is gone; nothing to do.
    }
  },

  close: () => set({ ...INITIAL }),
}));
