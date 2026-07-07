// bt:cmd — a tiny global command bus for the window title-bar app menu.
//
// The title bar is deliberately decoupled from whichever engine surface is
// active: menu items that operate on the current workspace/query tab do NOT
// reach into it directly. Instead they `emitCmd(id)`, which dispatches a
// `bt:cmd` CustomEvent on `window`; whatever surface owns that command claims
// it with `useBtCmd(id, handler)`. When no surface is mounted to handle a
// command, the emit is simply a no-op — which is why the menu greys items that
// have no backing rather than emitting into the void (see buildMenus).
//
// App-level actions (About, Check for Updates, Settings, New Connection, …) do
// NOT go through this bus — they are passed into the title bar as `ctx.*`
// callbacks from App.tsx, which owns that modal state.

import { useEffect, useRef } from "react";

/** Commands routed through the bus to the active workspace / query tab. */
export type BtCmdId =
  | "new-query"
  | "open-sql-file"
  | "palette"
  | "toggle-terminal"
  | "schema-map"
  | "run"
  | "format"
  | "explain"
  | "save-query"
  | "query-history";

const EVENT = "bt:cmd";

interface BtCmdDetail {
  id: BtCmdId;
}

/** Fire a command onto the bus. No-op if nothing is listening for `id`. */
export function emitCmd(id: BtCmdId): void {
  window.dispatchEvent(new CustomEvent<BtCmdDetail>(EVENT, { detail: { id } }));
}

/**
 * Claim a bus command for as long as the calling component is mounted. The
 * handler is kept in a ref-free closure re-bound each render, so it always
 * sees fresh props/state without re-subscribing churn being observable to the
 * caller. Multiple surfaces may listen for the same id; each gets the event
 * (the menu only enables an item when a real owner is expected to be mounted).
 */
export function useBtCmd(id: BtCmdId, handler: () => void): void {
  // Keep the latest handler in a ref so we subscribe once per id and never
  // re-bind on every render — callers don't need to memoize their closure.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    const onCmd = (event: Event) => {
      const detail = (event as CustomEvent<BtCmdDetail>).detail;
      if (detail?.id === id) handlerRef.current();
    };
    window.addEventListener(EVENT, onCmd);
    return () => window.removeEventListener(EVENT, onCmd);
  }, [id]);
}
