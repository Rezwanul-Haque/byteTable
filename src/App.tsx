// App shell — frameless window layout per spec §2: global 56px rail on the
// left, everything right of it swaps with the active workspace.

import { lazy, Suspense, useEffect, useState } from "react";

import { ToastProvider } from "./shared/ui/ToastProvider";
import { usePreferencesStore } from "./features/preferences/state";
import { ConnectScreen } from "./features/workspaces/components/ConnectScreen";
import { DonateModal } from "./features/workspaces/components/DonateModal";
import { Rail } from "./features/workspaces/components/Rail";
import { WorkspaceShell } from "./features/workspaces/components/WorkspaceShell";
import { RedisWorkspace } from "./features/redis_browse/components/RedisWorkspace";
import { selectShowConnect, useWorkspacesStore } from "./features/workspaces/state";
import {
  appVersion,
  checkForUpdate,
  FALLBACK_VERSION,
  skippedVersion,
  type Update,
} from "./features/updater/api";
import { AboutModal } from "./features/updater/AboutModal";
import { UpdateModal } from "./features/updater/UpdateModal";
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

  // In-app updater (M-updater): check GitHub releases once on launch; surface
  // the modal when a newer signed build exists and the user hasn't skipped it.
  // Failures (offline, rate-limit, plain-browser dev) are silent.
  // `update` is the found release; it persists so the rail keeps an "update
  // available" indicator — even after the user skips that version (the icon
  // then goes static instead of disappearing). `updateModalOpen` drives the
  // modal (auto-opened on launch unless skipped, re-openable from the rail).
  // `skippedVer` tracks which version is skipped so the rail can mute its
  // animation for it.
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [skippedVer, setSkippedVer] = useState<string | null>(skippedVersion());

  // About modal (rail version label) + the running app version it shows.
  const [aboutOpen, setAboutOpen] = useState(false);
  const [version, setVersion] = useState(FALLBACK_VERSION);

  useEffect(() => {
    void loadPreferences();
    void appVersion().then(setVersion);
  }, [loadPreferences]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const found = await checkForUpdate();
        if (!alive || !found) return;
        // Always keep the rail indicator for a found update; only auto-open the
        // modal when this version hasn't been skipped.
        setUpdate(found);
        setSkippedVer(skippedVersion());
        if (found.version.replace(/^v/, "") !== (skippedVersion() ?? "")) {
          setUpdateModalOpen(true);
        }
      } catch {
        /* offline / rate-limited / no desktop shell — no update prompt */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Closing the modal keeps the rail indicator either way. If the user skipped
  // this version (the modal persists the skip before calling onClose), refresh
  // `skippedVer` so the rail mutes the icon's animation instead of hiding it.
  const closeUpdateModal = () => {
    setUpdateModalOpen(false);
    setSkippedVer(skippedVersion());
  };

  const updateVersion = update?.version.replace(/^v/, "") ?? null;
  const updateSkipped = updateVersion !== null && updateVersion === skippedVer;

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
        <Rail
          onDonate={() => setDonateOpen(true)}
          updateAvailable={update !== null}
          updateSkipped={updateSkipped}
          onUpdate={() => setUpdateModalOpen(true)}
          onAbout={() => setAboutOpen(true)}
          version={version}
        />
        <div className="app-body">
          {!showConnect && activeWorkspace ? (
            // §2 workspace layout: sidebar (248px) | tab bar + content,
            // status bar across the bottom. Keying the shell by workspace id
            // resets its transient local state (palette open, sidebar search,
            // open popovers) per workspace; the structural state (tabs,
            // active tab, schema, expanded rows) lives on workspace.ui and
            // survives switches.
            //
            // M13 (REDIS_SPEC §11): route on the engine family. A key-value
            // connection renders the Redis workspace (a sibling shell); every
            // relational engine renders the SQL workspace. Neither imports the
            // other — only the App, the shared host, knows both.
            activeWorkspace.kind === "kv" ? (
              <RedisWorkspace key={activeWorkspace.id} workspace={activeWorkspace} />
            ) : (
              <WorkspaceShell key={activeWorkspace.id} workspace={activeWorkspace} />
            )
          ) : (
            <ConnectScreen />
          )}
        </div>
      </div>

      {donateOpen ? <DonateModal onClose={() => setDonateOpen(false)} /> : null}

      {update && updateModalOpen ? (
        <UpdateModal update={update} onClose={closeUpdateModal} />
      ) : null}

      {aboutOpen ? (
        <AboutModal
          version={version}
          onClose={() => setAboutOpen(false)}
          onShowUpdate={(found) => {
            setUpdate(found);
            setUpdateModalOpen(true);
          }}
        />
      ) : null}

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
