// Font loading + system-font probing for the Fonts & text tab (M20.4).
//
// Local-first policy: the base UI/editor fonts (IBM Plex Sans, JetBrains Mono)
// are bundled via @fontsource and never hit the network. The *other* curated
// families load on demand through a Google Fonts <link> — the one network
// exception the milestone sanctions ("zero network beyond Google Fonts
// <link>s"). System faces (`sys:<Family>`) are already installed, so they need
// no load at all.

// Google CSS2 family strings that are already bundled (@fontsource) — never
// inject a network <link> for these.
const BUNDLED_GOOGLE = new Set([
  "JetBrains+Mono:wght@400;500;600",
  "IBM+Plex+Sans:wght@400;500;600",
]);

const injected = new Set<string>();

/** Inject a Google Fonts stylesheet <link> once per family. No-op for bundled
 *  families, `null` (system stacks), or already-injected ones. */
export function ensureFont(googleFamily: string | null): void {
  if (!googleFamily || injected.has(googleFamily) || BUNDLED_GOOGLE.has(googleFamily)) return;
  injected.add(googleFamily);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${googleFamily}&display=swap`;
  document.head.appendChild(link);
}

// Common monospace faces shipped with macOS / Windows / Linux — canvas-probed
// for availability. Ported from settings.js SYSTEM_MONO_CANDIDATES.
const SYSTEM_MONO_CANDIDATES = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "Andale Mono",
  "Courier New",
  "Courier",
  "Consolas",
  "Cascadia Code",
  "Cascadia Mono",
  "Lucida Console",
  "Lucida Sans Typewriter",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Ubuntu Mono",
  "Noto Sans Mono",
  "Noto Mono",
  "FreeMono",
  "Inconsolata",
  "Hack",
  "Fira Mono",
  "PT Mono",
  "Anonymous Pro",
  "Droid Sans Mono",
  "Cousine",
  "Operator Mono",
  "Victor Mono",
  "IBM Plex Mono",
];

let probeCtx: CanvasRenderingContext2D | null = null;

/** Canvas width-probe: a font is "available" if it renders metrically
 *  different from a generic baseline. */
export function isFontAvailable(family: string): boolean {
  if (!probeCtx) probeCtx = document.createElement("canvas").getContext("2d");
  const ctx = probeCtx;
  if (!ctx) return false;
  const test = "mmmmmmmmmmlliWO0o1234567890_=>!";
  const size = "72px ";
  const measure = (f: string): number => {
    ctx.font = size + f;
    return ctx.measureText(test).width;
  };
  const baseMono = measure("monospace");
  const baseSans = measure("sans-serif");
  const withMono = measure(`'${family}', monospace`);
  const withSans = measure(`'${family}', sans-serif`);
  return withMono !== baseMono || withSans !== baseSans;
}

let sysCache: string[] | null = null;

/** Probe the installed monospace faces once (cheap, synchronous, no permission). */
export function detectSystemMonos(): string[] {
  if (sysCache) return sysCache;
  try {
    sysCache = SYSTEM_MONO_CANDIDATES.filter(isFontAvailable);
  } catch {
    sysCache = [];
  }
  return sysCache;
}
