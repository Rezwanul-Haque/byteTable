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

import { setLocale } from "../../shared/i18n";
import { DEFAULTS, type Settings } from "./api";
import { monoMetaFor, THEMES, UI_FONTS } from "./catalogs";
import { ensureFont } from "./fonts";
import { ensureLensDefs, supportsBackdropLens } from "./lens";
import { cachedWallpaperUrl, DEFAULT_WALLPAPER, resolveWallpaper } from "./wallpaper";

/** localStorage key holding the resolved accent hex for the pre-JS splash
 *  (read by the inline bootstrap script in index.html). */
const SPLASH_ACCENT_KEY = "bytetable.splash-accent.v1";

/** localStorage key holding the resolved surface colors (+ light flag) for the
 *  pre-JS splash, so its background/text follow a light theme too. */
const SPLASH_THEME_KEY = "bytetable.splash-theme.v1";

/**
 * Blend two `#rrggbb` colours in sRGB. The material backdrops derive their
 * blooms from the accent with `color-mix()`, but the splash is painted by an
 * inline script before a stylesheet exists — so the same tint has to be
 * computed here and stored as a literal. sRGB rather than oklab: it is two
 * dark colours and a boot screen, and this stays four lines. Returns `b`
 * unchanged if either side isn't a plain hex (a malformed accent must not
 * take the splash down).
 */
function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string): [number, number, number] | null => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const ca = parse(a);
  const cb = parse(b);
  if (!ca || !cb) return b;
  const ch = (i: number) => Math.round(cb[i]! + (ca[i]! - cb[i]!) * t);
  return "#" + [0, 1, 2].map((i) => ch(i).toString(16).padStart(2, "0")).join("");
}

/**
 * Liquid Glass's boot gradient — the splash and the connect screen behind it.
 *
 * It lives in TypeScript, unusually for a colour in this app, because it has to
 * reach two renderers that cannot share a stylesheet: `liquid.css` paints it
 * through `--lg-boot-grad` (written below), and index.html's splash paints it
 * before any stylesheet exists, off the copy persisted into SPLASH_THEME_KEY.
 * One literal, so they cannot drift — and they had: the splash approximated
 * this with a centred radial built from two of its stops, so boot → connect
 * jumped from a glow in the middle of the window to a diagonal wash.
 */
const LIQUID_BOOT_GRADIENT = [
  "radial-gradient(120% 90% at 15% 0%, rgba(20, 110, 130, 0.55), transparent 60%)",
  "radial-gradient(110% 90% at 100% 100%, rgba(30, 70, 140, 0.5), transparent 60%)",
  "linear-gradient(160deg, #0b3444 0%, #0c3f52 40%, #0f3557 75%, #10284a 100%)",
].join(", ");

/**
 * Frosted Glass's backdrop — four soft blooms over a deep base, painted on the
 * full-window boxes (body / #root / .bt-app-root) and, at boot, on the splash.
 *
 * Here rather than in glass.css for the reason LIQUID_BOOT_GRADIENT is: the
 * splash has to paint it before a stylesheet exists. The accent is baked in
 * instead of read through `var(--accent)` — the splash has no tokens yet —
 * which costs nothing, since applySettings re-runs on every accent change.
 *
 * The COLOURS are the material's own (indigo, cyan, violet, teal); the accent
 * is a tint mixed into each, strongest in the lead bloom and barely there in
 * the base. That order matters: letting the accent lead painted the whole
 * window one hue and lost the gradient. A custom accent should colour the room,
 * not become it. The nesting reads "tint the hue, then set the alpha"; oklab
 * keeps the tint even, so a dark or vivid accent shifts the wash without
 * muddying it.
 *
 * WIDE AND DIM, not small and bright. Every one of these hues is a pale, high
 * luminance pastel, so a tight bloom puts its hottest, most desaturated core
 * right on a window corner and the four of them read as white lights switched
 * on behind the glass rather than as a wash of colour. Each radius is therefore
 * far larger than the area it has to cover and each alpha low enough that only
 * the falloff is ever on screen — the composition (which hue sits in which
 * corner) is the prototype's, the intensity is not. Lowering an alpha only
 * darkens the composite behind the text, so the ≥4.5:1 body contrast the
 * milestone requires cannot regress here; raising one can.
 */
function glassBackdrop(accent: string): string {
  const bloom = (hue: string, tint: number, alpha: number) =>
    `color-mix(in oklab, color-mix(in oklab, ${accent} ${tint}%, ${hue}) ${alpha}%, transparent)`;
  return [
    `radial-gradient(1500px 950px at 8% -10%, ${bloom("#7c9cff", 32, 28)}, transparent 62%)`,
    `radial-gradient(1250px 820px at 100% 0%, ${bloom("#7cd5ff", 18, 19)}, transparent 62%)`,
    `radial-gradient(1250px 950px at 60% 110%, ${bloom("#b08cff", 22, 22)}, transparent 64%)`,
    `radial-gradient(1000px 700px at 0% 100%, ${bloom("#2dd4a7", 14, 13)}, transparent 62%)`,
    `color-mix(in oklab, ${accent} 6%, #0b1120)`,
  ].join(", ");
}

/** The bundled image as a CSS url(), for the first paint before anything is
 *  cached. */
function wallpaperFallback(): string {
  return `url("${DEFAULT_WALLPAPER}")`;
}

// --- reduced transparency: one class, two triggers ------------------------
// The CSS keys on `body.bt-reduce-transparency` rather than on the media query
// directly, so the rule list is written once and both the OS setting and the
// in-app toggle switch it. The OS side needs watching, not just reading: a
// user can flip it while the app is open.
const reduceTransparencyQuery =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-transparency: reduce)")
    : null;
let reduceTransparencySetting = DEFAULTS.reduceTransparency;

function applyReduceTransparency(body: HTMLElement): void {
  body.classList.toggle(
    "bt-reduce-transparency",
    reduceTransparencySetting || (reduceTransparencyQuery?.matches ?? false),
  );
}

reduceTransparencyQuery?.addEventListener("change", () => {
  if (document.body) applyReduceTransparency(document.body);
});

export function applySettings(input: Partial<Settings> | null | undefined): void {
  const s: Settings = { ...DEFAULTS, ...(input ?? {}) };
  const theme = THEMES[s.theme] ?? THEMES.charcoal;
  const root = document.documentElement.style;

  // The resolved theme id on <html>, written BEFORE the variables so the first
  // paint has both. Generic (every theme gets it), but only a MATERIAL theme
  // uses it today: its surface rules live in glass.css keyed on this attribute,
  // because blur / specular edge / depth cannot be expressed as palette values.
  // Switching away removes the rules with the attribute — no residue.
  document.documentElement.setAttribute("data-theme", THEMES[s.theme] ? s.theme : "charcoal");

  // A MATERIAL theme also gets `data-material`. The surface tiers are shared by
  // every material (they key on the attribute's presence); each material's own
  // rendering — frosted vs. lensed — keys on its value. A flat palette removes
  // the attribute, which removes every one of those rules with it.
  if (theme.material) document.documentElement.setAttribute("data-material", theme.material);
  else document.documentElement.removeAttribute("data-material");

  // --- Liquid Glass: wallpaper, lens, reduced transparency (M38) ----------
  // The wallpaper is a CSS variable, not a React-rendered <img>: the image must
  // not re-decode on every render, and body paints it before the app mounts.
  // Painted from the cache synchronously so the first frame has it, then
  // reconciled against what is actually on disk.
  const html = document.documentElement;
  if (theme.material === "liquid") {
    const cached = s.wallpaper === "none" ? "none" : (cachedWallpaperUrl() ?? wallpaperFallback());
    html.style.setProperty("--lg-wall", cached);
    void resolveWallpaper(s.wallpaper).then((url) => {
      // Only if the theme is still liquid — the user may have switched while
      // the backend round-trip was in flight.
      if (document.documentElement.getAttribute("data-material") === "liquid")
        document.documentElement.style.setProperty("--lg-wall", url);
    });
    html.style.setProperty("--lg-boot-grad", LIQUID_BOOT_GRADIENT);
    ensureLensDefs();
  } else {
    html.style.removeProperty("--lg-wall");
    html.style.removeProperty("--lg-boot-grad");
  }
  html.classList.toggle("bt-lg-nowall", theme.material === "liquid" && s.wallpaper === "none");
  // Edge refraction renders in Chromium only (WebView2); WKWebView and
  // WebKitGTK drop the whole `backdrop-filter` when it carries a url(), taking
  // the blur with it — so the class, not the CSS, decides.
  html.classList.toggle("bt-lg-refract", theme.material === "liquid" && supportsBackdropLens());

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

  // The frosted backdrop, rebuilt around the resolved accent. Written here
  // rather than declared in glass.css so the splash can persist the identical
  // string — see glassBackdrop(). Liquid gets it too and simply covers it with
  // the wallpaper; the rules that read it are attribute-scoped, so a flat
  // palette never sees the token at all.
  if (theme.material) root.setProperty("--glass-backdrop", glassBackdrop(accent));
  else root.removeProperty("--glass-backdrop");

  // Persist the RESOLVED accent so the next launch's inline splash (painted
  // before any JS/CSS loads, see index.html) can tint its logo + wordmark to
  // the user's accent instead of the hardcoded default.
  try {
    localStorage.setItem(SPLASH_ACCENT_KEY, accent);
    // Also persist the resolved surface colors so the splash background / text /
    // bar follow a light theme instead of the hardcoded dark defaults.
    // A material theme's surfaces are translucent, which would leave the splash
    // (painted before any backdrop exists) grey and flat, so it gets its own
    // backdrop's opaque colours instead — boot into the material, not charcoal,
    // and into the RIGHT one: the two materials run different backdrops (cold
    // navy vs. warm plum), and the splash is the first thing either shows.
    localStorage.setItem(
      SPLASH_THEME_KEY,
      JSON.stringify(
        theme.material === "liquid"
          ? {
              // Liquid Glass's splash is the connect screen's calm teal→blue,
              // NOT its wallpaper: the wallpaper only appears once a workspace
              // is open, and boot → connect must not jump colour. Fixed, not
              // accent-tinted, for the same reason — it has to match the
              // gradient `liquid.css` paints behind the connect screen.
              //
              // `grad` is that whole gradient, so the pre-JS splash paints it
              // exactly; gradA/gradB stay as the radial fallback for the first
              // ever launch on this theme, when nothing is persisted yet.
              grad: LIQUID_BOOT_GRADIENT,
              bg: "#0b3444",
              gradA: "#0c3f52",
              gradB: "#10284a",
              text: theme.text,
              dim: theme.dim,
              bar: "#17455c",
              light: false,
            }
          : theme.material
            ? {
                // The frosted backdrop itself, so boot → app does not jump from
                // a centred glow to the four corner blooms. The mixHex values
                // below stay: `bg` is the gradient's own base colour (what
                // shows if a webview cannot parse color-mix), `bar` tints the
                // progress track, and gradA/gradB are the radial fallback for
                // a first launch with nothing persisted.
                grad: glassBackdrop(accent),
                bg: mixHex(accent, "#0b1120", 0.06),
                gradA: mixHex(accent, "#18224a", 0.18),
                gradB: mixHex(accent, "#0b1120", 0.06),
                text: theme.text,
                dim: theme.dim,
                bar: mixHex(accent, "#18224a", 0.14),
                light: false,
              }
            : {
                bg: theme.bg0,
                gradA: theme.bg2,
                gradB: theme.bg0,
                text: theme.text,
                dim: theme.dim,
                bar: theme.bg3,
                light: !!theme.light,
              },
      ),
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
  // --ui-script (set by setLocale below) prepends the locale's script family,
  // so CJK / Bengali / Arabic UI text renders in its Noto face instead of
  // falling through to a system font. Order matters: the Latin UI font would
  // shadow the script font if it came first.
  root.setProperty("--ui", `var(--ui-script) ${ui.stack}`);

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
    // Reduced transparency has TWO triggers — the OS setting and the in-app
    // toggle (M38 Task 9) — and one class, so the (long) list of rules it
    // drives exists once instead of twice. The OS side is watched below.
    reduceTransparencySetting = s.reduceTransparency;
    applyReduceTransparency(body);
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

  // Language LAST (M31): it writes --ui-script, html[lang]/[dir] and body
  // .bt-rtl, then notifies its subscribers — which must see the fonts and
  // palette above already in place.
  setLocale(s.locale, { region: s.region, hour12: s.hour12, firstDay: s.firstDay });
}
