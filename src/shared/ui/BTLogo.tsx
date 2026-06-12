// ByteTable logo mark — a data table with a live query cursor (spec §1.7).
// Exact SVG port from ui.jsx BTLogo: three "rows" — header row (accent, two
// cells), body row, and a final row ending in a blinking-cursor block. Reads
// as both a table and a terminal.

import "./BTLogo.css";

interface BTLogoProps {
  size?: number;
  accent?: string;
  fg?: string;
  /** Blink the cursor block (1.2s steps(2)) — brand contexts only. */
  blink?: boolean;
}

export function BTLogo({
  size = 24,
  accent = "var(--accent)",
  fg = "currentColor",
  blink = false,
}: BTLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="ByteTable"
      style={{ display: "block" }}
    >
      <rect x="3" y="4" width="8.5" height="4" rx="1.6" fill={accent} />
      <rect x="13.5" y="4" width="7.5" height="4" rx="1.6" fill={accent} opacity="0.45" />
      <rect x="3" y="10" width="18" height="4" rx="1.6" fill={fg} opacity="0.55" />
      <rect x="3" y="16" width="11" height="4" rx="1.6" fill={fg} opacity="0.35" />
      <rect
        x="16.5"
        y="16"
        width="4.5"
        height="4"
        rx="1.2"
        fill={accent}
        className={blink ? "logo-cursor" : undefined}
      />
    </svg>
  );
}
