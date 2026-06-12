// Keyboard chip — ported from the prototype's .kbd usage (workspace.jsx).

import type { ReactNode } from "react";

import "./Kbd.css";

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}
