// Button — ported from ui.jsx Btn (variants filled/tonal/text + small flag).
// Renders type="button" by default (overridable) and forwards all native
// button props + ref.

import { forwardRef, type ButtonHTMLAttributes } from "react";

import { Icon } from "./Icon";
import "./Btn.css";

export type BtnVariant = "filled" | "tonal" | "text";

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: string;
  variant?: BtnVariant;
  small?: boolean;
}

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(function Btn(
  { children, icon, variant = "tonal", small, className, type = "button", ...rest },
  ref,
) {
  const classes =
    "btn btn-" + variant + (small ? " btn-small" : "") + (className ? " " + className : "");
  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {icon ? <Icon name={icon} size={small ? 15 : 17} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
});
