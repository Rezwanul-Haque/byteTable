// App shell — frameless window layout per spec §2: global 56px rail on the
// left, everything right of it swaps with the active workspace.

import { lazy, Suspense, useEffect, useState } from "react";

import { ToastProvider } from "./shared/ui/ToastProvider";
import { usePreferencesStore } from "./features/preferences/state";
import { ConnectScreen } from "./features/workspaces/components/ConnectScreen";
import { DonateModal } from "./features/workspaces/components/DonateModal";
import { Rail } from "./features/workspaces/components/Rail";
import { WorkspacePlaceholder } from "./features/workspaces/components/WorkspacePlaceholder";
import { selectShowConnect, useWorkspacesStore } from "./features/workspaces/state";
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
  // Prototype app.jsx `showConnect`: the rail's "+" tile shows the connect
  // screen without dropping the (still-open) active workspace.
  const showConnect = useWorkspacesStore(selectShowConnect);

  // Prototype app.jsx `donateOpen`: local app state, not a store concern.
  const [donateOpen, setDonateOpen] = useState(false);

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
        <Rail onDonate={() => setDonateOpen(true)} />
        <div className="app-body">
          {!showConnect && activeWorkspace ? (
            <WorkspacePlaceholder workspace={activeWorkspace} />
          ) : (
            <ConnectScreen />
          )}
        </div>
      </div>

      {donateOpen ? <DonateModal onClose={() => setDonateOpen(false)} /> : null}

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
