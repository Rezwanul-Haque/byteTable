// Typed invoke() wrappers for the connection-bundle slice (M40), plus the TS
// mirrors of its Rust wire types — keep in sync with
// `src-tauri/src/features/connection_bundle/domain/mod.rs`.
//
// A **bundle** is one passphrase-encrypted file holding a set of saved
// connections and their keychain secrets, so a user can move them between
// machines without cloud sync. The renderer owns both native dialogs and
// passes the resolved path down; it never reads or writes the file itself, and
// never sees a decrypted secret — only the preview the backend derives.
//
// Re-exported from `api.ts` (the slice's public contract) so other features
// consume it the sanctioned way.

import { invoke } from "@tauri-apps/api/core";

/** The conventional bundle file extension, used by both native dialogs. */
export const BUNDLE_EXTENSION = "btbundle";

/**
 * What to do with one entry at import time.
 *
 * - `skip` — leave the local registry alone.
 * - `import` — write it under its own id. The default when nothing local uses
 *   that id, and what makes re-importing an updated bundle *update* the
 *   connection rather than duplicate it.
 * - `replace` — overwrite the local entry (and its secrets) sharing this id.
 * - `copy` — write it as a new connection with a fresh id and a "Copy of …"
 *   name, leaving the local entry untouched.
 *
 * An id already present locally defaults to `skip`: a connection that already
 * works is never silently overwritten.
 */
export type ImportAction = "skip" | "import" | "replace" | "copy";

/** One row of the import preview — mirrors Rust's `BundleEntryPreview`. */
export interface BundleEntryPreview {
  id: string;
  name: string;
  /** The raw engine string; may be one this build does not know. */
  engine: string;
  /** "host:port · db"-style line, matching the connect screen's card detail. */
  detail: string;
  project?: string;
  env?: string;
  /** Whether the bundle carries any secret for this entry. */
  hasSecrets: boolean;
  /** Name of the LOCAL connection already using this id, when there is one. */
  conflict?: string;
  /**
   * Whether this build understands the entry's engine. Unsupported entries
   * still import — the registry preserves them and the connect screen renders
   * them struck-out — but the preview says so up front.
   */
  supported: boolean;
  /** Things to know before importing, e.g. an SSH key missing on this machine. */
  warnings?: string[];
  /**
   * Present when choosing `replace` would repoint this connection at a
   * different destination while the password already on this machine stays put
   * — the one outcome that can send a live credential somewhere it has never
   * been sent before.
   *
   * Separate from {@link warnings} because it is conditional on the chosen
   * action: show it against `replace`, hide it under `skip` and `copy` where it
   * does not apply.
   */
  replaceWarning?: string;
}

/** What a bundle contains — mirrors Rust's `BundlePreview`. */
export interface BundlePreview {
  /** Epoch milliseconds. */
  exportedAt: number;
  /** The ByteTable version that wrote the bundle. */
  appVersion: string;
  entries: BundleEntryPreview[];
}

/** A single entry that could not be imported — mirrors Rust's `ImportFailure`. */
export interface ImportFailure {
  name: string;
  reason: string;
}

/** The import tally — mirrors Rust's `ImportOutcome`. */
export interface ImportOutcome {
  imported: number;
  replaced: number;
  copied: number;
  skipped: number;
  failed?: ImportFailure[];
}

/** What the export wrote — mirrors Rust's `ExportOutcome`. */
export interface ExportOutcome {
  path: string;
  count: number;
  /** How many of the exported connections carry secret material. */
  withSecrets: number;
  /**
   * Connections whose stored secret could not be read — the OS keychain
   * refused, or the user denied its access prompt. Their params are in the
   * bundle; their password is not, so it will need retyping on the other
   * machine. The export deliberately completes rather than aborting: on macOS
   * each secret costs a separate prompt, and throwing away six answered
   * prompts because the seventh was denied helps nobody.
   */
  unreadableSecrets?: string[];
}

/**
 * Write the selected connections to `path` as an encrypted bundle.
 *
 * `ids` empty means every saved connection. An id that no longer resolves
 * fails the whole export rather than quietly producing a short bundle.
 *
 * `includeSecrets` controls whether keychain material travels. The file is
 * encrypted either way — host names, ports and usernames are not things to
 * hand around in the clear either.
 */
export function connectionBundleExport(
  path: string,
  ids: string[],
  passphrase: string,
  includeSecrets: boolean,
): Promise<ExportOutcome> {
  return invoke<ExportOutcome>("connection_bundle_export", {
    path,
    ids,
    passphrase,
    includeSecrets,
  });
}

/**
 * Decrypt a bundle and describe its contents. Writes nothing — this is the
 * step that lets the user confirm against what is really in the file
 * (collisions, missing SSH keys) instead of against a file name.
 *
 * A wrong passphrase fails here, so the preview is never reached with one.
 */
export function connectionBundleInspect(path: string, passphrase: string): Promise<BundlePreview> {
  return invoke<BundlePreview>("connection_bundle_inspect", { path, passphrase });
}

/**
 * Apply a bundle. `actions` maps a bundle entry's id to what to do with it; an
 * entry absent from the map imports when its id is free and skips when it
 * collides.
 *
 * One entry failing never aborts the rest — check {@link ImportOutcome.failed}.
 */
export function connectionBundleImport(
  path: string,
  passphrase: string,
  actions: Record<string, ImportAction>,
): Promise<ImportOutcome> {
  return invoke<ImportOutcome>("connection_bundle_import", { path, passphrase, actions });
}
