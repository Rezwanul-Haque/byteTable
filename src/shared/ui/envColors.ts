// Env → tint map, mirroring `--env-*` in tokens.css. Lives in its own module
// (not EnvTag.tsx) so non-tag consumers — the Redis sidebar's env dot
// (REDIS_SPEC §4), the new-connection modal's env picker — can import the same
// colors without tripping react-refresh's "components-only export" rule on the
// component file.
//
// (`dev` is `#56b6c2` — the spec's `cache` cyan, so a Redis connection saved
// as `dev` reads as infra rather than an environment.)

import type { Env } from "../types";

/**
 * Default tint per environment (prototype connect.jsx `ENV_DEFAULT_COLORS`).
 * The new-connection modal seeds the env picker with these and lets the user
 * override the chosen env's color from {@link ENV_SWATCHES}.
 */
export const ENV_COLOR: Record<Env, string> = {
  dev: "#56b6c2",
  staging: "#e2b340",
  production: "#e06c75",
};

/**
 * Picker swatches offered for re-coloring the selected env (prototype
 * connect.jsx `ENV_SWATCHES`). The three env defaults plus five extras.
 */
export const ENV_SWATCHES = [
  "#56b6c2",
  "#5aa7f5",
  "#34d39e",
  "#e2b340",
  "#e8845a",
  "#e06c75",
  "#b08cff",
  "#ef7fb1",
] as const;
