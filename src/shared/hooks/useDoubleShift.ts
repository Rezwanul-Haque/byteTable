// Double-tap Shift opens the command palette — the IntelliJ "Search
// Everywhere" gesture, offered alongside ⌘K.
//
// One hook rather than a copy per workspace: the SQL and Redis workspaces each
// own their own palette state, and a gesture this easy to get subtly wrong
// should not drift between them.
//
// Why releases and not presses: holding Shift fires keydown over and over, so
// counting taps means watching keyup. The machine also tracks whether a press
// was CLEAN — nothing else pressed while Shift was down — which is what tells
// two deliberate taps apart from the Shift in ⇧A or ⌘⇧P. Typing a capital
// clears the flag on the letter's keydown, so that release never counts.
//
// The machine is split out from the hook and kept pure so those cases can be
// tested without a DOM (there is no renderer test environment in this repo).

import { useEffect, useRef } from "react";

/** How long the second tap has to land. Matches IntelliJ's feel. */
const WINDOW_MS = 400;

/** Tap-tracking state. Opaque to callers — thread it, don't read it. */
export interface ShiftTaps {
  /** Shift is down and nothing else has been pressed since it went down. */
  readonly clean: boolean;
  /**
   * When the last clean tap ended. 0 means "none banked" — a real timestamp is
   * never 0, and the sentinel must be checked rather than subtracted from, or a
   * tap in the first 400ms after load would read as the second half of a pair.
   */
  readonly lastTap: number;
}

/** The starting state, and the state to return to after firing. */
export const NO_SHIFT_TAPS: ShiftTaps = { clean: false, lastTap: 0 };

/** The slice of `KeyboardEvent` the machine reads. */
export interface ShiftTapEvent {
  type: "keydown" | "keyup";
  key: string;
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  timeStamp: number;
}

/**
 * Advance the machine by one key event. `fired` is true exactly on the release
 * that completes a double-tap; the state resets with it, so a third tap starts
 * over rather than firing again.
 */
export function trackShiftTaps(
  state: ShiftTaps,
  event: ShiftTapEvent,
): { state: ShiftTaps; fired: boolean } {
  if (event.type === "keydown") {
    if (event.key !== "Shift") {
      // Shift is being used as a modifier, so this is no tap — and it breaks
      // any tap already banked: the gesture is two BARE taps in a row.
      return { state: NO_SHIFT_TAPS, fired: false };
    }
    // Auto-repeat while held — the first keydown already decided.
    if (event.repeat) return { state, fired: false };
    const clean = !(event.metaKey || event.ctrlKey || event.altKey);
    return { state: { clean, lastTap: clean ? state.lastTap : 0 }, fired: false };
  }
  if (event.key !== "Shift" || !state.clean) return { state, fired: false };
  if (state.lastTap !== 0 && event.timeStamp - state.lastTap <= WINDOW_MS) {
    return { state: NO_SHIFT_TAPS, fired: true };
  }
  return { state: { clean: false, lastTap: event.timeStamp }, fired: false };
}

/**
 * Call `open` when Shift is tapped twice in quick succession, while `enabled`.
 *
 * Open-only, never a toggle: callers pass `enabled: false` while the palette is
 * up, so a double Shift typed into its own search field cannot dismiss it.
 *
 * `open` is read from a ref, so a caller may pass a fresh closure each render
 * without the listeners being torn down and re-added every time.
 */
export function useDoubleShift(enabled: boolean, open: () => void): void {
  const openRef = useRef(open);
  // Synced in an effect, not during render — the same reasoning as
  // useFilterShortcut: only a key handler reads it, and that cannot run
  // mid-render.
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!enabled) return;
    let taps = NO_SHIFT_TAPS;
    const onKey = (event: KeyboardEvent) => {
      const next = trackShiftTaps(taps, event as ShiftTapEvent);
      taps = next.state;
      if (next.fired) openRef.current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [enabled]);
}
