// Toast context + hook — split from ToastProvider.tsx so component files
// export only components (react-refresh).

import { createContext, useContext } from "react";

export type ToastKind = "ok" | "err" | "info";

export type ToastFn = (msg: string, kind?: ToastKind) => void;

export const ToastContext = createContext<ToastFn | null>(null);

export function useToast(): ToastFn {
  const toast = useContext(ToastContext);
  if (!toast) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return toast;
}
