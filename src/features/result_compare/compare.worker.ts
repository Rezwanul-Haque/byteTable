// Runs the comparison off the main thread, for results above OFF_THREAD_ROWS
// (task F4). Same `diff` the main thread runs; progress is posted as it goes.

import { diff, type Diff, type Side } from "./compareModel";

export interface DiffRequest {
  id: number;
  a: Side;
  b: Side;
  key: string[];
  ordered: boolean;
}

export type DiffReply = { id: number; progress: number } | { id: number; data: Diff };

self.onmessage = (e: MessageEvent<DiffRequest>) => {
  const { id, a, b, key, ordered } = e.data;
  const post = (m: DiffReply) => (self as unknown as Worker).postMessage(m);
  const data = diff(a, b, { key, ordered, onProgress: (progress) => post({ id, progress }) });
  post({ id, data });
};
