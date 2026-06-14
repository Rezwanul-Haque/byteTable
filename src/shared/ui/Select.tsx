// Custom dropdown — a button + popover list that replaces the native <select>.
//
// WHY: the native <select> renders through the OS widget (GTK on Linux /
// WebKitGTK), which ignores the dark theme (washed-out field), drops our CSS
// chevron, and opens a janky native popup. This component is plain DOM we fully
// control, so it looks + behaves identically on macOS / Linux / Windows. Models
// the sidebar schema-switcher pattern (trigger button + absolutely-positioned
// popover inside a relative wrapper) and is keyboard- + a11y-complete
// (listbox/option roles, arrow/Home/End/Enter/Escape, focus return).

import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";
import "./Select.css";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** Applied to the wrapper — width/max-width/variant hooks (e.g. `sel-block`). */
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  title?: string;
  disabled?: boolean;
  /** Monospace trigger label (default true — matches the data-style selects). */
  mono?: boolean;
  /** Open the popover above the trigger (use near the window's bottom edge). */
  placement?: "down" | "up";
  /** Open immediately on mount (inline-editor use, e.g. structure type edit). */
  autoOpen?: boolean;
  /** Called whenever the popover closes (Escape / outside-click / after a pick).
   *  Inline editors map this to "exit edit mode". */
  onClose?: () => void;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  className,
  title,
  disabled,
  mono = true,
  placement = "down",
  autoOpen = false,
  onClose,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SelectProps<T>) {
  const [open, setOpen] = useState(autoOpen);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Keep the latest onClose without making the close effect depend on it.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const current = options[selectedIndex];

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
    onCloseRef.current?.();
  };

  // Outside mousedown / Escape / window blur close the popover (schema-switcher
  // pattern). Active only while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onBlur = () => close(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus the selected option when the popover opens (keyboard users land on
  // the current value).
  useEffect(() => {
    if (open) optRefs.current[selectedIndex]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (v: T) => {
    onChange(v);
    close(true);
  };

  const onOptKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      optRefs.current[Math.min(options.length - 1, index + 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      optRefs.current[Math.max(0, index - 1)]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      optRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      optRefs.current[options.length - 1]?.focus();
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className={"sel-wrap" + (className ? " " + className : "")} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={"sel-trigger" + (mono ? " sel-mono" : "")}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
      >
        <span className="sel-label">{current?.label ?? value}</span>
        <Icon name="expand_more" size={15} className="sel-chevron" />
      </button>
      {open ? (
        <div
          className={"sel-pop" + (placement === "up" ? " up" : "")}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
        >
          {options.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => {
                optRefs.current[i] = el;
              }}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={"sel-opt" + (o.value === value ? " active" : "")}
              onClick={() => choose(o.value)}
              onKeyDown={(e) => onOptKeyDown(e, i)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
