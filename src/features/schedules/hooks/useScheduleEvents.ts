// The schedules slice's app-wide subscription to the backend's run events.
//
// Mounted once at app level (App's ScheduleEventsBridge), NOT in the manager:
// the manager only exists while it is open, and a 3am run that fails a check
// has to reach the rail badge — and, when the window is focused, a toast —
// with the manager closed. The manager reads the same store, so it stays live
// for free.

import { useEffect } from "react";

import { useT } from "../../../shared/i18n/useT";
import { useToast } from "../../../shared/ui/toastContext";
import {
  ALERT_EVENT,
  RUN_FINISHED_EVENT,
  RUN_STARTED_EVENT,
  type RunRecord,
  type RunStarted,
  type ScheduleAlert,
} from "../api";
import { useSchedulesStore } from "../state";

export function useScheduleEvents(): void {
  const t = useT();
  const toast = useToast();
  const load = useSchedulesStore((s) => s.load);
  const applyRun = useSchedulesStore((s) => s.applyRun);
  const markRunning = useSchedulesStore((s) => s.markRunning);

  // The badge counts failing schedules from their history, so the history has
  // to be there before anyone opens the manager.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const disposers: (() => void)[] = [];
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await Promise.all([
          listen<RunStarted>(RUN_STARTED_EVENT, (event) => markRunning(event.payload.scheduleId)),
          listen<RunRecord>(RUN_FINISHED_EVENT, (event) => applyRun(event.payload)),
          listen<ScheduleAlert>(ALERT_EVENT, ({ payload }) => {
            // The backend raised an OS notification instead when the window
            // was not focused; toasting as well would say it twice.
            if (!document.hasFocus()) return;
            if (payload.alert.kind === "failing") {
              toast(
                t("sched.alert.failing", { name: payload.name, reason: payload.alert.reason }),
                "err",
              );
            } else {
              toast(t("sched.alert.recovered", { name: payload.name }), "ok");
            }
          }),
        ]);
        // Mounted and unmounted before the listeners attached: drop them now.
        if (cancelled) unlisten.forEach((off) => off());
        else disposers.push(...unlisten);
      } catch {
        // Plain browser dev — no Tauri, so no events.
      }
    })();
    return () => {
      cancelled = true;
      disposers.forEach((off) => off());
    };
  }, [applyRun, markRunning, t, toast]);
}
