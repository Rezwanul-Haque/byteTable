// Status-bar resource chip (M33): ByteTable's own CPU and resident memory.
// Shared by all six workspace status bars (SQL, Redis, DynamoDB, MongoDB,
// Cassandra, Typesense) so the reading is in the same place whatever engine
// the user is looking at.
//
// Deliberately quiet: it sits with the other `status-dim` items, renders
// nothing until the first sample lands, and never shows an error — an ambient
// number is not worth interrupting anyone over.

import { Icon } from "../../shared/ui/Icon";
import { fmtBytes, fmtCpu, metricsTitle } from "./api";
import { useAppMetrics } from "./useAppMetrics";
import "./ResourceMeter.css";

/** `className` is the host bar's dim class — the DynamoDB bar styles its own
 *  `.ddb-status-dim` rather than the shared `.status-dim`, exactly like
 *  `BuiltByCredit` takes it. */
export function ResourceMeter({ className = "status-dim" }: { className?: string }) {
  const metrics = useAppMetrics();
  if (!metrics) return null;

  return (
    <span
      className={className + " status-metrics" + (metrics.webviewAttributed ? "" : " partial")}
      title={metricsTitle(metrics)}
    >
      {/* One icon per value: `memory` is the Material Symbols processor chip
          and `memory_alt` the RAM module, so each number says what it measures
          without spending bar width on the words "CPU" and "RAM" (which would
          also be the only untranslated English labels in a bar that has none).
          Grouping each icon with its value — rather than one gap throughout —
          is what makes the pairing read; see the CSS. */}
      <span className="status-metric">
        <Icon name="memory" size={13} />
        {fmtCpu(metrics)}
      </span>
      <span className="status-metric">
        <Icon name="memory_alt" size={13} />
        {fmtBytes(metrics.memoryRssBytes)}
      </span>
    </span>
  );
}
