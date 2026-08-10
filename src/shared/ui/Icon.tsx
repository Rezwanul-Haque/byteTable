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

/**
 * Glyphs that point along the reading direction — pager and tab-scroller
 * chevrons, tree disclosure carets, back/forward arrows. These are the only
 * icons that mirror in an RTL locale (M31 Task 5): everything else keeps its
 * shape, and the SQL editor gutter, graph canvas and charts are never touched.
 * Marked centrally here rather than at ~25 call sites; `.msym-dir` is flipped
 * by the [dir="rtl"] block in global.css.
 */
const DIRECTIONAL = new Set([
  "chevron_left",
  "chevron_right",
  "keyboard_arrow_left",
  "keyboard_arrow_right",
  "arrow_back",
  "arrow_forward",
  "arrow_left",
  "arrow_right",
  "arrow_back_ios",
  "arrow_forward_ios",
  "first_page",
  "last_page",
  "subdirectory_arrow_right",
]);

export function Icon({ name, size = 18, fill = 0, className, style }: IconProps) {
  const classes =
    "msym" + (DIRECTIONAL.has(name) ? " msym-dir" : "") + (className ? " " + className : "");
  return (
    <span
      className={classes}
      style={{ fontSize: size, "--msym-fill": fill, ...style } as CSSProperties}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}
