// Read-only-workspace context + hooks — split from ReadOnlyProvider.tsx so
// component files export only components (react-refresh).
//
// Why a context and not a prop: "this workspace cannot be written to" is a
// property of the whole session, needed by surfaces at every depth — the grid's
// save bar, a row's context menu, a drop-table modal's trigger, the structure
// editor's Apply. Prop-drilling it the way `isProduction` is drilled would mean
// touching every component between the shell and each affordance, and a single
// missed hop would silently re-enable a write button.
//
// The provider sits once in `App.tsx`, around whichever workspace shell is
// active, so schema sub-workspaces (M32) are covered by the same wrapper — they
// share the parent's connection and its `readOnly` flag.
//
// This is a UI concern only. The refusal that matters is the backend's
// (`src-tauri/src/shared/readonly.rs`), which this cannot bypass or weaken.

import { createContext, useContext } from "react";

export const ReadOnlyContext = createContext(false);

/**
 * Whether the surrounding workspace is read-only. `false` outside any provider
 * (the connect screen, the dev gallery), so a component can call this
 * unconditionally.
 */
export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
