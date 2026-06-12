// Icon button — ported from ui.jsx IconBtn. Minimum 26×26 hit target (§1.5).
// Renders type="button" by default (overridable) and forwards all native
// button props + ref. Falls back to title for aria-label when none is given.

import { forwardRef, type ButtonHTMLAttributes } from "react";

import { Icon } from "./Icon";
import "./IconBtn.css";

interface IconBtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  size?: number;
  active?: boolean;
  danger?: boolean;
}

export const IconBtn = forwardRef<HTMLButtonElement, IconBtnProps>(function IconBtn(
  {
    icon,
    size = 18,
    active,
    danger,
    className,
    type = "button",
    title,
    "aria-label": ariaLabel,
    ...rest
  },
  ref,
) {
  const classes =
    "icon-btn" +
    (active ? " active" : "") +
    (danger ? " danger" : "") +
    (className ? " " + className : "");
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      title={title}
      aria-label={ariaLabel ?? title}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
});
