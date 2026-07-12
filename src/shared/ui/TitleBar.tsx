// WindowTitleBar — ByteTable's custom frameless-window title bar (spec §1–4).
//
// A 36px flex header that replaces the native OS titlebar, in three OS chrome
// modes:
//   • win           — Windows/Linux: custom min/restore-max/close on the right
//   • mac-native     — macOS hiddenInset: native traffic lights (OS-drawn) on
//                      the left, menus live in the system bar (we show a hint)
//   • mac-frameless  — macOS decorations:false: custom traffic lights on the
//                      left, in-window menu bar
//
// Three regions: .tb-left (brand wordmark + app menu, or the mac lights),
// .tb-center (live workspace context), .tb-right (Windows/Linux controls).

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { invoke } from "@tauri-apps/api/core";

import { abbreviatePath, tildify, useHomeDir } from "../homeDir";
import { useSettingsStore } from "../../features/settings/state";
import { selectShowConnect, useWorkspacesStore } from "../../features/workspaces/state";
import { connectionDetail } from "../../features/connections/api";
import { normalizeEnv } from "../types";
import { EngineBadge } from "./EngineBadge";
import { ENV_COLOR } from "./envColors";
import { TitleMenuBar } from "./TitleMenuBar";
import { buildMenus, type MenuCtx, type TitleBarCtx } from "./titlebarMenus";
import "./TitleBar.css";

type Mode = "win" | "mac-native" | "mac-frameless";

// macOS runs as an opaque, natively-decorated window with a hiddenInset
// ("Overlay") title bar: the OS draws the traffic lights and rounds the window
// corners, while our custom bar overlays the inset area (brand + menu + live
// context). We reserve space for the native lights and render nothing over
// them. Windows/Linux are frameless with our own controls.
function resolveMode(): Mode {
  return platform() === "macos" ? "mac-native" : "win";
}

export function TitleBar({ ctx }: { ctx: TitleBarCtx }) {
  const { settings, setSetting } = useSettingsStore();
  const home = useHomeDir();
  const mode = resolveMode();
  const isMac = mode === "mac-native" || mode === "mac-frameless";

  const appWindow = getCurrentWindow();
  const [maxed, setMaxed] = useState(false);

  // Track maximize/restore so the win control can swap its glyph.
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const m = await appWindow.isMaximized();
      if (alive) setMaxed(m);
    };
    void sync();
    const unlisten = appWindow.onResized(() => void sync());
    return () => {
      alive = false;
      void unlisten.then((u) => u());
    };
  }, [appWindow]);

  // Live workspace context. When the connect screen is showing, no workspace
  // surface is mounted, so we treat it as "no active workspace" — the center
  // shows the empty state and workspace-scoped menu items disable.
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);
  const showConnect = useWorkspacesStore(selectShowConnect);
  // The wordmark is a home affordance, mirroring the rail logo: it shows the
  // connect screen (without dropping any open workspace).
  const startAdding = useWorkspacesStore((s) => s.startAdding);
  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const ws = showConnect ? null : active;

  const menuCtx: MenuCtx = {
    hasWs: ws !== null,
    isSql: ws?.kind === "sql",
    hasPalette: ws?.kind === "sql" || ws?.kind === "kv",
    zoomChanged: settings.fontSize !== 13,
    ctx,
  };
  const menus = buildMenus(menuCtx);

  const cyclePosition = () => {
    const order = ["topLeftIcon", "bottomLeftIcon", "bottomRightIcon", "topRightIcon"] as const;
    const i = order.indexOf(settings.titlebarPosition);
    setSetting("titlebarPosition", order[(i + 1) % order.length]!);
  };

  return (
    <div
      data-tauri-drag-region
      data-screen-label="Window title bar"
      className={`bt-titlebar tb-mode-${mode}`}
      onDoubleClick={() => void appWindow.toggleMaximize()}
    >
      <div className={"bt-titlebar-left" + (isMac ? " tb-side-left" : "")} data-tauri-drag-region>
        {mode === "mac-frameless" ? (
          <MacLights
            onClose={() => void appWindow.close()}
            onMin={() => void appWindow.minimize()}
            onZoom={() => void appWindow.toggleMaximize()}
          />
        ) : mode === "mac-native" ? (
          // The OS draws the lights over this reserved gap (hiddenInset).
          <span className="tb-lights-native" aria-hidden />
        ) : null}

        <button
          type="button"
          className="tb-brand"
          title="ByteTable — open a connection"
          onClick={() => startAdding()}
        >
          <span className="tb-word">
            Byte<span className="tb-word-accent">Table</span>
          </span>
        </button>

        {/* Tauri has no native menu built from buildMenus, so the app menu is
            always in-window — on macOS too, overlaid in the inset title area. */}
        <TitleMenuBar menus={menus} />
      </div>

      <div className="bt-titlebar-center" data-tauri-drag-region>
        {ws ? (
          <>
            <EngineBadge engine={ws.saved.engine} size={18} />
            <span className="tb-ws-name">{ws.name}</span>
            <EnvPill env={ws.saved.env} color={ws.saved.color} />
            <span className="tb-detail">
              {ws.saved.params.engine === "sqlite"
                ? abbreviatePath(tildify(ws.saved.params.path, home))
                : connectionDetail(ws.saved.params)}
            </span>
          </>
        ) : (
          <span className="tb-context-empty">ByteTable — Database Client</span>
        )}
      </div>

      <div className="bt-titlebar-buttons">
        {mode === "win" ? (
          <>
            <button
              className="bt-titlebar-btn"
              onClick={cyclePosition}
              title="Cycle Titlebar Position"
            >
              <span className="msym">swap_vert</span>
            </button>
            <button
              className="bt-titlebar-btn"
              onClick={() => void invoke("hide_to_tray")}
              title="Hide to Tray"
            >
              <span className="msym">visibility_off</span>
            </button>
            <WinGlyph kind="min" onClick={() => void appWindow.minimize()} />
            <WinGlyph
              kind={maxed ? "restore" : "max"}
              onClick={() => void appWindow.toggleMaximize()}
            />
            <WinGlyph kind="close" onClick={() => void appWindow.close()} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The environment pill, tinted from the connection's own color override or the
 *  env default — border at 55, background at 18 alpha (spec §3). */
function EnvPill({ env, color }: { env: string; color?: string }) {
  const norm = normalizeEnv(env);
  const c = color ?? ENV_COLOR[norm];
  return (
    <span className="tb-env" style={{ color: c, borderColor: c + "55", background: c + "18" }}>
      {norm}
    </span>
  );
}

/** A single 46px Windows/Linux window-control button. */
function WinGlyph({
  kind,
  onClick,
}: {
  kind: "min" | "max" | "restore" | "close";
  onClick: () => void;
}) {
  const glyph =
    kind === "min"
      ? "remove"
      : kind === "max"
        ? "crop_square"
        : kind === "restore"
          ? "filter_none"
          : "close";
  const title =
    kind === "min"
      ? "Minimize"
      : kind === "max"
        ? "Maximize"
        : kind === "restore"
          ? "Restore"
          : "Close";
  return (
    <button
      className={"bt-titlebar-btn tb-wc-win" + (kind === "close" ? " close" : "")}
      onClick={onClick}
      title={title}
    >
      <span className="msym">{glyph}</span>
    </button>
  );
}

/** macOS custom traffic lights (mac-frameless mode) — glyphs reveal on hover. */
function MacLights({
  onClose,
  onMin,
  onZoom,
}: {
  onClose: () => void;
  onMin: () => void;
  onZoom: () => void;
}) {
  return (
    <div className="tb-winctl-left">
      <button className="tb-wc tb-wc-close" onClick={onClose} title="Close" aria-label="Close">
        <span className="tb-wc-glyph">✕</span>
      </button>
      <button className="tb-wc tb-wc-min" onClick={onMin} title="Minimize" aria-label="Minimize">
        <span className="tb-wc-glyph">–</span>
      </button>
      <button className="tb-wc tb-wc-zoom" onClick={onZoom} title="Zoom" aria-label="Zoom">
        <span className="tb-wc-glyph">+</span>
      </button>
    </div>
  );
}
