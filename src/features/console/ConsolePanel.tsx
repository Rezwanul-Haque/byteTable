// Docked console panel host (M14, ARCHITECTURE §11) — a SHARED composition
// point: it owns the dockable bottom-panel chrome (resize handle + header +
// body) and BRANCHES on the active workspace's engine/kind to render the
// engine-specific console body. This task wires the SQL body; Redis workspaces
// get a placeholder until Task 2 plugs in the Redis console body here.
//
// MOUNTING. The panel docks at the bottom of the workspace content column,
// above the status bar. WorkspaceShell mounts it between <main> and the
// StatusBar; only renders when `open`. Task 2 mounts it the same way in
// RedisWorkspace.
//
// RESIZE. A drag handle on the top edge adjusts height via pointer events
// (clamped to [CONSOLE_MIN_HEIGHT, CONSOLE_MAX_FRACTION × content height]);
// the height is persisted per workspace in the console store. Default height is
// CONSOLE_DEFAULT_FRACTION of the content area on first open (height 0 = "use
// the default").

import { useLayoutEffect, useRef, useState } from "react";

import { Icon } from "../../shared/ui/Icon";
import { IconBtn } from "../../shared/ui/IconBtn";
import type { Workspace } from "../workspaces/types";
import { SqlConsole } from "./SqlConsole";
import {
  CONSOLE_DEFAULT_FRACTION,
  CONSOLE_MAX_FRACTION,
  CONSOLE_MIN_HEIGHT,
  selectConsole,
  useConsoleStore,
} from "./state";
import "./ConsolePanel.css";

/** The panel's title strip text per engine (SQL: `{conn} · {schema}`). */
function panelTitle(workspace: Workspace): string {
  if (workspace.kind === "kv") return workspace.name; // Redis lineage: Task 2.
  const schema =
    (workspace.ui.schemaName !== undefined &&
    workspace.schemas.some((s) => s.name === workspace.ui.schemaName)
      ? workspace.ui.schemaName
      : workspace.schemas[0]?.name) ?? "main";
  return workspace.name + " · " + schema;
}

/** Resolve the effective panel height in px against the content area height. */
function effectiveHeight(stored: number, contentH: number): number {
  const max = Math.max(CONSOLE_MIN_HEIGHT, Math.round(contentH * CONSOLE_MAX_FRACTION));
  const base = stored > 0 ? stored : Math.round(contentH * CONSOLE_DEFAULT_FRACTION);
  return Math.min(max, Math.max(CONSOLE_MIN_HEIGHT, base));
}

export function ConsolePanel({ workspace }: { workspace: Workspace }) {
  const wsId = workspace.id;
  const cons = useConsoleStore((s) => selectConsole(s, wsId));
  const closePanel = useConsoleStore((s) => s.closePanel);
  const clearLog = useConsoleStore((s) => s.clearLog);
  const setHeight = useConsoleStore((s) => s.setHeight);

  const rootRef = useRef<HTMLDivElement>(null);
  // The content column height, measured (never read off a ref during render).
  // Drives the default-fraction + clamp. Tracked so a window/layout resize
  // re-clamps the panel.
  const [contentH, setContentH] = useState(0);

  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setContentH(parent.clientHeight);
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(parent);
    return () => obs.disconnect();
    // cons.open gates this effect: the panel only mounts when open, so a
    // re-open re-measures the parent.
  }, [cons.open]);

  if (!cons.open) return null;

  const fallbackH = contentH > 0 ? contentH : window.innerHeight;
  const height = effectiveHeight(cons.height, fallbackH);

  // Pointer-drag resize from the top edge. Dragging up (smaller clientY) grows
  // the panel. Captures the pointer so the drag survives leaving the handle.
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const max = Math.max(CONSOLE_MIN_HEIGHT, Math.round(fallbackH * CONSOLE_MAX_FRACTION));
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const next = Math.min(max, Math.max(CONSOLE_MIN_HEIGHT, startH + (startY - ev.clientY)));
      setHeight(wsId, next);
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <div className="console-panel" ref={rootRef} style={{ height }}>
      <div
        className="console-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize console"
        onPointerDown={onHandlePointerDown}
      />
      <div className="console-header">
        <Icon name="terminal" size={14} style={{ color: "var(--accent)" }} />
        <span className="console-title">{panelTitle(workspace)}</span>
        <div className="console-header-spacer" />
        <IconBtn
          icon="delete_sweep"
          size={16}
          title="Clear console"
          onClick={() => clearLog(wsId)}
        />
        <IconBtn icon="close" size={16} title="Close console" onClick={() => closePanel(wsId)} />
      </div>
      <div className="console-body-wrap">
        {workspace.kind === "kv" ? (
          <div className="console-placeholder">Redis console — Task 2</div>
        ) : (
          <SqlConsole workspace={workspace} />
        )}
      </div>
    </div>
  );
}
