// The Settings modal's row controls — a labelled row, an on/off switch and a
// segmented choice. Shared by every pane, including panes other slices own
// (the assistant's, M44), so they live in their own module.

import type { ReactNode } from "react";

export function SetRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <span>{label}</span>
        {hint ? <span className="set-row-hint">{hint}</span> : null}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

export function SetToggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={"set-switch" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="set-switch-knob" />
    </button>
  );
}

export function SetSeg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="set-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={"set-seg-btn" + (value === o.value ? " active" : "")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
