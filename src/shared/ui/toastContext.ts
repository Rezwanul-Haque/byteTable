// Toast context + hook — split from ToastProvider.tsx so component files
// export only components (react-refresh).

import { createContext, useContext } from "react";

export type ToastKind = "ok" | "err" | "info";

/** One button on a toast — "View in history" after a write (M48). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Show a toast. With `action`, it carries one button and stays 7s, not 3.2s:
 *  long enough to reach the button. */
export type ToastFn = (msg: string, kind?: ToastKind, action?: ToastAction) => void;

export const ToastContext = createContext<ToastFn | null>(null);

export function useToast(): ToastFn {
  const toast = useContext(ToastContext);
  if (!toast) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return toast;
}
