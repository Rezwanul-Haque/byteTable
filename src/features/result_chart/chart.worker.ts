// Builds a chart's series off the main thread, for results above
// OFF_THREAD_ROWS (task A5). Same `series` the main thread runs; only the
// translated labels arrive as data, since functions cannot be posted.

import type { CellValue } from "../../shared/api/engine";
import { series, type ChartCfg, type ColKind } from "./chartModel";

export interface SeriesRequest {
  id: number;
  rows: CellValue[][];
  cfg: ChartCfg;
  xKind: ColKind | undefined;
  /** "row {n}", translated. */
  rowLabel: string;
  countName: string;
  colNames: string[];
}

self.onmessage = (e: MessageEvent<SeriesRequest>) => {
  const { id, rows, cfg, xKind, rowLabel, countName, colNames } = e.data;
  const data = series(rows, cfg, xKind, {
    rowLabel: (n) => rowLabel.replace("{n}", String(n)),
    countName,
    colName: (i) => colNames[i] ?? "",
  });
  (self as unknown as Worker).postMessage({ id, data });
};
