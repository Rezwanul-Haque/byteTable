// Material Symbols icon — ported from ui.jsx MIcon. Rendering matches the
// prototype's inline font-variation-settings: global .msym pins wght 400 /
// GRAD 0 / opsz 20 and reads FILL from --msym-fill.

import type { CSSProperties } from "react";

interface IconProps {
  name: string;
  size?: number;
  fill?: 0 | 1;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 18, fill = 0, className, style }: IconProps) {
  return (
    <span
      className={className ? "msym " + className : "msym"}
      style={{ fontSize: size, "--msym-fill": fill, ...style } as CSSProperties}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}
