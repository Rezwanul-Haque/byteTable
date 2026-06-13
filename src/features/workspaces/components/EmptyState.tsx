// Quiet placeholder filling the workspace content area until the M4 tab
// system lands (replaces M2's WorkspacePane — the sidebar shows workspace
// identity and the real table list now). Not in the prototype, so the
// styling is free-form but token-driven and deliberately faint.

import { BTLogo } from "../../../shared/ui/BTLogo";
import "./EmptyState.css";

export function EmptyState() {
  return (
    <div className="empty-state">
      <BTLogo size={44} accent="currentColor" fg="currentColor" />
      <p className="empty-state-text">Open a table to browse data — tabs arrive in M4</p>
    </div>
  );
}
