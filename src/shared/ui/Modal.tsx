// Modal — scrim + centered panel per the prototype (connect.jsx modals).
// Closes on Esc and on scrim click (clicks inside the panel don't bubble
// as scrim clicks because we compare against currentTarget).

import { useEffect, type ReactNode } from "react";

import "./Modal.css";

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  /** Override the default 480px panel width. */
  width?: number;
}

export function Modal({ children, onClose, width }: ModalProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width } : undefined}>
        {children}
      </div>
    </div>
  );
}
