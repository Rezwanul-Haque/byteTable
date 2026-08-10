// Pre-mount settings apply. Imported for its side effect by main.tsx *before*
// createRoot, so the saved palette/fonts/sizes paint the very first frame and
// there is no flash of the default theme (M20.1 "apply before mount").
//
// This runs synchronously off the localStorage fast-path only — the Tauri disk
// mirror is reconciled asynchronously once the store loads (state.ts). On a
// fresh profile with no cache, DEFAULTS apply, which matches tokens.css, so the
// first frame is correct either way.

import { initialSettings } from "./api";
import { applySettings } from "./apply";
import { readCachedSettings } from "./cache";

// M31: the language is applied here too, so the first painted frame is already
// in the right language and direction — no flash of English, no layout flip.
applySettings(readCachedSettings() ?? initialSettings());
