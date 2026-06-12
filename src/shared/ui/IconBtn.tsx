// Icon button — ported from ui.jsx IconBtn. Minimum 26×26 hit target (§1.5).

import type { CSSProperties, MouseEventHandler } from "react";

import { Icon } from "./Icon";
import "./IconBtn.css";

interface IconBtnProps {
  icon: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  size?: number;
  active?: boolean;
  danger?: boolean;
  style?: CSSProperties;
}

export function IconBtn({ icon, onClick, title, size = 18, active, danger, style }: IconBtnProps) {
  return (
    <button
      className={"icon-btn" + (active ? " active" : "") + (danger ? " danger" : "")}
      onClick={onClick}
      title={title}
      style={style}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
