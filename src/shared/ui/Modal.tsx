// Modal — scrim + centered panel per the prototype (connect.jsx modals).
// Scrim-close tracks where the mousedown originated, so a drag that starts
// inside the panel and is released over the scrim does NOT dismiss — only a
// press-and-release both on the scrim closes. Esc closes only the top-most
// modal (module-level stack registry: push on mount, pop on unmount).
// Focus is trapped inside the top-most panel (Tab/Shift+Tab wrap) and
// restored to the previously focused element on unmount.

import { useEffect, useId, useRef, type ReactNode } from "react";

import "./Modal.css";

/** Stack of currently mounted modals; the last entry is the top-most one. */
const modalStack: symbol[] = [];

/** Tabbable-element query for the focus trap (sufficient for our dialogs). */
const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  /** Accessible name for the dialog, wired to aria-labelledby on the panel. */
  label?: string;
  /** Override the default 480px panel width. */
  width?: number;
  /** Extra class(es) on the panel, e.g. the prototype's "donate-modal". */
  className?: string;
}

export function Modal({ children, onClose, label, width, className }: ModalProps) {
  const stackToken = useRef(Symbol("modal"));
  const mouseDownOnScrim = useRef(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();

  useEffect(() => {
    const token = stackToken.current;
    modalStack.push(token);
    return () => {
      const index = modalStack.indexOf(token);
      if (index !== -1) modalStack.splice(index, 1);
    };
  }, []);

  // Initial focus + restore: move focus into the panel on mount (first
  // tabbable element, else the panel itself) and hand it back to whatever
  // was focused before — e.g. the rail's donate button — on unmount.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? panel)?.focus();
    return () => opener?.focus();
  }, []);

  // Esc + Tab handling for the top-most modal only. Tab wraps within the
  // panel; if focus escaped (e.g. a scrim click focused the body), the next
  // Tab pulls it back in.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== stackToken.current) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
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
        ref={panelRef}
        className={className ? "modal " + className : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={label ? labelId : undefined}
        tabIndex={-1}
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
