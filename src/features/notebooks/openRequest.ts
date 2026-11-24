// Asking the workspace on screen to open a notebook path (File ▸ Open recent).
// The command bus carries no payload, so this is a window event; a module of
// its own so the menu builder does not import the notebooks' file layer.

export const OPEN_NOTEBOOK_EVENT = "bytetable:open-notebook";

export function requestOpenNotebook(path: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_NOTEBOOK_EVENT, { detail: path }));
}
