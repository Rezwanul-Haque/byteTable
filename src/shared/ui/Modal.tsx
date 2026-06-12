// Modal — scrim + centered panel per the prototype (connect.jsx modals).
// Scrim-close tracks where the mousedown originated, so a drag that starts
// inside the panel and is released over the scrim does NOT dismiss — only a
// press-and-release both on the scrim closes. Esc closes only the top-most
// modal (module-level stack registry: push on mount, pop on unmount).

// TODO(a11y): focus trap + restore before first production dialog (M1 donate modal)

import { useEffect, useId, useRef, type ReactNode } from "react";

import "./Modal.css";

/** Stack of currently mounted modals; the last entry is the top-most one. */
const modalStack: symbol[] = [];

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  /** Accessible name for the dialog, wired to aria-labelledby on the panel. */
  label?: string;
  /** Override the default 480px panel width. */
  width?: number;
}

export function Modal({ children, onClose, label, width }: ModalProps) {
  const stackToken = useRef(Symbol("modal"));
  const mouseDownOnScrim = useRef(false);
  const labelId = useId();

  useEffect(() => {
    const token = stackToken.current;
    modalStack.push(token);
    return () => {
      const index = modalStack.indexOf(token);
      if (index !== -1) modalStack.splice(index, 1);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalStack[modalStack.length - 1] === stackToken.current) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        mouseDownOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && mouseDownOnScrim.current) onClose();
        mouseDownOnScrim.current = false;
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={label ? labelId : undefined}
        style={width ? { width } : undefined}
      >
        {label ? (
          <span id={labelId} className="modal-sr-label">
            {label}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function ModalTitle({ children }: { children: ReactNode }) {
  return <div className="modal-title">{children}</div>;
}

export function ModalActions({ children }: { children: ReactNode }) {
  return <div className="modal-actions">{children}</div>;
}
