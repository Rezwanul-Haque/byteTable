// Committing staged edits to disk (M35 in-place editing).
//
// Two destinations, one writer: overwrite the file that is open, or write the
// edited result to a new path ("Save a copy"). Both go through
// `serializeFile`, so both preserve everything the user did not touch.
//
// Overwriting uses the ATOMIC command (temp + fsync + rename) rather than
// `export_save`'s create/truncate: the target already holds the user's data,
// and a crash mid-write must not be able to truncate it. A copy goes to a path
// that does not exist yet, so the plain write is fine there — but it uses the
// same command for one code path and a free `.bak` if the user picks an
// existing file in the save dialog.

import { saveTextFileAtomic } from "../../shared/api/engine";
import type { Parsed } from "./core";
import { serializeFile, type EditBatch } from "./csvWrite";

/** Extensions the "Save a copy" dialog offers. */
const SAVE_FILTERS = [
  { name: "Delimited text", extensions: ["csv", "tsv", "txt"] },
  { name: "All files", extensions: ["*"] },
];

/**
 * Ask for a path to write a copy to, defaulting beside the original with a
 * `-edited` suffix. Resolves null when the user cancels; rejects when the
 * dialog plugin is unavailable (plain-browser dev).
 */
export async function pickCopyPath(name: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dot = name.lastIndexOf(".");
  const suggested = dot > 0 ? name.slice(0, dot) + "-edited" + name.slice(dot) : name + "-edited";
  const chosen = await save({ defaultPath: suggested, filters: SAVE_FILTERS });
  return typeof chosen === "string" ? chosen : null;
}

/** The text a save would write — also what the "review changes" diff shows. */
export function editedText(text: string, parsed: Parsed, batch: EditBatch): string {
  return serializeFile(text, parsed, batch);
}

/**
 * Write the edited file to `path`.
 *
 * `backup` keeps the previous contents as `<name>.bak`; the caller sets it for
 * an in-place overwrite (where there is something to lose) and clears it for a
 * copy to a fresh path.
 *
 * Returns the text that was written, so the caller can adopt it as the new
 * baseline without re-reading from disk.
 */
export async function saveDataFile(
  path: string,
  text: string,
  parsed: Parsed,
  batch: EditBatch,
  backup: boolean,
): Promise<string> {
  const next = editedText(text, parsed, batch);
  await saveTextFileAtomic(path, next, backup);
  return next;
}
