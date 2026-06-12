// Workspace rail — ported from the prototype's rail.jsx WorkspaceRail (spec
// §3.1): logo, hairline separator, one tile per open workspace, dashed "+"
// add tile, spacer, donate button. Right-clicking a tile opens the edit
// popover (rename / recolor / close). The DonateModal is M1 Task 3 — the
// donate button calls the `onDonate` prop, stubbed in App.tsx for now.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";

import { BTLogo } from "../../../shared/ui/BTLogo";
import { Icon } from "../../../shared/ui/Icon";
import { selectShowConnect, useWorkspacesStore, WORKSPACE_COLORS } from "../state";
import type { Workspace } from "../types";
import "./Rail.css";

// Tile chip/tooltip engine names — prototype ui.jsx ENGINE_META (label +
// short only; the badge colors live in EngineBadge.tsx, which keeps its own
// private copy by the same precedent).
const ENGINE_META = {
  sqlite: { label: "SQLite", short: "SQ" },
  mysql: { label: "MySQL", short: "My" },
  postgres: { label: "PostgreSQL", short: "Pg" },
} as const;

// Ported from rail.jsx wsInitials: two characters from the workspace name —
// first letters of the first two words ("_-" count as separators), or the
// first two characters of a single-word name.
function wsInitials(name: string): string {
  const parts = name.replace(/[_-]+/g, " ").trim().split(/\s+/);
  if (parts.length >= 2)
    return ((parts[0] ?? "").charAt(0) + (parts[1] ?? "").charAt(0)).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

interface EditPop {
  id: string;
  y: number;
}

interface RailProps {
  /** Donate button click — opens the donate modal (M1 Task 3). */
  onDonate: () => void;
}

export function Rail({ onDonate }: RailProps) {
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspacesStore((state) => state.activeWorkspaceId);
  const setActive = useWorkspacesStore((state) => state.setActive);
  const startAdding = useWorkspacesStore((state) => state.startAdding);
  const renameWorkspace = useWorkspacesStore((state) => state.renameWorkspace);
  const recolorWorkspace = useWorkspacesStore((state) => state.recolorWorkspace);
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);

  // Prototype `showConnect`: the "+" tile lights up and no workspace tile
  // renders active while the connect screen is showing.
  const showConnect = useWorkspacesStore(selectShowConnect);

  const [editPop, setEditPop] = useState<EditPop | null>(null);
  const [draftName, setDraftName] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // The tile that opened the popover — focus returns to it on close so
  // keyboard users aren't dropped at the document root.
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const closeEdit = useCallback(() => {
    setEditPop(null);
    openerRef.current?.focus();
  }, []);

  // Outside mousedown closes the popover (prototype rail.jsx); Escape closes
  // it too, even when focus has left the name input. Resizing the window or
  // scrolling the tile list would leave the fixed-position popover detached
  // from its tile, so those close it as well.
  useEffect(() => {
    if (!editPop) return;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".ws-edit-pop")) return;
      closeEdit();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEdit();
    };
    const onMove = () => closeEdit();
    const list = listRef.current;
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onMove);
    list?.addEventListener("scroll", onMove);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onMove);
      list?.removeEventListener("scroll", onMove);
    };
  }, [editPop, closeEdit]);

  // If the popover's workspace disappears out from under it (e.g. closed
  // elsewhere), drop the popover rather than render against stale state —
  // the render-time state adjustment React recommends over an effect.
  if (editPop && !workspaces.some((ws) => ws.id === editPop.id)) {
    setEditPop(null);
  }

  const openEdit = (tile: HTMLButtonElement, ws: Workspace) => {
    const rect = tile.getBoundingClientRect();
    openerRef.current = tile;
    setDraftName(ws.name);
    // Popover is position: fixed at left 62px; clamp so its ~280px body
    // never extends past the bottom of the window (prototype formula) and
    // its top never leaves the viewport.
    setEditPop({ id: ws.id, y: Math.max(8, Math.min(rect.top, window.innerHeight - 280)) });
  };

  // Keyboard path to the context-menu popover: Shift+F10 or the dedicated
  // ContextMenu key, matching native menu conventions.
  const onTileKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, ws: Workspace) => {
    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      event.preventDefault();
      openEdit(event.currentTarget, ws);
    }
  };

  const editingWs = editPop ? (workspaces.find((ws) => ws.id === editPop.id) ?? null) : null;

  return (
    // data-tauri-drag-region: the non-interactive rail chrome (background,
    // logo, spacer) drags the frameless window — Tauri only starts a drag
    // when the mousedown target itself carries the attribute, so the tiles
    // and buttons stay interactive.
    <nav className="rail" data-tauri-drag-region>
      <div className="rail-logo" title="ByteTable" data-tauri-drag-region>
        <BTLogo size={22} accent="var(--accent)" fg="var(--text)" />
      </div>
      <div className="rail-sep" />

      <div className="rail-list" ref={listRef}>
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId && !showConnect;
          return (
            <button
              key={ws.id}
              type="button"
              className={"ws-tile" + (isActive ? " active" : "")}
              style={{ "--ws-color": ws.color } as CSSProperties}
              onClick={() => setActive(ws.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                openEdit(event.currentTarget, ws);
              }}
              onKeyDown={(event) => onTileKeyDown(event, ws)}
              aria-label={ws.name}
              aria-current={isActive ? "true" : undefined}
              title={
                ws.name +
                " · " +
                ENGINE_META[ws.connection.engine].label +
                " (right-click to edit)"
              }
            >
              <span className="ws-tile-initials">{wsInitials(ws.name)}</span>
              <span className="ws-tile-engine">{ENGINE_META[ws.connection.engine].short}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={"ws-add" + (showConnect ? " active" : "")}
          onClick={startAdding}
          title="New workspace"
        >
          <Icon name="add" size={20} />
        </button>
      </div>

      <div className="rail-spacer" data-tauri-drag-region />

      <button
        type="button"
        className="rail-donate"
        onClick={onDonate}
        title="Support ByteTable — buy us a coffee"
      >
        <Icon name="favorite" size={18} fill={1} />
      </button>

      {editPop && editingWs ? (
        <div
          className="ws-edit-pop"
          style={{ top: editPop.y }}
          role="dialog"
          aria-label={"Edit workspace " + editingWs.name}
        >
          <div className="ws-edit-title">Workspace</div>
          <input
            className="ws-edit-input"
            value={draftName}
            autoFocus
            spellCheck="false"
            onChange={(event) => {
              // Live-commit the rename (prototype behavior); an emptied or
              // whitespace-only input falls back to the connection name.
              setDraftName(event.target.value);
              renameWorkspace(editPop.id, event.target.value.trim() || editingWs.connection.name);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") closeEdit();
            }}
          />
          <div className="ws-edit-label">Color</div>
          <div className="ws-colors">
            {WORKSPACE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={"ws-color-swatch" + (editingWs.color === color ? " active" : "")}
                style={{ background: color }}
                onClick={() => recolorWorkspace(editPop.id, color)}
                aria-label={"Set color " + color}
                aria-pressed={editingWs.color === color}
                title={color}
              />
            ))}
          </div>
          <button
            type="button"
            className="ws-edit-close"
            onClick={() => {
              closeWorkspace(editPop.id);
              closeEdit();
            }}
          >
            <Icon name="power_settings_new" size={14} /> Close workspace
          </button>
        </div>
      ) : null}
    </nav>
  );
}
