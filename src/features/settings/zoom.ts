// Whole-app text scale via the webview zoom factor. The font-size setting
// drives this so ALL text (chrome, editor, grid) scales together — not just the
// monospace surfaces. 13px = 100%. Uses the webview's own zoom (like Ctrl+=)
// because a CSS `zoom` on <body> would overflow the fixed full-height layout.
//
// Desktop only: outside Tauri (plain browser dev) the import rejects and we
// no-op. The editor/grid keep a fixed CSS base (apply.ts) so this zoom doesn't
// double-scale them.

const BASE = 13;

/** Set the webview zoom from the editor font-size (clamped 10..18). */
export function applyZoom(fontSize: number): void {
  const fs = Number.isFinite(fontSize) ? Math.max(10, Math.min(18, fontSize)) : BASE;
  const factor = fs / BASE;
  void import("@tauri-apps/api/webviewWindow")
    .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().setZoom(factor))
    .catch(() => {
      /* not running inside Tauri, or no permission — no-op */
    });
}
