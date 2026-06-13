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
import { useWorkspacesStore } from "../state";
import type { Workspace } from "../types";

export function WorkspaceShell({ workspace }: { workspace: Workspace }) {
  const openSqlTab = useWorkspacesStore((state) => state.openSqlTab);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // §3.12: ⌘/Ctrl+K toggles the palette, ⌘/Ctrl+T opens a new SQL tab.
  // Registered at the workspace level, cleaned up on unmount / re-key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [openSqlTab]);

  return (
    <div className="workspace">
      <Sidebar workspace={workspace} />
      <main className="main-col">
        <WorkspaceContent workspace={workspace} />
      </main>
      <StatusBar workspace={workspace} />
      {paletteOpen ? (
        <CommandPalette workspace={workspace} onClose={() => setPaletteOpen(false)} />
      ) : null}
    </div>
  );
}
