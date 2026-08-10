// The "Built by <name>" credit in a workspace status bar, opening the project's
// repo in the OS browser.
//
// Shared because every workspace shell has its own status bar and each had (or
// needed) an identical copy of the repo URL, the `openExternal` helper and this
// markup — the SQL and Redis bars already carried one, and adding it to the
// Cassandra / Mongo / DynamoDB / Typesense shells would have made six. Same
// reasoning as `CopyButton`: the behaviour lives here, and the only thing that
// legitimately differs per site is the host bar's "dim" class, passed as
// `className`.
//
// It ships its own CSS, so it styles correctly in a status bar that does not
// import `StatusBar.css` (DynamoDB has its own `.ddb-*` bar).

import { openUrl } from "@tauri-apps/plugin-opener";

import { UPDATE_REPO } from "../../features/updater/api";

import "./BuiltByCredit.css";

/** The project's source repository. Derived from the updater's repo constant so
 *  the credit can never point somewhere different from where releases live. */
const REPO_URL = "https://github.com/" + UPDATE_REPO;

/** Open a URL in the OS default browser; falls back to `window.open` in plain
 *  browser dev (no Tauri IPC). Mirrors DonateModal's `openExternal`. */
function openExternal(url: string): void {
  if ("__TAURI_INTERNALS__" in window) {
    void openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function BuiltByCredit({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={"status-credit" + (className ? " " + className : "")}
      title="View ByteTable source on GitHub"
      onClick={() => openExternal(REPO_URL)}
    >
      Built by <b>Rezwanul-Haque</b>
    </button>
  );
}
