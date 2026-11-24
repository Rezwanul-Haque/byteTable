// A chart's series: built in render for an ordinary result, in a worker above
// OFF_THREAD_ROWS so switching to Chart on a huge result never freezes the UI
// (task A5). Returns null while the worker is preparing it.

import { useEffect, useMemo, useRef, useState } from "react";

import type { CellValue } from "../../../shared/api/engine";
import {
  OFF_THREAD_ROWS,
  series,
  type ChartCfg,
  type ChartSeries,
  type ColKind,
} from "../chartModel";
import type { SeriesRequest } from "../chart.worker";

export function useChartSeries(
  rows: CellValue[][],
  cfg: ChartCfg,
  xKind: ColKind | undefined,
  rowLabel: string,
  countName: string,
  colNames: string[],
): ChartSeries | null {
  const offThread = rows.length > OFF_THREAD_ROWS;
  const key = `${cfg.type}|${cfg.x}|${cfg.ys.join(",")}|${cfg.count}|${cfg.agg}|${cfg.sort}|${xKind}`;

  const inline = useMemo(
    () =>
      offThread
        ? null
        : series(rows, cfg, xKind, {
            rowLabel: (n) => rowLabel.replace("{n}", String(n)),
            countName,
            colName: (i) => colNames[i] ?? "",
          }),
    // `key` stands for `cfg`, whose identity changes on every settings edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [offThread, rows, key, rowLabel, countName, colNames],
  );

  const [built, setBuilt] = useState<{ id: number; data: ChartSeries } | null>(null);
  const reqId = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => {
    if (!offThread) return;
    const worker =
      workerRef.current ??
      new Worker(new URL("../chart.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const id = ++reqId.current;
    setBuilt(null);
    worker.onmessage = (e: MessageEvent<{ id: number; data: ChartSeries }>) => {
      // A newer request supersedes an older one still in flight.
      if (e.data.id === reqId.current) setBuilt(e.data);
    };
    const req: SeriesRequest = { id, rows, cfg, xKind, rowLabel, countName, colNames };
    worker.postMessage(req);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offThread, rows, key, rowLabel, countName, colNames]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  return offThread ? (built?.data ?? null) : inline;
}
