// Getting a data file's TEXT into the open sheet (M35 Task 4).
//
// Two sources, because the sheet must work in both shells:
//
//  - **Desktop (the real app).** The native picker returns a path and
//    `read_text_file` reads it. The webview also intercepts OS drag-and-drop
//    before the DOM sees it, so a drop arrives as Tauri's own event carrying
//    paths — never as `DataTransfer.files`.
//  - **Plain browser dev.** Neither plugin exists; a hidden `<input type=file>`
//    and `FileReader` cover both click-to-browse and HTML5 drop.
//
// Both paths produce the same {@link PickedFile}, so the sheet never branches.

import { readTextFile } from "../../shared/api/engine";

/** The extensions the picker filters to — delimited text, nothing binary. */
const EXTENSIONS = ["csv", "tsv", "txt", "tab", "psv"];

/** A file the user chose, decoded and ready to sniff. */
export interface PickedFile {
  name: string;
  /** Absolute path when it came from the desktop shell; null in browser dev. */
  path: string | null;
  size: number;
  text: string;
}

/** True when running inside the Tauri shell (so the plugins are reachable). */
export function hasDesktopShell(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** The last path segment, for the display name. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Show the native open dialog and read the chosen file. Resolves to null when
 * the user cancels; rejects when the shell is absent or the read fails.
 */
export async function pickDataFile(): Promise<PickedFile | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: "Delimited text", extensions: EXTENSIONS },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (typeof chosen !== "string") return null;
  return readPath(chosen);
}

/** Read one absolute path (the native picker's, or a Tauri drop's). */
export async function readPath(path: string): Promise<PickedFile> {
  const text = await readTextFile(path);
  // The byte length, not the character count: this is what the OS reports and
  // what "3.4 MB" has to mean.
  return { name: baseName(path), path, size: new Blob([text]).size, text };
}

/** Read a browser `File` (hidden input, or an HTML5 drop in plain dev). */
export function readBrowserFile(file: File): Promise<PickedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({ name: file.name, path: null, size: file.size, text: String(reader.result) });
    reader.onerror = () => reject(new Error("Could not read “" + file.name + "”."));
    reader.readAsText(file);
  });
}
