// In-app updater (GitHub releases). Thin wrappers over the Tauri updater +
// process plugins: `check()` hits the configured `latest.json` endpoint
// (tauri.conf.json → plugins.updater.endpoints), verifies the signature against
// the configured pubkey, and returns an `Update` (or null when up to date). The
// modal drives `downloadAndInstall` + `relaunch`. A "skip this version" choice
// is remembered in localStorage so the user isn't re-prompted for it.

import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";

/** The GitHub repo releases are published to (matches the updater endpoint). */
export const UPDATE_REPO = "rezwanul-Haque/byteTable";

/** Fallback shown before the real version resolves / in plain-browser dev. */
export const FALLBACK_VERSION = "0.0.11";

/** The running app version (from Cargo/tauri.conf), without a leading `v`.
 *  Falls back to {@link FALLBACK_VERSION} outside the Tauri shell. */
export async function appVersion(): Promise<string> {
  if (!("__TAURI_INTERNALS__" in window)) return FALLBACK_VERSION;
  try {
    return await getVersion();
  } catch {
    return FALLBACK_VERSION;
  }
}

const SKIP_KEY = "bytetable_skipped_version";

/** The GitHub release page for a version (the modal's "Release notes" link). */
export function releaseUrl(version: string): string {
  return `https://github.com/${UPDATE_REPO}/releases/tag/v${version.replace(/^v/, "")}`;
}

/**
 * Check for a newer signed release. Returns the `Update` when one is available,
 * else null. In plain-browser dev (`pnpm dev:vite`, no Tauri shell) there is no
 * updater plugin, so this is a no-op that returns null.
 */
export async function checkForUpdate(): Promise<Update | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  return check();
}

/** The version the user chose to skip (so we don't re-prompt for it), or null. */
export function skippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

/** Remember a skipped version. */
export function skipVersion(version: string): void {
  try {
    localStorage.setItem(SKIP_KEY, version);
  } catch {
    /* localStorage unavailable — skipping is best-effort */
  }
}

export type { Update };
