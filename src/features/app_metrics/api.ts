// App metrics feature (M33) — backend wrapper + the status-bar formatters.
//
// `appMetricsRead` invokes the Rust `app_metrics_read` command (see
// `src-tauri/src/features/app_metrics`). This is ByteTable's own CPU and
// memory, not the connected server's — the Processes tab covers that.

import { invoke } from "@tauri-apps/api/core";

/** One sample of ByteTable's own resource use (mirrors Rust `AppMetrics`). */
export interface AppMetrics {
  /** Summed across our processes, in "percent of one core" — can exceed 100. */
  cpuPercentOfCore: number;
  cpuCoreCount: number;
  /** Resident set size in bytes. Not macOS Activity Monitor's "Memory". */
  memoryRssBytes: number;
  processCount: number;
  /** False when the webview's process could not be attributed (macOS). */
  webviewAttributed: boolean;
}

/** Sample ByteTable's own CPU + resident memory. */
export function appMetricsRead(): Promise<AppMetrics> {
  return invoke<AppMetrics>("app_metrics_read");
}

/**
 * CPU as a share of the whole machine, which is what a footer reading wants:
 * "3%" is meaningful at a glance, "45% of one core on a 15-core box" is not.
 * The per-core number stays available in the tooltip for anyone comparing
 * against Activity Monitor / Task Manager, which both report per-core.
 */
export function cpuPercentOfMachine(m: AppMetrics): number {
  if (m.cpuCoreCount <= 0) return m.cpuPercentOfCore;
  return m.cpuPercentOfCore / m.cpuCoreCount;
}

/** CPU for the bar: whole numbers, and `<1%` rather than a misleading `0%`. */
export function fmtCpu(m: AppMetrics): string {
  const pct = cpuPercentOfMachine(m);
  if (pct > 0 && pct < 1) return "<1%";
  return Math.round(pct) + "%";
}

/** Bytes as MB/GB. MB up to 1024, then GB with one decimal — the footer is
 *  11px and fixed-height, so the string must stay short and never wrap. */
export function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return Math.round(mb) + " MB";
  return (mb / 1024).toFixed(1) + " GB";
}

/**
 * The tooltip. Says plainly what the numbers do and do not cover — on macOS the
 * webview runs in an XPC process owned by launchd, so the reading is the main
 * process only and is expected to sit well under what Activity Monitor shows.
 * Better to state that than to let it read as a bug.
 */
export function metricsTitle(m: AppMetrics): string {
  const scope = m.webviewAttributed
    ? "ByteTable across " + m.processCount + " processes (app + webview)"
    : "ByteTable's main process only — the webview runs separately and is not counted";
  return (
    scope +
    "\nCPU " +
    m.cpuPercentOfCore.toFixed(1) +
    "% of one core · " +
    m.cpuCoreCount +
    " cores" +
    "\nResident memory " +
    fmtBytes(m.memoryRssBytes)
  );
}
