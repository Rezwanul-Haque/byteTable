// Environment tag — pill per spec §1.3: 1px border {color}66, bg {color}14,
// mono 9.5px uppercase 600, tracking .06em, radius 99. Inline color formula
// ported from connect.jsx / workspace.jsx usage. Hexes mirror --env-* in
// tokens.css; literals are kept for the prototype's alpha-suffix pattern.

import type { Env } from "../types";

import { ENV_COLOR } from "./envColors";
import "./EnvTag.css";

// Re-exported for back-compat — Env now lives in src/shared/types.ts.
export type { Env };

export function EnvTag({ env }: { env: Env }) {
  const color = ENV_COLOR[env];
  return (
    <span
      className="env-tag"
      style={{ color, borderColor: color + "66", background: color + "14" }}
    >
      {env}
    </span>
  );
}
