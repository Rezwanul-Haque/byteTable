// Env → tint map, mirroring `--env-*` in tokens.css. Lives in its own module
// (not EnvTag.tsx) so non-tag consumers — the Redis sidebar's env dot
// (REDIS_SPEC §4) — can import the same colors without tripping
// react-refresh's "components-only export" rule on the component file.
//
// (`local` is `#56b6c2` — the spec's `cache` cyan, so a Redis connection saved
// as `local` reads as infra rather than an environment.)

import type { Env } from "../types";

export const ENV_COLOR: Record<Env, string> = {
  local: "#56b6c2",
  staging: "#e2b340",
  production: "#e06c75",
};
