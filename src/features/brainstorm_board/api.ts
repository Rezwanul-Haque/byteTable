// The one Tauri command the board needs that did not already exist.
//
// The board's SVG export is text and goes through the shared `exportSave`
// wrapper. Its PNG, though, arrives from the DOM serializer already rasterized,
// so there is nothing left for the backend to render — only bytes to place. That
// is what this adds: the binary sibling of `export_save`, in the same export
// slice that owns every "the user picked a path, now write it" command.
//
// (Contrast `schema_map`'s `diagram_export`, which receives SVG *text* and
// rasterizes it in Rust with resvg. That works because the schema map is SVG
// natively; the board is HTML.)

import { invoke } from "@tauri-apps/api/core";

/**
 * Write base64-encoded bytes to a user-chosen path (`export_save_bytes`). The
 * `path` must come from the native save dialog — that explicit choice is the
 * only consent the write needs.
 *
 * Base64 rather than a JSON number array: ~1.33× the raw size over IPC against
 * ~10×.
 */
export function exportSaveBytes(path: string, base64: string): Promise<void> {
  return invoke<void>("export_save_bytes", { path, base64 });
}
