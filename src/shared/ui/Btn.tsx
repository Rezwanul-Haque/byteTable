// Button — ported from ui.jsx Btn (variants filled/tonal/text + small flag).

import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

import { Icon } from "./Icon";
import "./Btn.css";

export type BtnVariant = "filled" | "tonal" | "text";

interface BtnProps {
  children?: ReactNode;
  icon?: string;
  variant?: BtnVariant;
  small?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  title?: string;
  style?: CSSProperties;
}

export function Btn({
  children,
  icon,
  variant = "tonal",
  small,
  onClick,
  disabled,
  title,
  style,
}: BtnProps) {
  return (
    <button
      className={"btn btn-" + variant + (small ? " btn-small" : "")}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={style}
    >
      {icon ? <Icon name={icon} size={small ? 15 : 17} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}
