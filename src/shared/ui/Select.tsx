// Custom dropdown — a button + popover list that replaces the native <select>.
//
// WHY: the native <select> renders through the OS widget (GTK on Linux /
// WebKitGTK), which ignores the dark theme (washed-out field), drops our CSS
// chevron, and opens a janky native popup. This component is plain DOM we fully
// control, so it looks + behaves identically on macOS / Linux / Windows. Models
// the sidebar schema-switcher pattern (trigger button + absolutely-positioned
// popover inside a relative wrapper) and is keyboard- + a11y-complete
// (listbox/option roles, arrow/Home/End/Enter/Escape, focus return).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  /** Editable combobox: the trigger is a text input, the popover shows matching
   *  suggestions, and any typed value commits (Enter / blur / outside-click).
   *  Use for open-ended fields like a column type — pick `VARCHAR(255)` or type
   *  `VARCHAR(20)` / `DECIMAL(4,6)`. Escape cancels without committing. */
  editable?: boolean;
  /** Placeholder for the editable input. */
  placeholder?: string;
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
  editable = false,
  placeholder,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SelectProps<T>) {
  const [open, setOpen] = useState(autoOpen);
  const [text, setText] = useState<string>(value);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Refs so the outside-click / blur handlers (bound on open) read the latest
  // typed text + callbacks without re-binding on every keystroke.
  const textRef = useRef(text);
  textRef.current = text;
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Keep the editable input mirrored to `value` while closed (external changes,
  // exit edit mode). While open the user's typing is authoritative.
  useEffect(() => {
    if (!open) setText(value);
  }, [value, open]);

  // The suggestions shown in the popover: all options when picking, else the
  // options whose label matches the typed text (substring, case-insensitive).
  const q = text.trim().toLowerCase();
  const shown = editable ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  const commitText = () => {
    const t = textRef.current.trim();
    if (t && t !== valueRef.current) onChangeRef.current(t as T);
  };
  // The popover is portaled to <body> with fixed positioning so it escapes any
  // ancestor `overflow:hidden/auto` (scroll containers, modals). `pos` is the
  // measured trigger rect; recomputed on open + on scroll/resize.
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    bottom: number;
    width: number;
  } | null>(null);
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

  // Measure the trigger so the portaled popover can be placed against it; keep
  // it aligned as the page scrolls/resizes while open.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current ?? wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom, bottom: r.top, width: r.width });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // Outside mousedown / Escape / window blur close the popover (schema-switcher
  // pattern). Active only while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !popRef.current?.contains(t)) {
        if (editable) commitText();
        close(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Escape cancels an editable edit (no commit); a pick-only select just
        // closes.
        e.preventDefault();
        close(true);
      }
    };
    const onBlur = () => {
      if (editable) commitText();
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
    // Bind once per open/close: `commitText` reads the latest via refs and
    // `editable` is stable for the component's life — re-binding every render
    // would needlessly re-add the listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // On open: an editable combobox focuses its input (and selects the text so a
  // quick retype replaces it); a pick-only select focuses the current option.
  useEffect(() => {
    if (!open) return;
    if (editable) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      optRefs.current[selectedIndex]?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (v: T) => {
    onChange(v);
    close(true);
  };

  const onOptKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      optRefs.current[Math.min(shown.length - 1, index + 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      // From the first option, an editable combobox returns to its input.
      if (index === 0 && editable) inputRef.current?.focus();
      else optRefs.current[Math.max(0, index - 1)]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      optRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      optRefs.current[shown.length - 1]?.focus();
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      optRefs.current[0]?.focus();
    } else if (e.key === "Enter") {
      // Commit the typed value verbatim (free-form types like VARCHAR(20)).
      e.preventDefault();
      commitText();
      close(true);
    }
    // Escape is handled by the document keydown listener (cancel).
  };

  return (
    <div className={"sel-wrap" + (className ? " " + className : "")} ref={wrapRef}>
      {editable ? (
        <div className="sel-trigger sel-editable">
          <input
            ref={inputRef}
            type="text"
            className={"sel-input" + (mono ? " sel-mono" : "")}
            value={text}
            placeholder={placeholder}
            disabled={disabled}
            title={title}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            onChange={(e) => {
              setText(e.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => !disabled && setOpen(true)}
            onKeyDown={onInputKeyDown}
          />
          <Icon name="expand_more" size={15} className="sel-chevron" />
        </div>
      ) : (
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
      )}
      {open && pos && shown.length > 0
        ? createPortal(
            <div
              ref={popRef}
              className={"sel-pop sel-pop-fixed" + (placement === "up" ? " up" : "")}
              role="listbox"
              aria-label={ariaLabel}
              aria-labelledby={ariaLabelledBy}
              style={{
                left: pos.left,
                minWidth: pos.width,
                ...(placement === "up"
                  ? {
                      bottom: window.innerHeight - pos.bottom + 4,
                      maxHeight: Math.max(100, pos.bottom - 16),
                    }
                  : {
                      top: pos.top + 4,
                      maxHeight: Math.max(100, window.innerHeight - pos.top - 16),
                    }),
              }}
            >
              {shown.map((o, i) => (
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
