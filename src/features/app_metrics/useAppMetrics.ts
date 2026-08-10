// Status-bar resource poller (M33). One interval for the whole app, shared by
// every subscriber through a module-level refcount rather than a per-component
// `setInterval` — App.tsx mounts a single workspace shell today, but each of the
// six shells has its own status bar and a per-bar timer would multiply the
// sampling cost for no extra information.
//
// The poll is paused whenever the window is hidden. That is not a micro-
// optimization here: ByteTable closes to the tray rather than quitting
// (see lib.rs `CloseRequested`), so an unguarded timer would keep waking the
// machine to measure an app nobody is looking at — the exact cost the readout
// exists to help users notice.

import { useEffect, useState } from "react";

import { appMetricsRead, type AppMetrics } from "./api";

/** Slow enough to be cheap, fast enough that a spike is still visible. */
const POLL_MS = 2000;

let timer: ReturnType<typeof setInterval> | null = null;
let subscribers = 0;
let latest: AppMetrics | null = null;
const listeners = new Set<(m: AppMetrics | null) => void>();

/** True while the window is on screen; `document.hidden` covers both the
 *  close-to-tray hide and an ordinary minimize. */
function visible(): boolean {
  return typeof document === "undefined" || !document.hidden;
}

async function sample(): Promise<void> {
  if (!visible()) return;
  try {
    latest = await appMetricsRead();
  } catch {
    // A failed sample is not worth surfacing: the number is ambient, and an
    // error toast for it would be noise on top of whatever actually broke.
    // Null hides the chip rather than freezing a stale reading on screen.
    latest = null;
  }
  for (const listener of listeners) listener(latest);
}

function start(): void {
  if (timer !== null) return;
  void sample();
  timer = setInterval(() => void sample(), POLL_MS);
}

function stop(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/** Resume/suspend with the window, so a tray-hidden app polls nothing. */
function onVisibilityChange(): void {
  if (subscribers === 0) return;
  if (visible()) start();
  else stop();
}

/**
 * ByteTable's own CPU + resident memory, resampled every couple of seconds
 * while the window is visible. Null until the first sample lands (and again if
 * sampling fails), which callers render as "nothing" rather than as a zero.
 */
export function useAppMetrics(): AppMetrics | null {
  const [metrics, setMetrics] = useState<AppMetrics | null>(latest);

  useEffect(() => {
    listeners.add(setMetrics);
    subscribers += 1;
    if (subscribers === 1) {
      document.addEventListener("visibilitychange", onVisibilityChange);
      if (visible()) start();
    }
    return () => {
      listeners.delete(setMetrics);
      subscribers -= 1;
      if (subscribers === 0) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        stop();
      }
    };
  }, []);

  return metrics;
}
