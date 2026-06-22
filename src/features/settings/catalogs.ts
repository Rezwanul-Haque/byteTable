// Settings catalogs (M20): the theme palettes, accent presets, and font
// stacks. Ported verbatim from the prototype's `settings.js` so colors,
// stacks, and ids stay pixel- and contract-identical. The renderer owns these
// values; the Rust domain only round-trips the chosen ids.

/** A full theme palette. `light` flips the `.bt-light` body class. */
export interface Theme {
  label: string;
  group: "ByteTable" | "Editor" | "Light";
  bg0: string;
  bg1: string;
  bg2: string;
  bg3: string;
  border: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  danger: string;
  onAccent: string;
  light?: boolean;
}

export type ThemeId =
  | "charcoal"
  | "midnight"
  | "slate"
  | "oneDark"
  | "dracula"
  | "nord"
  | "tokyoNight"
  | "monokai"
  | "solarized"
  | "gruvbox"
  | "githubDark"
  | "daybreak"
  | "parchment"
  | "sky";

// One full palette per theme. Order is the display order in the Appearance tab.
export const THEMES: Record<ThemeId, Theme> = {
  charcoal: {
    label: "Charcoal",
    group: "ByteTable",
    bg0: "#131418",
    bg1: "#191b20",
    bg2: "#20232a",
    bg3: "#282c35",
    border: "#2c3039",
    text: "#e3e6eb",
    dim: "#9aa1ad",
    faint: "#5d6470",
    accent: "#2dd4a7",
    danger: "#e06c75",
    onAccent: "#0c1512",
  },
  midnight: {
    label: "Midnight",
    group: "ByteTable",
    bg0: "#0b0b0d",
    bg1: "#111114",
    bg2: "#17171c",
    bg3: "#1f1f26",
    border: "#232329",
    text: "#e3e6eb",
    dim: "#9aa1ad",
    faint: "#5d6470",
    accent: "#2dd4a7",
    danger: "#e06c75",
    onAccent: "#0c1512",
  },
  slate: {
    label: "Slate",
    group: "ByteTable",
    bg0: "#1d2026",
    bg1: "#23262e",
    bg2: "#2b2f39",
    bg3: "#343945",
    border: "#383e4b",
    text: "#e3e6eb",
    dim: "#9aa1ad",
    faint: "#5d6470",
    accent: "#2dd4a7",
    danger: "#e06c75",
    onAccent: "#0c1512",
  },
  oneDark: {
    label: "One Dark",
    group: "Editor",
    bg0: "#21252b",
    bg1: "#282c34",
    bg2: "#2c313a",
    bg3: "#3a3f4b",
    border: "#3a3f4b",
    text: "#abb2bf",
    dim: "#828997",
    faint: "#5c6370",
    accent: "#61afef",
    danger: "#e06c75",
    onAccent: "#08121d",
  },
  dracula: {
    label: "Dracula",
    group: "Editor",
    bg0: "#1e1f29",
    bg1: "#282a36",
    bg2: "#343746",
    bg3: "#424458",
    border: "#3b3d4d",
    text: "#f8f8f2",
    dim: "#bcbcd0",
    faint: "#6272a4",
    accent: "#bd93f9",
    danger: "#ff5555",
    onAccent: "#1a1326",
  },
  nord: {
    label: "Nord",
    group: "Editor",
    bg0: "#242933",
    bg1: "#2e3440",
    bg2: "#3b4252",
    bg3: "#434c5e",
    border: "#3b4252",
    text: "#eceff4",
    dim: "#d8dee9",
    faint: "#7b88a1",
    accent: "#88c0d0",
    danger: "#bf616a",
    onAccent: "#0e1f25",
  },
  tokyoNight: {
    label: "Tokyo Night",
    group: "Editor",
    bg0: "#16161e",
    bg1: "#1a1b26",
    bg2: "#1f2335",
    bg3: "#292e42",
    border: "#252a3f",
    text: "#c0caf5",
    dim: "#9aa5ce",
    faint: "#565f89",
    accent: "#7aa2f7",
    danger: "#f7768e",
    onAccent: "#0a1124",
  },
  monokai: {
    label: "Monokai",
    group: "Editor",
    bg0: "#1d1e19",
    bg1: "#272822",
    bg2: "#31322c",
    bg3: "#3e3f38",
    border: "#3a3b34",
    text: "#f8f8f2",
    dim: "#c9c9bf",
    faint: "#75715e",
    accent: "#a6e22e",
    danger: "#f92672",
    onAccent: "#15200a",
  },
  solarized: {
    label: "Solarized",
    group: "Editor",
    bg0: "#002b36",
    bg1: "#073642",
    bg2: "#0a4250",
    bg3: "#14515f",
    border: "#0e4b59",
    text: "#93a1a1",
    dim: "#839496",
    faint: "#586e75",
    accent: "#2aa198",
    danger: "#dc322f",
    onAccent: "#00211a",
  },
  gruvbox: {
    label: "Gruvbox",
    group: "Editor",
    bg0: "#1d2021",
    bg1: "#282828",
    bg2: "#32302f",
    bg3: "#3c3836",
    border: "#3c3836",
    text: "#ebdbb2",
    dim: "#bdae93",
    faint: "#7c6f64",
    accent: "#b8bb26",
    danger: "#fb4934",
    onAccent: "#1d2021",
  },
  githubDark: {
    label: "GitHub Dark",
    group: "Editor",
    bg0: "#0d1117",
    bg1: "#161b22",
    bg2: "#1c2128",
    bg3: "#262c36",
    border: "#30363d",
    text: "#e6edf3",
    dim: "#adbac7",
    faint: "#768390",
    accent: "#2f81f7",
    danger: "#f85149",
    onAccent: "#02132e",
  },
  daybreak: {
    label: "Daybreak",
    group: "Light",
    bg0: "#ffffff",
    bg1: "#f6f7f9",
    bg2: "#eef0f3",
    bg3: "#e3e6ea",
    border: "#d8dce1",
    text: "#1c2430",
    dim: "#5a6573",
    faint: "#9aa3b0",
    accent: "#0a8f6b",
    danger: "#d23f54",
    onAccent: "#ffffff",
    light: true,
  },
  parchment: {
    label: "Parchment",
    group: "Light",
    bg0: "#faf8f3",
    bg1: "#f3efe6",
    bg2: "#ece6d8",
    bg3: "#e1dac8",
    border: "#ddd5c2",
    text: "#3a3326",
    dim: "#6b6151",
    faint: "#9c917c",
    accent: "#b8742a",
    danger: "#c0392b",
    onAccent: "#ffffff",
    light: true,
  },
  sky: {
    label: "Sky",
    group: "Light",
    bg0: "#ffffff",
    bg1: "#f4f7fb",
    bg2: "#e9eef6",
    bg3: "#dbe4f0",
    border: "#d2dcea",
    text: "#1b2533",
    dim: "#54627a",
    faint: "#93a0b5",
    accent: "#2f6df0",
    danger: "#d23f54",
    onAccent: "#ffffff",
    light: true,
  },
};

// Curated accent overrides. `"auto"` = use the active theme's own accent.
export const ACCENTS = [
  "auto",
  "#2dd4a7",
  "#5aa7f5",
  "#b08cff",
  "#f5b54a",
  "#f7768e",
  "#e5734f",
] as const;

/** A curated web/system font. `liga` marks fonts with programming ligatures. */
export interface FontMeta {
  label: string;
  stack: string;
  /** Google CSS2 family string (weights appended). `null` for bundled/system. */
  google: string | null;
  liga: boolean;
  /** True when resolved from a probed `sys:<Family>` id rather than the catalog. */
  system?: boolean;
}

export type MonoFontId = "jetbrains" | "fira" | "plex" | "source" | "roboto" | "system";

// Monospace faces for the editor + data grid. JetBrains Mono is bundled
// (@fontsource); the others are catalog entries the picker can offer in 20.4.
export const MONO_FONTS: Record<MonoFontId, FontMeta> = {
  jetbrains: {
    label: "JetBrains Mono",
    stack: "'JetBrains Mono', ui-monospace, monospace",
    google: "JetBrains+Mono:wght@400;500;600",
    liga: true,
  },
  fira: {
    label: "Fira Code",
    stack: "'Fira Code', ui-monospace, monospace",
    google: "Fira+Code:wght@400;500;600",
    liga: true,
  },
  plex: {
    label: "IBM Plex Mono",
    stack: "'IBM Plex Mono', ui-monospace, monospace",
    google: "IBM+Plex+Mono:wght@400;500;600",
    liga: false,
  },
  source: {
    label: "Source Code Pro",
    stack: "'Source Code Pro', ui-monospace, monospace",
    google: "Source+Code+Pro:wght@400;500;600",
    liga: false,
  },
  roboto: {
    label: "Roboto Mono",
    stack: "'Roboto Mono', ui-monospace, monospace",
    google: "Roboto+Mono:wght@400;500;600",
    liga: false,
  },
  system: {
    label: "System Mono",
    stack: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Cascadia Code', monospace",
    google: null,
    liga: true,
  },
};

export type UiFontId = "plexSans" | "system" | "jakarta" | "publicSans";

// UI (chrome) fonts. IBM Plex Sans is bundled (@fontsource).
export const UI_FONTS: Record<UiFontId, FontMeta> = {
  plexSans: {
    label: "IBM Plex Sans",
    stack: "'IBM Plex Sans', system-ui, sans-serif",
    google: "IBM+Plex+Sans:wght@400;500;600",
    liga: false,
  },
  system: {
    label: "System UI",
    stack: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    google: null,
    liga: false,
  },
  jakarta: {
    label: "Plus Jakarta",
    stack: "'Plus Jakarta Sans', system-ui, sans-serif",
    google: "Plus+Jakarta+Sans:wght@400;500;600",
    liga: false,
  },
  publicSans: {
    label: "Public Sans",
    stack: "'Public Sans', system-ui, sans-serif",
    google: "Public+Sans:wght@400;500;600",
    liga: false,
  },
};

/**
 * Resolve a mono-font id to its metadata. Accepts a curated key or a probed
 * `"sys:<Family>"` id (canvas-detected system face, 20.4). Falls back to
 * JetBrains Mono for an unknown id.
 */
export function monoMetaFor(id: string): FontMeta {
  if (id.startsWith("sys:")) {
    const fam = id.slice(4);
    return {
      label: fam,
      stack: `'${fam}', ui-monospace, monospace`,
      google: null,
      liga: false,
      system: true,
    };
  }
  return MONO_FONTS[id as MonoFontId] ?? MONO_FONTS.jetbrains;
}
