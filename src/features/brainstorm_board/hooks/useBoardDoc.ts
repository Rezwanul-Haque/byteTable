// The board document, its undo stack and its persistence (M37 Tasks 1 + 10).
//
// ============================== HISTORY ==============================
//
// One drag must be ONE undo step. The host therefore calls `snapshot()` once as
// a gesture begins and then applies every frame with `withHistory: false`;
// field edits in the inspector use the default and get their own step. Live
// typing that would otherwise push per keystroke (an edge label, a group name)
// also applies without history and commits on blur.
//
// The stacks live in a ref, not in state: pushing a snapshot must not re-render
// the canvas mid-drag. `canUndo` / `canRedo` ARE state, because the zoom bar's
// buttons have to enable the moment a gesture starts — before any document
// change has re-rendered anything.
//
// The push is idempotent against the previous entry. React double-invokes state
// updaters in development StrictMode, which would otherwise record every change
// twice and make ⌘Z need two presses.

import { useCallback, useEffect, useRef, useState } from "react";

import type { BoardDoc, LiveSourceId } from "../model";
import { saveBoard, SAVE_DEBOUNCE_MS } from "../persist";

/** Snapshots kept per direction. Eighty is far past a session's useful reach and
 *  bounds the memory a long drawing session can hold. */
const HISTORY_LIMIT = 80;

export interface BoardDocApi {
  doc: BoardDoc;
  /** Always the latest document, readable from a stale closure (the window-level
   *  pointer handlers and the keyboard effect both need this). */
  docRef: React.RefObject<BoardDoc>;
  /** Replace the document through a pure function. Records an undo entry unless
   *  `withHistory` is false. */
  apply: (fn: (doc: BoardDoc) => BoardDoc, withHistory?: boolean) => void;
  /** Record one undo entry for the current document, without changing it. */
  snapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Replace the document wholesale and clear nothing but the future (used by
   *  "Reset to sample", which stays undoable). */
  replace: (doc: BoardDoc) => void;
}

export function useBoardDoc(
  initialDoc: BoardDoc,
  connectionId: string,
  schema: string,
  liveSource: LiveSourceId,
): BoardDocApi {
  const [doc, setDoc] = useState<BoardDoc>(initialDoc);

  // Mirrored in an effect, not during render: every reader is an event handler
  // (the window-level pointer handlers, the keyboard effect, the inspector's
  // actions), all of which run after effects have flushed.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  const history = useRef<{ past: BoardDoc[]; future: BoardDoc[] }>({ past: [], future: [] });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const sync = useCallback(() => {
    setCanUndo(history.current.past.length > 0);
    setCanRedo(history.current.future.length > 0);
  }, []);

  /** Push `entry` as the newest undo step, dropping the oldest past the limit
   *  and discarding the redo future. No-op when `entry` is already on top. */
  const pushPast = useCallback((entry: BoardDoc) => {
    const h = history.current;
    if (h.past[h.past.length - 1] === entry) return;
    h.past.push(entry);
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
    h.future = [];
  }, []);

  const apply = useCallback(
    (fn: (doc: BoardDoc) => BoardDoc, withHistory = true) => {
      setDoc((prev) => {
        const next = fn(prev);
        if (next === prev) return prev;
        if (withHistory) pushPast(prev);
        return next;
      });
      if (withHistory) sync();
    },
    [pushPast, sync],
  );

  const snapshot = useCallback(() => {
    pushPast(docRef.current);
    sync();
  }, [pushPast, sync]);

  const undo = useCallback(() => {
    const h = history.current;
    const previous = h.past.pop();
    if (!previous) return;
    h.future.push(docRef.current);
    setDoc(previous);
    sync();
  }, [sync]);

  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    h.past.push(docRef.current);
    setDoc(next);
    sync();
  }, [sync]);

  const replace = useCallback(
    (next: BoardDoc) => {
      pushPast(docRef.current);
      setDoc(next);
      sync();
    },
    [pushPast, sync],
  );

  // Persist debounced, so a drag or a burst of typing writes once. The chosen
  // comparison source rides along: reopening the tab should restore what the
  // board was being diffed against, not reset to the sample.
  useEffect(() => {
    const timer = setTimeout(() => {
      saveBoard(connectionId, schema, { ...doc, liveSource });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [doc, liveSource, connectionId, schema]);

  return { doc, docRef, apply, snapshot, undo, redo, canUndo, canRedo, replace };
}
