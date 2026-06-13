// Workspace shell — composes the active workspace's chrome (spec §2 layout):
// sidebar (248px) | tab bar + content (main), with the 28px status bar
// spanning the bottom. Owns workspace-level keyboard shortcuts (§3.12) and
// the command-palette open state.
//
// Keying this component by workspace id (in App) resets the palette state +
// keyboard registration per workspace; the structural tab state lives on
// workspace.ui and survives switches.

import { useEffect, useState } from "react";

import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { StatusBar } from "./StatusBar";
import { WorkspaceContent } from "./WorkspaceContent";
import { TerminalPanel } from "../../console/TerminalPanel";
import { shellLabel, usePanelStore } from "../../console/state";
import { useWorkspacesStore } from "../state";
import type { Workspace } from "../types";

export function WorkspaceShell({ workspace }: { workspace: Workspace }) {
  const openSqlTab = useWorkspacesStore((state) => state.openSqlTab);
  const togglePanel = usePanelStore((state) => state.togglePanel);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // §3.12: ⌘/Ctrl+K toggles the palette, ⌘/Ctrl+T opens a new SQL tab.
  // M14: ⌃` (Ctrl+backtick, the VS Code convention) toggles the docked console
  // panel for the active workspace. Registered at the workspace level, cleaned
  // up on unmount / re-key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ⌃` is its own binding (Ctrl, not the ⌘/Ctrl `mod`) — handle it first.
      if (event.ctrlKey && event.key === "`") {
        event.preventDefault();
        togglePanel(workspace.id, shellLabel(workspace.saved.engine));
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === "t") {
        event.preventDefault();
        openSqlTab();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSqlTab, togglePanel, workspace.id, workspace.saved.engine]);

  return (
    <div className="workspace">
      <Sidebar workspace={workspace} />
      <main className="main-col">
        <WorkspaceContent workspace={workspace} />
        {/* Docks at the bottom of the content column, above the status bar.
            Only renders when this workspace's console is open. */}
        <TerminalPanel workspace={workspace} />
      </main>
      <StatusBar workspace={workspace} />
      {paletteOpen ? (
        <CommandPalette workspace={workspace} onClose={() => setPaletteOpen(false)} />
      ) : null}
    </div>
  );
}
