// The change history's renderer state (M48): which connections record, and a
// version that ticks whenever the log changes, so every open view refreshes.

import { create } from "zustand";

import { historyRecording, historySetRecording } from "./api";

interface HistoryState {
  /** The log changed (a write was recorded, an undo ran, it was cleared). */
  version: number;
  bump: () => void;
  /** "Record on this connection", by saved connection id (loaded lazily). */
  recording: Record<string, boolean>;
  loadRecording: (connectionId: string) => Promise<boolean>;
  setRecording: (connectionId: string, on: boolean) => Promise<void>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
  recording: {},
  loadRecording: async (connectionId) => {
    const known = get().recording[connectionId];
    if (known !== undefined) return known;
    const on = await historyRecording(connectionId).catch(() => true);
    set((s) => ({ recording: { ...s.recording, [connectionId]: on } }));
    return on;
  },
  setRecording: async (connectionId, on) => {
    await historySetRecording(connectionId, on);
    set((s) => ({ recording: { ...s.recording, [connectionId]: on }, version: s.version + 1 }));
  },
}));
