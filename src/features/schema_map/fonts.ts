// Font embedding for the schema-map export (M9 Task 3).
//
// WHY: a standalone export SVG (opened on its own, or drawn to a <canvas> to
// rasterise a PNG) has NO access to the app's loaded webfonts. Diagram <text>
// would fall back to a system font — drifting metrics, wrong look. We fix this
// by embedding the actual woff2 bytes as base64 `@font-face` data: URIs in the
// export SVG's <defs><style>. Data URIs keep the SVG self-contained, so the
// canvas stays untainted and PNG export works.
//
// WHICH FONTS: the diagram text uses JetBrains Mono (table names, columns,
// types) and IBM Plex Sans (the SVG's default ui font fallback). We embed
// weight 400 + 600 of both, latin subset (the @fontsource "latin" woff2 files,
// the same ones the app loads). The four ICONS are NOT a font here — they are
// inline <path> shapes (see icons.ts), so the 5MB Material Symbols font is
// never embedded.
//
// The woff2 files are imported as URLs (Vite copies them to the build and gives
// a resolvable href in dev). We fetch + base64 them once on first export and
// cache the assembled CSS. If a fetch fails (e.g. offline/unexpected), we
// return "" and the export falls back to system fonts (documented last resort).

// @fontsource ships the per-weight latin woff2 we already load in main.tsx.
import ibmPlex400 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url";
import ibmPlex600 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2?url";
import jbMono400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url";
import jbMono600 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url";

interface FaceSpec {
  family: string;
  weight: number;
  url: string;
}

const FACES: FaceSpec[] = [
  { family: "IBM Plex Sans", weight: 400, url: ibmPlex400 },
  { family: "IBM Plex Sans", weight: 600, url: ibmPlex600 },
  { family: "JetBrains Mono", weight: 400, url: jbMono400 },
  { family: "JetBrains Mono", weight: 600, url: jbMono600 },
];

let cached: string | null = null;

/** Fetch a font URL and return its bytes as a base64 string. */
async function fetchBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  // Chunked base64 (btoa over a huge binary string can blow the call stack).
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Build (and cache) the `@font-face` CSS block embedding the diagram's text
 * fonts as base64 data: URIs. Returns "" if the fonts can't be loaded — the
 * export then falls back to system fonts (text renders but metrics drift).
 */
export async function embeddedFontFaceCss(): Promise<string> {
  if (cached !== null) return cached;
  try {
    const blocks = await Promise.all(
      FACES.map(async (f) => {
        const b64 = await fetchBase64(f.url);
        return (
          `@font-face{font-family:"${f.family}";font-style:normal;` +
          `font-weight:${f.weight};font-display:block;` +
          `src:url(data:font/woff2;base64,${b64}) format("woff2");}`
        );
      }),
    );
    cached = blocks.join("");
  } catch {
    cached = "";
  }
  return cached;
}
