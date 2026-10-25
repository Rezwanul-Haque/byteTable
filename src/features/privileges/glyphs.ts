// The matrix glyph language (M39), in ONE place.
//
// It lived in two places first — the grid and the cell menu each had their own
// map — and they disagreed: the grid drew a hollow `○` for access derived from
// a wider grant while the menu drew a solid `●` for the same cell, so the
// matrix said "off" and the menu said "Granted".
//
// The fix is not just sharing the table. Fill must mean ONE thing: **held**.
// Hollow reads as off/unselected in every interface convention, so using it for
// "granted, but through a wider grant" inverted the most basic reading of the
// grid. Derivation is a secondary fact and gets a secondary cue — colour and a
// dotted underline (see `.priv-mc.wild`) — never the fill.

import type { PrivilegeState } from "./api";

/** The glyph for a state. Fill means held; nothing else modifies it. */
export const STATE_GLYPH: Record<PrivilegeState, string> = {
  /** Not held. */
  none: "—",
  /** Held. */
  granted: "●",
  /** Held, and can be passed on (`WITH GRANT OPTION`). */
  grantable: "◎",
  /** Explicitly refused. */
  denied: "✕",
};
