// App shell — frameless window layout per spec §2: global 56px rail on the
// left, everything right of it swaps with the active workspace.

import { lazy, Suspense, useEffect, useState } from "react";

import { BTLogo } from "./shared/ui/BTLogo";
import { ToastProvider } from "./shared/ui/ToastProvider";
import { usePreferencesStore } from "./slices/preferences/state";
import { ConnectScreen } from "./slices/workspaces/components/ConnectScreen";
import { WorkspacePlaceholder } from "./slices/workspaces/components/WorkspacePlaceholder";
import { useWorkspacesStore } from "./slices/workspaces/state";
import "./App.css";

// Dev gallery (M0) is no longer the main screen: in dev builds it is toggled
// as a fullscreen overlay with ⌘⇧G (Ctrl+Shift+G). The import.meta.env.DEV
// guard is statically false in production, so the chunk is never built or
// loaded there.
const Gallery = import.meta.env.DEV
  ? lazy(() => import("./dev/Gallery").then((m) => ({ default: m.Gallery })))
  : null;

export function App() {
  const loadPreferences = usePreferencesStore((state) => state.load);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspacesStore((state) => state.activeWorkspaceId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? null;

  const [galleryOpen, setGalleryOpen] = useState(false);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  // Dev-only: ⌘⇧G / Ctrl+Shift+G toggles the M0 component gallery overlay.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "KeyG") {
        event.preventDefault();
        setGalleryOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <ToastProvider>
      <div className="app-frame">
        {/*
          Rail PLACEHOLDER — the real workspace rail (tiles, "+", donate) is
          M1 Task 2; this keeps the 56px column so the layout is true.
          data-tauri-drag-region makes the rail chrome a window-drag area in
          the frameless window (Tauri drags only when the mousedown target
          itself has the attribute). Window controls (min/max/close buttons)
          are intentionally NOT in the design — macOS keyboard close (⌘W/⌘Q)
          works; cross-platform window controls are tracked for a later
          milestone.
        */}
        <div className="rail" data-tauri-drag-region>
          <div className="rail-logo" title="ByteTable" data-tauri-drag-region>
            <BTLogo size={22} accent="var(--accent)" fg="var(--text)" />
          </div>
          <div className="rail-sep" />
        </div>
        <div className="app-body">
          {activeWorkspace ? (
            <WorkspacePlaceholder workspace={activeWorkspace} />
          ) : (
            <ConnectScreen />
          )}
        </div>
      </div>

      {Gallery && galleryOpen ? (
        <Suspense fallback={null}>
          <div className="dev-gallery-overlay">
            <Gallery />
          </div>
        </Suspense>
      ) : null}
    </ToastProvider>
  );
}
