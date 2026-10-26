// Zustand store for the global schedule list and its run history (M41).
// Mutations go backend-first, then patch the in-memory list from the backend's
// reply — the JSON stores are the source of truth, never optimistic state.
// That matters more here than elsewhere: `nextRunAt` is computed by the
// backend on every save, so an optimistic patch would show the wrong next run
// until the next reload.
//
// GLOBAL store, not per-workspace: a schedule names its own connection and
// runs whether or not that connection has a workspace open — or any workspace
// at all.

import { create } from "zustand";

import { isAppErrorPayload } from "../../shared/api/error";
import {
  scheduleDelete,
  scheduleList,
  scheduleRunNow,
  scheduleRuns,
  scheduleSave,
  scheduleSetEnabled,
  type RunHistory,
  type RunRecord,
  type Schedule,
} from "./api";

/**
 * A prefill for the manager's editor — "Schedule this query" on a saved-query
 * row. `sql` is already RESOLVED: the opener substitutes query parameters
 * against its own engine before handing it over, because a schedule stores a
 * snapshot (see `api.ts`).
 */
export interface ScheduleSeed {
  sql: string;
  savedQueryId?: string;
  schema?: string;
}

interface SchedulesFeatureState {
  schedules: Schedule[];
  /** Run history keyed by schedule id, newest last. */
  runs: RunHistory;
  /** True once the first load() settled — gates empty-state rendering. */
  loaded: boolean;
  /**
   * Human message when the backend itself failed to read the store (a corrupt
   * `schedules.json`) — null when the load succeeded or there is no Tauri at
   * all (plain browser dev).
   */
  loadError: string | null;
  /**
   * The schedule currently executing, so its row can show it working and the
   * other ▶ buttons can go quiet (runs are serialized in the backend).
   *
   * Driven by the backend's start/finish EVENTS, not by `runNow`'s promise, so
   * a scheduled 3am run lights the row exactly like a clicked one. `runNow`
   * also sets it optimistically to cover the IPC round trip before the start
   * event lands.
   */
  runningId: string | null;
  /**
   * Whether the manager is on screen, and what it should open with.
   *
   * In the STORE rather than in the host's `useState` because the openers are
   * spread across the tree — the rail (app level), the Query menu, and the
   * "Schedule this query" action inside a workspace's saved-query drawer —
   * while the modal has exactly one host, at app level so it works with no
   * workspace open. Threading a callback from `App` down to the drawer for
   * the one case that carries a payload is the alternative, and it is worse.
   */
  managerOpen: boolean;
  seed: ScheduleSeed | null;
  /** Open the manager, optionally straight into a prefilled new schedule. */
  openManager: (seed?: ScheduleSeed) => void;
  closeManager: () => void;
  /**
   * Fetch both stores. Unlike the saved-queries store this is NOT idempotent:
   * the background scheduler mutates `nextRunAt` and appends runs with no
   * renderer involved, so reopening the manager has to re-read rather than
   * trust a settled load.
   */
  load: () => Promise<void>;
  save: (schedule: Schedule) => Promise<Schedule>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Run now. Resolves with the record even when the run failed. */
  runNow: (id: string) => Promise<RunRecord>;
  /** A run has begun — the backend's `schedules://run-started` event. */
  markRunning: (scheduleId: string) => void;
  /**
   * Fold in a run that finished elsewhere — the backend's
   * `schedules://run-finished` event, which is how a 3am run or a run started
   * before the manager was opened reaches an open list.
   */
  applyRun: (record: RunRecord) => void;
}

/** History entries kept per schedule in memory, matching the backend's bound. */
const MAX_HISTORY = 20;

export const useSchedulesStore = create<SchedulesFeatureState>((set) => ({
  schedules: [],
  runs: {},
  loaded: false,
  loadError: null,
  runningId: null,
  managerOpen: false,
  seed: null,

  openManager: (seed) => set({ managerOpen: true, seed: seed ?? null }),
  // The seed is cleared with the modal, so the next open from the rail or the
  // menu lands on the list rather than reopening someone's old prefill.
  closeManager: () => set({ managerOpen: false, seed: null }),

  load: async () => {
    try {
      const [schedules, runs] = await Promise.all([scheduleList(), scheduleRuns()]);
      set({ schedules, runs, loaded: true, loadError: null });
    } catch (error) {
      if (isAppErrorPayload(error)) {
        // The backend is there but could not read the store (corrupt file,
        // I/O failure) — be honest about it instead of presenting a
        // convincing-but-false empty list.
        set({ schedules: [], runs: {}, loaded: true, loadError: error.message });
      } else {
        // Not running inside Tauri (plain browser dev).
        set({ schedules: [], runs: {}, loaded: true, loadError: null });
      }
    }
  },

  save: async (schedule) => {
    const stored = await scheduleSave(schedule);
    set((state) => ({
      schedules: state.schedules.some((s) => s.id === stored.id)
        ? state.schedules.map((s) => (s.id === stored.id ? stored : s))
        : [...state.schedules, stored],
      loaded: true,
      loadError: null,
    }));
    return stored;
  },

  remove: async (id) => {
    await scheduleDelete(id);
    set((state) => {
      const runs = { ...state.runs };
      delete runs[id];
      return { schedules: state.schedules.filter((s) => s.id !== id), runs };
    });
  },

  setEnabled: async (id, enabled) => {
    const stored = await scheduleSetEnabled(id, enabled);
    set((state) => ({
      schedules: state.schedules.map((s) => (s.id === stored.id ? stored : s)),
    }));
  },

  runNow: async (id) => {
    // Optimistic, to cover the gap before the backend's start event arrives;
    // `applyRun` is what clears it, so this does NOT unset in a `finally`.
    // Doing so would race the event pair and blank the spinner of a SCHEDULED
    // run that began while this manual one was in flight.
    set({ runningId: id });
    // The record also arrives via the run-finished event, which `applyRun`
    // folds in — so nothing is appended here. Returning it lets the caller
    // toast the outcome.
    return await scheduleRunNow(id);
  },

  markRunning: (scheduleId) => set({ runningId: scheduleId }),

  applyRun: (record) => {
    set((state) => ({
      runs: {
        ...state.runs,
        [record.scheduleId]: [...(state.runs[record.scheduleId] ?? []), record].slice(-MAX_HISTORY),
      },
      // Only if this is the run we were showing: a stale finish must not clear
      // the spinner of whatever started after it.
      runningId: state.runningId === record.scheduleId ? null : state.runningId,
    }));
    // The scheduler advanced `nextRunAt` on disk when it fired this run, so
    // the list's "Next" column is now a time in the past. Re-read rather than
    // recompute it here: the recurrence math lives in Rust, and duplicating it
    // to patch one label is exactly the kind of second implementation this
    // feature went out of its way to avoid everywhere else.
    void useSchedulesStore.getState().load();
  },
}));

/** The most recent run of a schedule, or undefined when it has never run. */
export function lastRun(runs: RunHistory, scheduleId: string): RunRecord | undefined {
  const history = runs[scheduleId];
  return history && history.length > 0 ? history[history.length - 1] : undefined;
}

/**
 * A schedule's history newest FIRST — the order the detail panel reads in,
 * where the backend stores it newest last.
 */
export function historyNewestFirst(runs: RunHistory, scheduleId: string): RunRecord[] {
  return [...(runs[scheduleId] ?? [])].reverse();
}
