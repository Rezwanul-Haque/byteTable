// Temporary stand-in for the real workspace surface — the sidebar arrives in
// M3 and the tab bar / data grid in M4. Proves the shell's screen switching:
// active workspace → this; no active workspace → ConnectScreen.

import { BTLogo } from "../../../shared/ui/BTLogo";
import { EnvTag } from "../../../shared/ui/EnvTag";
import type { Workspace } from "../types";
import "./WorkspacePlaceholder.css";

export function WorkspacePlaceholder({ workspace }: { workspace: Workspace }) {
  return (
    <div className="ws-placeholder">
      {/* Logo tinted with the workspace color so auto-assignment is visible. */}
      <BTLogo size={46} accent={workspace.color} />
      <div className="ws-placeholder-name">
        {workspace.name}
        <EnvTag env={workspace.connection.env} />
      </div>
      <div className="ws-placeholder-hint">{workspace.connection.detail}</div>
    </div>
  );
}
