// Toast system — ported from ui.jsx useToasts/Toasts (spec §3.11): bottom-right
// stack, --bg3 card r10 mono 11.5, icon tinted by kind, slide-up 180ms,
// auto-dismiss 3.2s. Dismiss timers are retained and cleared on unmount.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Icon } from "./Icon";
import { ToastContext, type ToastKind } from "./toastContext";
import "./Toast.css";

interface ToastItem {
  id: string;
  msg: string;
  kind: ToastKind;
}

const TOAST_ICONS: Record<ToastKind, string> = {
  ok: "check_circle",
  err: "error",
  info: "info",
};

/** Monotonic id source — stable and collision-free, unlike Math.random. */
let toastSeq = 0;

/** Gap between the toast stack and whatever is under it. */
const TOAST_GAP = 12;

/**
 * Bars the stack must never cover, because a toast usually talks ABOUT them:
 * the data grid's save bar ("Save · ⌘S") and the structure view's pending bar
 * ("Apply changes"). Both sit directly above the status bar — exactly where a
 * bottom-right toast lands.
 */
const BOTTOM_BAR = ".save-bar, .pending-bar";

/**
 * How far off the bottom of the window the stack should sit right now.
 *
 * MEASURED, not a constant: the pending bar's height varies a lot (an inline
 * error row, or the expanded "Review SQL" panel, can double it), so any fixed
 * offset is wrong half the time — a first attempt at this used a hard-coded
 * 84px and still clipped the Save button. Falls back to the CSS default (the
 * status-bar clearance) when no bar is mounted.
 */
function bottomOffset(): string | null {
  const bar = document.querySelector<HTMLElement>(BOTTOM_BAR);
  if (!bar) return null;
  const rect = bar.getBoundingClientRect();
  // Distance from the window's bottom edge to the TOP of the bar, plus a gap.
  return window.innerHeight - rect.top + TOAST_GAP + "px";
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const stackRef = useRef<HTMLDivElement>(null);

  // Re-measure whenever the stack gains or loses a toast — the only moments the
  // offset can matter — so there is no observer watching the whole document for
  // a bar that is usually absent.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const offset = bottomOffset();
    if (offset) stack.style.bottom = offset;
    else stack.style.removeProperty("bottom");
  }, [toasts.length]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const toast = useCallback((msg: string, kind: ToastKind = "info") => {
    const id = "toast-" + ++toastSeq;
    setToasts((t) => [...t, { id, msg, kind }]);
    const timer = setTimeout(() => {
      timers.current.delete(id);
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3200);
    timers.current.set(id, timer);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts" ref={stackRef} role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={"toast toast-" + t.kind}>
            <Icon name={TOAST_ICONS[t.kind]} size={16} />
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
