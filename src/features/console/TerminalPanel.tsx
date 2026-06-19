// Docked terminal panel (M14, ARCHITECTURE §11) — a VS Code-style bottom panel
// hosting multiple terminal SESSIONS, ported from
// ByteTable_latest/bytetable/terminal.jsx `TerminalPanel`. A SHARED composition
// point: it owns the panel chrome (top-edge resize handle + session tabs +
// maximize/hide actions + body) and BRANCHES on engine to render each session's
// body (`renderSession`). This task wires SQL sessions; the Redis session body
// arrives in the next task (the renderSession engine-branch is the seam).
//
// MOUNTING. Docks at the bottom of the workspace content column, above the
// status bar. WorkspaceShell mounts it between <main>'s content and the
// StatusBar; RedisWorkspace mounts it the same way. Only renders when `open`.
//
// RESIZE. A drag handle on the top edge adjusts height (clamped to
// [TERM_MIN_HEIGHT, window.innerHeight − TERM_RESERVED_HEIGHT]); the height is
// persisted per workspace. A drag also cancels `maximized` (prototype behavior).
// `maximized` = full content-area height (the `.maximized` class; flex grows it).

import { useRef } from "react";

import { Icon } from "../../shared/ui/Icon";
import { IconBtn } from "../../shared/ui/IconBtn";
import type { Workspace } from "../workspaces/types";
import { DynamoPartiqlSession } from "./DynamoPartiqlSession";
import { RedisTerminalSession } from "./RedisTerminalSession";
import { SqlTerminalTab } from "./SqlTerminalTab";
import {
  TERM_DEFAULT_HEIGHT,
  TERM_MIN_HEIGHT,
  TERM_RESERVED_HEIGHT,
  selectPanel,
  shellLabel,
  usePanelStore,
  type TermSession,
} from "./state";
import "./TerminalPanel.css";

export function TerminalPanel({ workspace }: { workspace: Workspace }) {
  const wsId = workspace.id;
  const panel = usePanelStore((s) => selectPanel(s, wsId));
  const setHeight = usePanelStore((s) => s.setHeight);
  const toggleMax = usePanelStore((s) => s.toggleMax);
  const closePanel = usePanelStore((s) => s.closePanel);
  const newSession = usePanelStore((s) => s.newSession);
  const closeSession = usePanelStore((s) => s.closeSession);
  const selectSession = usePanelStore((s) => s.selectSession);

  const dragRef = useRef<HTMLDivElement>(null);

  if (!panel.open) return null;

  const label = shellLabel(workspace.saved.engine);
  const height = panel.height > 0 ? panel.height : TERM_DEFAULT_HEIGHT;

  // Top-edge resize (pointer events; survives leaving the handle via capture).
  // Dragging up (smaller clientY) grows the panel. `setHeight` also clears
  // `maximized` so a drag restores from the maximized state.
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.maximized ? height : height;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const max = Math.max(TERM_MIN_HEIGHT, window.innerHeight - TERM_RESERVED_HEIGHT);
      const next = Math.max(TERM_MIN_HEIGHT, Math.min(max, startH + (startY - ev.clientY)));
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

  // Engine-branch render point: SQL sessions get the SqlTerminalTab REPL;
  // Redis sessions get the RedisTerminalSession redis-cli body (wired to
  // kvCommand + the redis_browse store). This `engine` branch is the seam.
  const renderSession = (s: TermSession) => {
    if (workspace.saved.engine === "redis") {
      return <RedisTerminalSession workspace={workspace} session={s} embedded />;
    }
    if (workspace.saved.engine === "dynamodb") {
      return <DynamoPartiqlSession workspace={workspace} session={s} />;
    }
    return (
      <SqlTerminalTab
        workspace={workspace}
        session={s}
        embedded
        onClose={() => closeSession(wsId, s.id)}
      />
    );
  };

  return (
    <div
      className={"term-panel" + (panel.maximized ? " maximized" : "")}
      style={panel.maximized ? undefined : { height }}
    >
      <div
        className="term-resize"
        ref={dragRef}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        title="Drag to resize"
        onPointerDown={onHandlePointerDown}
      />
      <div className="term-panel-head">
        <div className="term-tabs">
          {panel.sessions.map((s) => {
            const active = s.id === panel.activeSessionId;
            return (
              <div
                key={s.id}
                className={"term-tab" + (active ? " active" : "")}
                onClick={() => selectSession(wsId, s.id)}
                title={s.title}
              >
                <Icon
                  name="terminal"
                  size={13}
                  style={{ color: active ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="term-tab-title">{s.title}</span>
                <button
                  type="button"
                  className="term-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(wsId, s.id);
                  }}
                  title="Kill terminal"
                  aria-label={"Kill " + s.title}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="term-newtab"
            onClick={() => newSession(wsId, label)}
            title="New terminal session"
            aria-label="New terminal session"
          >
            <Icon name="add" size={15} />
          </button>
        </div>
        <div className="term-actions">
          <IconBtn
            icon={panel.maximized ? "close_fullscreen" : "open_in_full"}
            size={15}
            title={panel.maximized ? "Restore" : "Maximize"}
            onClick={() => toggleMax(wsId)}
          />
          <IconBtn
            icon="keyboard_arrow_down"
            size={17}
            title="Hide panel (Ctrl+`)"
            onClick={() => closePanel(wsId)}
          />
        </div>
      </div>
      <div className="term-panel-body">
        {panel.sessions.map((s) => (
          <div
            key={s.id}
            className="term-session"
            style={{ display: s.id === panel.activeSessionId ? "contents" : "none" }}
          >
            {renderSession(s)}
          </div>
        ))}
      </div>
    </div>
  );
}
