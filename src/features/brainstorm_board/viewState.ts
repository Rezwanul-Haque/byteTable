// Per-tab board view state that has to survive the tab UNMOUNTING (M37 Task 11).
//
// The workspace mounts only the ACTIVE tab, so everything a board holds in local
// component state is thrown away on a tab switch. The document is fine — it is
// persisted — but where you were looking, what you had selected and which layer
// you had isolated are not, and losing them on every switch makes the board
// feel like it resets.
//
// This is deliberately NOT on the workspace's `ui`: the view changes on every
// frame of a pan, and the WorkspaceUiState churn rule keeps high-frequency state
// out of there. It is also deliberately not a zustand store — nothing subscribes
// to it. The board reads it once on mount and writes through on change, so a
// plain module map is the whole requirement.
//
// A closed tab leaves a stale entry of a few numbers behind, which is harmless
// (the same call the tabMeta seam makes for grid scroll offsets).

import type { BoardSelection, BoardView, LayerFocus } from "./model";
import type { ToolId } from "./tools";

export interface BoardViewState {
  view: BoardView;
  selection: BoardSelection;
  activeLayer: LayerFocus;
  tool: ToolId;
  inspectorOpen: boolean;
  /** False until the board has fitted once, so returning to the tab does not
   *  re-fit over a view the user panned away from. */
  fitted: boolean;
}

/** Window width at or above which the inspector starts open. Below it the
 *  canvas needs the room more than the panel does. */
const INSPECTOR_BREAKPOINT = 1280;

const states = new Map<string, BoardViewState>();

/** The remembered state for a board tab, or undefined on first mount. */
export function readBoardViewState(tabId: string): BoardViewState | undefined {
  return states.get(tabId);
}

/** Remember a board tab's view state (merged into whatever is there). */
export function writeBoardViewState(tabId: string, patch: Partial<BoardViewState>): void {
  const current = states.get(tabId);
  states.set(tabId, { ...(current ?? defaultBoardViewState()), ...patch });
}

/** What a board opens with: zoomed slightly out, nothing selected, all layers. */
export function defaultBoardViewState(): BoardViewState {
  return {
    view: { x: 40, y: 30, k: 0.78 },
    selection: { ids: [], edge: null },
    activeLayer: "all",
    tool: "select",
    inspectorOpen: window.innerWidth >= INSPECTOR_BREAKPOINT,
    fitted: false,
  };
}
