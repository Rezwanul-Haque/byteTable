// JSON / JSONB cell helpers — ported from the prototype's json-editor.jsx.
// The backend returns JSON columns as their text form; these helpers drive the
// grid-cell preview and the editor modal (highlight + validation).

import type { CellValue } from "../../../shared/api/engine";

/** True for JSON / JSONB column types. */
export function isJsonType(type: string | undefined): boolean {
  return /JSON/i.test(type ?? "");
}

/** One-line grid preview: `{ a, b, … }` / `[N]` / scalar / clipped raw. */
export function jsonPreview(raw: CellValue): string | null {
  if (raw == null) return null;
  const s = String(raw);
  try {
    const v: unknown = JSON.parse(s);
    if (Array.isArray(v)) return "[" + v.length + "]";
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      return "{ " + keys.slice(0, 3).join(", ") + (keys.length > 3 ? ", …" : "") + " }";
    }
    return String(v);
  } catch {
    return s.slice(0, 40);
  }
}

/** HTML-escape + token-colorize JSON for the editor's highlight layer. */
export function highlightJSON(src: string): string {
  let html = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  html = html.replace(/"(?:[^"\\]|\\.)*"(\s*:)?/g, (m, colon: string | undefined) => {
    const inner = m.replace(/(\s*:)$/, "");
    return '<span class="jx-' + (colon ? "key" : "str") + '">' + inner + "</span>" + (colon ?? "");
  });
  html = html.replace(/\b(true|false)\b/g, '<span class="jx-bool">$1</span>');
  html = html.replace(/\bnull\b/g, '<span class="jx-null">null</span>');
  html = html.replace(/-?\b\d+(\.\d+)?([eE][+-]?\d+)?\b/g, '<span class="jx-num">$&</span>');
  return html;
}

export type JsonValidation =
  | { ok: true; empty: true }
  | { ok: true; empty?: false; value: unknown }
  | { ok: false; message: string; line: number | null; col: number | null };

/** Validate JSON text; empty → NULL. On error, best-effort line/col. */
export function validateJSON(text: string): JsonValidation {
  const t = text.trim();
  if (t === "") return { ok: true, empty: true };
  try {
    return { ok: true, value: JSON.parse(t) as unknown };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const m = /position (\d+)/.exec(message);
    let line: number | null = null;
    let col: number | null = null;
    if (m) {
      const pos = Number(m[1]);
      const before = text.slice(0, pos);
      line = before.split("\n").length;
      col = pos - before.lastIndexOf("\n");
    }
    return {
      ok: false,
      message: message.replace(/^JSON\.parse:\s*/, "").replace(/ in JSON at position \d+.*/, ""),
      line,
      col,
    };
  }
}
