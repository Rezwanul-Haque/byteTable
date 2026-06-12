// Toast system — ported from ui.jsx useToasts/Toasts (spec §3.11): bottom-right
// stack, --bg3 card r10 mono 11.5, icon tinted by kind, slide-up 180ms,
// auto-dismiss 3.2s. Dismiss timers are retained and cleared on unmount.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

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
      <div className="toasts" role="status" aria-live="polite">
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
