// App shell — frameless window layout per spec §2: global 56px rail on the
// left, everything right of it swaps with the active workspace.

import { lazy, Suspense, useEffect, useState } from "react";

import { ToastProvider } from "./shared/ui/ToastProvider";
import { useRepaintOnRestore } from "./shared/ui/useRepaintOnRestore";
import { usePreferencesStore } from "./features/preferences/state";
import { useSettingsStore } from "./features/settings/state";
import { SettingsModal } from "./features/settings/components/SettingsModal";
import { subscribeSettings } from "./features/settings/sync";
import { ConnectScreen } from "./features/workspaces/components/ConnectScreen";
import { NewConnectionModal } from "./features/connections/components/NewConnectionModal";
import { DonateModal } from "./features/workspaces/components/DonateModal";
import { Rail } from "./features/workspaces/components/Rail";
import { WorkspaceShell } from "./features/workspaces/components/WorkspaceShell";
import { RedisWorkspace } from "./features/browse/redis/components/RedisWorkspace";
import { DynamoWorkspace } from "./features/browse/dynamo/components/DynamoWorkspace";
import { MongoWorkspace } from "./features/browse/mongo/components/MongoWorkspace";
import { CassandraWorkspace } from "./features/browse/cassandra/components/CassandraWorkspace";
import { selectShowConnect, useWorkspacesStore } from "./features/workspaces/state";
import { useTrayWorkspaces } from "./features/workspaces/trayMenu";
import {
  appVersion,
  checkForUpdate,
  FALLBACK_VERSION,
  skippedVersion,
  type Update,
} from "./features/updater/api";
import { AboutModal } from "./features/updater/AboutModal";
import { UpdateModal } from "./features/updater/UpdateModal";
import { TitleBar } from "./shared/ui/TitleBar";
import { KeyboardShortcutsModal } from "./shared/ui/KeyboardShortcutsModal";
import type { TitleBarCtx } from "./shared/ui/titlebarMenus";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import "./App.css";

// Dev gallery (M0) is no longer the main screen: in dev builds it is toggled
// as a fullscreen overlay with ⌘⇧G (Ctrl+Shift+G). The import.meta.env.DEV
// guard is statically false in production, so the chunk is never built or
// loaded there.
const Gallery = import.meta.env.DEV
  ? lazy(() => import("./dev/Gallery").then((m) => ({ default: m.Gallery })))
  : null;

export function App() {
  useRepaintOnRestore();

  // Set platform and track maximized/fullscreen state: maximized drives the
  // rounded-corner CSS, and fullscreen (macOS) hides the OS traffic lights, so
  // the title bar must drop the gap it reserves for them.
  useEffect(() => {
    const os = platform();
    document.documentElement.dataset.platform = os;
    document.body.dataset.platform = os;

    const appWindow = getCurrentWindow();
    const updateWindowState = async () => {
      const [maximized, fullscreen] = await Promise.all([
        appWindow.isMaximized(),
        appWindow.isFullscreen(),
      ]);
      document.documentElement.classList.toggle("window-maximized", maximized);
      document.body.classList.toggle("window-maximized", maximized);
      document.documentElement.classList.toggle("window-fullscreen", fullscreen);
      document.body.classList.toggle("window-fullscreen", fullscreen);
    };

    void updateWindowState();

    const unlistenPromise = appWindow.onResized(() => {
      void updateWindowState();
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
  const loadPreferences = usePreferencesStore((state) => state.load);
  // M20 settings: bootstrap.ts already applied the localStorage fast-path
  // before mount; this reconciles it with the on-disk mirror (and seeds the
  // cache from disk on a fresh profile / after a localStorage clear).
  const loadSettings = useSettingsStore((state) => state.load);
  const syncSettings = useSettingsStore((state) => state.syncExternal);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspacesStore((state) => state.activeWorkspaceId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? null;
  // Title-bar menu dispatch targets that act on global app state.
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);
  const settings = useSettingsStore((state) => state.settings);
  const setSetting = useSettingsStore((state) => state.setSetting);
  // Prototype app.jsx `showConnect`: the rail's "+" tile shows the connect
  // screen without dropping the (still-open) active workspace.
  const showConnect = useWorkspacesStore(selectShowConnect);

  // Prototype app.jsx `donateOpen`: local app state, not a store concern.
  const [donateOpen, setDonateOpen] = useState(false);

  const [galleryOpen, setGalleryOpen] = useState(false);

  // M20 Settings modal: opened from the rail gear or the ⌘,/Ctrl+, shortcut.
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // Keyboard-shortcuts reference (title-bar Help → Keyboard Shortcuts).
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // New-connection modal, opened app-level from the title-bar File menu (the
  // connect screen has its own copy for its "New connection" button).
  const [newConnOpen, setNewConnOpen] = useState(false);

  useEffect(() => {
    void loadPreferences();
    void loadSettings();
    void appVersion().then(setVersion);
  }, [loadPreferences, loadSettings]);

  // M20.6: re-apply settings broadcast by another window (desktop multi-window;
  // no-op in plain browser dev).
  useEffect(() => subscribeSettings(syncSettings), [syncSettings]);

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

  // ⌘,/Ctrl+, opens (toggles) the Settings modal — the platform-standard
  // preferences shortcut.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // App-level handlers the title-bar app menu dispatches to (spec §2, path 1).
  // Workspace/query-tab commands don't go here — they ride the bt:cmd bus.
  const titleBarCtx: TitleBarCtx = {
    onNewConnection: () => setNewConnOpen(true),
    onCloseWorkspace: () => {
      if (activeWorkspaceId) closeWorkspace(activeWorkspaceId);
    },
    onCheckUpdates: () => {
      void (async () => {
        try {
          const found = await checkForUpdate();
          if (found) {
            setUpdate(found);
            setUpdateModalOpen(true);
            return;
          }
        } catch {
          /* offline / no shell — fall through to the About sheet */
        }
        // No newer build (or the check failed): show About, which displays the
        // running version and its own re-check affordance.
        setAboutOpen(true);
      })();
    },
    onAbout: () => setAboutOpen(true),
    onShortcuts: () => setShortcutsOpen(true),
    onZoom: (dir) => {
      const cur = settings.fontSize;
      // The font-size setting drives the whole-app webview zoom (zoom.ts),
      // clamped 10..18; "reset" returns to the 13px base (100%).
      const next =
        dir === "reset" ? 13 : dir === "in" ? Math.min(18, cur + 1) : Math.max(10, cur - 1);
      setSetting("fontSize", next);
    },
  };

  return (
    <ToastProvider>
      {/* Keeps the native tray "Workspaces" submenu in sync + handles its
          clicks. Renders nothing; must sit inside ToastProvider (it toasts on
          a failed open). */}
      <TrayWorkspacesBridge />
      <div className="bt-app-root">
        <TitleBar ctx={titleBarCtx} />
        <div className="app-frame">
          <Rail
            onDonate={() => setDonateOpen(true)}
            updateAvailable={update !== null}
            updateSkipped={updateSkipped}
            onUpdate={() => setUpdateModalOpen(true)}
            onAbout={() => setAboutOpen(true)}
            onSettings={() => setSettingsOpen(true)}
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
              // M17: a document-store connection renders the DynamoDB workspace
              // (a third sibling shell). Key-value → Redis; everything else → SQL.
              activeWorkspace.kind === "kv" ? (
                <RedisWorkspace key={activeWorkspace.id} workspace={activeWorkspace} />
              ) : activeWorkspace.kind === "document" ? (
                <DynamoWorkspace key={activeWorkspace.id} workspace={activeWorkspace} />
              ) : activeWorkspace.kind === "mongo" ? (
                // M18: a MongoDB connection renders the MongoDB workspace (a fourth
                // sibling shell). Document → DynamoDB; key-value → Redis; the rest → SQL.
                <MongoWorkspace key={activeWorkspace.id} workspace={activeWorkspace} />
              ) : activeWorkspace.kind === "cassandra" ? (
                // M19: a Cassandra connection renders the Cassandra workspace (a
                // fifth sibling shell, the wide-column vertical slice). Mongo →
                // MongoDB; document → DynamoDB; key-value → Redis; the rest → SQL.
                <CassandraWorkspace key={activeWorkspace.id} workspace={activeWorkspace} />
              ) : (
                <WorkspaceShell key={activeWorkspace.id} workspace={activeWorkspace} />
              )
            ) : (
              <ConnectScreen />
            )}
          </div>
        </div>
      </div>

      {settingsOpen ? <SettingsModal onClose={() => setSettingsOpen(false)} /> : null}

      {shortcutsOpen ? <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} /> : null}

      {newConnOpen ? <NewConnectionModal onClose={() => setNewConnOpen(false)} /> : null}

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

/** Mounts the tray↔workspaces bridge inside the toast context; renders nothing. */
function TrayWorkspacesBridge() {
  useTrayWorkspaces();
  return null;
}
