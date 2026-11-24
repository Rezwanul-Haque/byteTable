// App-level upkeep for query notebooks (M47), mounted once at the root:
//
//   - a notebook's document goes when its tab does (closing the tab, the
//     workspace, or the app's last view of it);
//   - the backend's quit guard knows whether a quit would lose edits, so ⌘Q
//     and tray Quit are held for the Save / Discard / Cancel prompt;
//   - the backend's "quit requested" nudge opens that prompt;
//   - a Markdown file dropped on the window opens as a notebook (B2).

import { useEffect } from "react";

import { useT } from "../../../shared/i18n/useT";
import { useToast } from "../../../shared/ui/toastContext";
import { appErrorMessage } from "../../../shared/api/error";
import { useWorkspacesStore } from "../../workspaces/state";
import { QUIT_REQUESTED_EVENT, setAppUnsaved } from "../api";
import { baseName, openNotebookHere } from "../files";
import { dirtyNotebookTabs, useNotebooksStore } from "../state";

const isNotebookPath = (p: string) => /\.(md|markdown)$/i.test(p);

export function useNotebooksLifecycle(onQuitRequested: () => void): void {
  const t = useT();
  const toast = useToast();

  // Forget documents whose tab is gone.
  useEffect(
    () =>
      useWorkspacesStore.subscribe((s) => {
        const live = new Set<string>();
        for (const ws of s.workspaces) for (const tab of ws.ui.tabs ?? []) live.add(tab.id);
        const { docs, close } = useNotebooksStore.getState();
        for (const id of Object.keys(docs)) if (!live.has(id)) close(id);
      }),
    [],
  );

  // Keep the quit guard current (only on a change, not on every keystroke).
  useEffect(() => {
    let last = false;
    const sync = () => {
      const unsaved = dirtyNotebookTabs(useNotebooksStore.getState().docs).size > 0;
      if (unsaved === last) return;
      last = unsaved;
      void setAppUnsaved(unsaved).catch(() => {});
    };
    sync();
    return useNotebooksStore.subscribe(sync);
  }, []);

  // ⌘Q / tray Quit with unsaved notebooks: the backend holds it and asks.
  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const stop = await listen(QUIT_REQUESTED_EVENT, () => onQuitRequested());
        if (cancelled) stop();
        else off = stop;
      } catch {
        /* no Tauri — nothing to quit */
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, [onQuitRequested]);

  // Drop a .md on the window: open it as a notebook here.
  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          for (const path of event.payload.paths.filter(isNotebookPath)) {
            void openNotebookHere(path)
              .then((opened) => {
                if (!opened) toast(t("notebook.open.needsSql"), "info");
              })
              .catch((err: unknown) =>
                toast(
                  appErrorMessage(err, t("notebook.open.failed", { name: baseName(path) })),
                  "err",
                ),
              );
          }
        });
        if (cancelled) stop();
        else off = stop;
      } catch {
        /* no webview API (plain browser dev) */
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, [t, toast]);
}
