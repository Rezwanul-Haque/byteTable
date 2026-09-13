// Checkbox — the data grid's drawn checkbox (`.dg-check`) as a component, so
// dialogs stop falling back to the platform control. On Linux the native box
// renders far larger than the layout allows and ignores the app's palette,
// which is what broke the truncate/drop confirms; this one is `appearance:
// none` + a CSS tick, so it looks identical everywhere.
//
// Forwards every native input prop + ref. `indeterminate` is a prop here
// because the DOM only exposes it as a property, not an attribute.

import { forwardRef, useEffect, useRef, type InputHTMLAttributes } from "react";

import "./Checkbox.css";

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Draws the dash instead of the tick — a partial selection. */
  indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { indeterminate, className, ...rest },
  ref,
) {
  const inner = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inner.current) inner.current.indeterminate = !!indeterminate;
  }, [indeterminate]);

  return (
    <input
      type="checkbox"
      ref={(el) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      className={"bt-check" + (className ? " " + className : "")}
      {...rest}
    />
  );
});
