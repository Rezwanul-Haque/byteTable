// The comparison of two results: run in render for ordinary results, in a
// worker above OFF_THREAD_ROWS so 100,000 rows a side never freeze the UI
// (task F4). While the worker works, `diff` is null and `progress` says how
// far it got (0–1).

import { useEffect, useMemo, useRef, useState } from "react";

import { diff, OFF_THREAD_ROWS, type Diff, type Side } from "../compareModel";
import type { DiffReply, DiffRequest } from "../compare.worker";

export function useCompareDiff(
  sides: { a: Side; b: Side } | null,
  key: string[],
  ordered: boolean,
): { diff: Diff | null; progress: number | null } {
  const offThread = sides !== null && sides.a.rows.length + sides.b.rows.length > OFF_THREAD_ROWS;
  const keyId = key.join("\u0001");

  const inline = useMemo(
    () => (sides && !offThread ? diff(sides.a, sides.b, { key, ordered }) : null),
    // `keyId` stands for `key`, whose identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sides, offThread, keyId, ordered],
  );

  const [built, setBuilt] = useState<{ id: number; data: Diff } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const reqId = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => {
    if (!sides || !offThread) return;
    const worker =
      workerRef.current ??
      new Worker(new URL("../compare.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const id = ++reqId.current;
    setBuilt(null);
    setProgress(0);
    worker.onmessage = (e: MessageEvent<DiffReply>) => {
      // A newer request supersedes an older one still in flight.
      if (e.data.id !== reqId.current) return;
      if ("data" in e.data) {
        setBuilt({ id: e.data.id, data: e.data.data });
        setProgress(null);
      } else setProgress(e.data.progress);
    };
    const req: DiffRequest = { id, a: sides.a, b: sides.b, key, ordered };
    worker.postMessage(req);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sides, offThread, keyId, ordered]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  if (!offThread) return { diff: inline, progress: null };
  return { diff: built?.id === reqId.current ? built.data : null, progress };
}
