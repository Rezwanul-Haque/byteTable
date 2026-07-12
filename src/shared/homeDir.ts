// Home-directory helpers for display. The OS home path is fetched once from
// Tauri and cached module-wide; `tildify` collapses it to `~` so file paths
// (SQLite connections) render short — "/Users/alice/db.sqlite" → "~/db.sqlite".

import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";

// null = not loaded yet; "" = loaded but unavailable (leave paths untouched).
let cached: string | null = null;

/** Replace a leading home-dir prefix with `~`. No-op until home is known. */
export function tildify(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

/** Inverse of `tildify`: expand a leading `~` back to the absolute home path.
 *  No-op until home is known, so callers must keep the absolute form as the
 *  source of truth and only expand at persistence/use boundaries. */
export function expandTilde(path: string, home: string | null): string {
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path;
}

/** Abbreviate every directory segment to its first character, keeping the last
 *  segment (the file name) intact — "~/me/work/db.sqlite" → "~/m/w/db.sqlite".
 *  For tight spots (the title bar) where the file name matters most. Leading
 *  slash and a `~` prefix are preserved as-is. */
export function abbreviatePath(path: string): string {
  const parts = path.split("/");
  const last = parts.length - 1;
  return parts
    .map((seg, i) => {
      if (i === last || seg === "" || seg === "~") return seg;
      return [...seg][0] ?? seg;
    })
    .join("/");
}

/** The OS home directory (no trailing slash), or null until it resolves. */
export function useHomeDir(): string | null {
  const [home, setHome] = useState<string | null>(cached);
  useEffect(() => {
    if (cached !== null) {
      if (home !== cached) setHome(cached);
      return;
    }
    let alive = true;
    homeDir()
      .then((h) => {
        cached = h.replace(/\/+$/, "");
        if (alive) setHome(cached);
      })
      .catch(() => {
        cached = "";
        if (alive) setHome("");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return home;
}
