// Toast system — ported from ui.jsx useToasts/Toasts (spec §3.11): bottom-right
// stack, --bg3 card r10 mono 11.5, icon tinted by kind, slide-up 180ms,
// auto-dismiss 3.2s.

import { useCallback, useState, type ReactNode } from "react";

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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((msg: string, kind: ToastKind = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts">
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
