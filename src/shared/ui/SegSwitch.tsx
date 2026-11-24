// A small two-or-more-option switch (`.ch-switch`, from the prototype's chart
// styles): Table / Chart on a result bar, Notebook / File in a notebook header.
// A real radio group — one tab stop, arrow keys move the choice.

import { useRef, type KeyboardEvent } from "react";

import { Icon } from "./Icon";
import "./SegSwitch.css";

export interface SegOption<V extends string> {
  value: V;
  label: string;
  icon?: string;
  title?: string;
}

export function SegSwitch<V extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly SegOption<V>[];
  value: V;
  onChange: (value: V) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const at = options.findIndex((o) => o.value === value);
    const next = options[(at + step + options.length) % options.length]!;
    onChange(next.value);
    ref.current?.querySelectorAll<HTMLButtonElement>("button")[options.indexOf(next)]?.focus();
  };
  return (
    <div className="ch-switch" role="radiogroup" aria-label={ariaLabel} ref={ref} onKeyDown={onKey}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={on ? "on" : ""}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.icon ? <Icon name={o.icon} size={13} /> : null} {o.label}
          </button>
        );
      })}
    </div>
  );
}
