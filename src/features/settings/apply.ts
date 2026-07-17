// applySettings — writes the full settings contract onto :root as inline CSS
// variables plus body classes, exactly as the prototype's `apply()` does. The
// whole app already consumes these tokens (--bg0..3, --accent, --mono, --ui,
// --editor-fs, --grid-fs, --grid-row-h), so a theme swap repaints everything
// through variables alone — no per-component theming.
//
// Inline vars on documentElement deliberately override the static charcoal
// defaults in tokens.css (inline style beats a selector), which is what lets
// twelve arbitrary palettes + a free-form hex accent work without a CSS block
// per theme.

import { invoke } from "@tauri-apps/api/core";

import { DEFAULTS, type Settings } from "./api";
import { monoMetaFor, THEMES, UI_FONTS } from "./catalogs";
import { ensureFont } from "./fonts";

/** localStorage key holding the resolved accent hex for the pre-JS splash
 *  (read by the inline bootstrap script in index.html). */
const SPLASH_ACCENT_KEY = "bytetable.splash-accent.v1";

/** localStorage key holding the resolved surface colors (+ light flag) for the
 *  pre-JS splash, so its background/text follow a light theme too. */
const SPLASH_THEME_KEY = "bytetable.splash-theme.v1";

export function applySettings(input: Partial<Settings> | null | undefined): void {
  const s: Settings = { ...DEFAULTS, ...(input ?? {}) };
  const theme = THEMES[s.theme] ?? THEMES.charcoal;
  const root = document.documentElement.style;

  // Palette.
  root.setProperty("--bg0", theme.bg0);
  root.setProperty("--bg1", theme.bg1);
  root.setProperty("--bg2", theme.bg2);
  root.setProperty("--bg3", theme.bg3);
  root.setProperty("--border", theme.border);
  root.setProperty("--text", theme.text);
  root.setProperty("--text-dim", theme.dim);
  root.setProperty("--text-faint", theme.faint);
  root.setProperty("--danger", theme.danger);
  // Keep the legacy --error token (tokens.css) in step with --danger so engine
  // surfaces that reference --error follow the theme too.
  root.setProperty("--error", theme.danger);

  // Accent: a custom hex overrides the theme's own; "auto" uses the theme's.
  const custom = s.accent && s.accent !== "auto";
  const accent = custom ? s.accent : theme.accent;
  root.setProperty("--accent", accent);
  root.setProperty("--on-accent", custom ? (theme.light ? "#ffffff" : "#0c1512") : theme.onAccent);

  // Persist the RESOLVED accent so the next launch's inline splash (painted
  // before any JS/CSS loads, see index.html) can tint its logo + wordmark to
  // the user's accent instead of the hardcoded default.
  try {
    localStorage.setItem(SPLASH_ACCENT_KEY, accent);
    // Also persist the resolved surface colors so the splash background / text /
    // bar follow a light theme instead of the hardcoded dark defaults.
    localStorage.setItem(
      SPLASH_THEME_KEY,
      JSON.stringify({
        bg: theme.bg0,
        gradA: theme.bg2,
        gradB: theme.bg0,
        text: theme.text,
        dim: theme.dim,
        bar: theme.bg3,
        light: !!theme.light,
      }),
    );
  } catch {
    // Storage disabled/full — the splash just falls back to its dark defaults.
  }

  // Fonts. Bundled families (JetBrains Mono, IBM Plex Sans) and system faces
  // load with no network; a non-bundled curated pick injects its Google Fonts
  // <link> once (the milestone's sanctioned network exception).
  const mono = monoMetaFor(s.monoFont);
  const ui = UI_FONTS[s.uiFont] ?? UI_FONTS.plexSans;
  ensureFont(mono.google);
  ensureFont(ui.google);
  root.setProperty("--mono", mono.stack);
  root.setProperty("--ui", ui.stack);

  // Sizes. The editor/grid keep a FIXED base (13 / 12 px); the font-size
  // setting now scales the WHOLE app via the webview zoom (see zoom.ts), so all
  // text — chrome included — grows/shrinks together. Keeping a fixed base here
  // means the zoom doesn't double-scale these surfaces.
  root.setProperty("--editor-fs", "13px");
  root.setProperty("--grid-fs", "12px");
  root.setProperty("--grid-row-h", `${s.density === "comfortable" ? 32 : 26}px`);

  // Body-class hooks. Guarded: bootstrap may apply before <body> exists, in
  // which case the pre-mount class state is re-applied once the store loads.
  const body = document.body;
  if (body) {
    body.classList.toggle("bt-liga", s.ligatures);
    body.classList.toggle("bt-reduce-motion", s.reduceMotion);
    body.classList.toggle("bt-no-rowhover", !s.highlightRow);
    body.classList.toggle("bt-light", !!theme.light);
    body.classList.toggle("bt-sidebar-right", s.sidebarSide === "right");
    body.dataset.titlebarPosition = s.titlebarPosition;
    body.dataset.macChrome = s.macChrome;
  }

  // macOS chrome: ask the backend to (re)apply window decorations for the
  // selected mode. Idempotent and macOS-gated in Rust; best-effort so it
  // no-ops in plain browser dev / before the shell is ready.
  void invoke("set_mac_chrome", { mode: s.macChrome }).catch(() => {});
}
