// Schema-map export (M9 Task 3, user request #1): build a clean, standalone
// SVG of the WHOLE diagram and rasterise it to PNG.
//
// ============================ DESIGN ============================
// The live canvas is one <svg> inside a pan/zoom <g>. Rather than serialise the
// live DOM (which carries view transforms, CSS-var colours that don't resolve
// standalone, and a webfont dependency), we re-emit a self-contained SVG from
// the same card/edge models with:
//
//   - a viewBox framed to the content bounding box (whole diagram, 1×, ignoring
//     pan/zoom) so nothing is clipped to the viewport;
//   - resolved literal colours (the live CSS uses var(--…) + color-mix(), which
//     are meaningless in a standalone file / when drawn to a canvas) — we read
//     the computed token values once and bake hex into the export;
//   - the dot-grid painted as an SVG <pattern> so the export looks like canvas;
//   - the four diagram icons drawn as inline <path> shapes (see icons.ts) — no
//     icon-font dependency;
//   - the text fonts (IBM Plex Sans + JetBrains Mono) embedded as base64
//     @font-face in <defs><style>, so <text> renders identically standalone and
//     when rasterised to PNG (otherwise the canvas falls back to a system font).
//
// TAINT-SAFETY: the export SVG references NO external URLs and NO
// <foreignObject> — every asset (fonts as data: URIs, icons as paths) is inline.
// An <img> loaded from such an SVG draws to a <canvas> WITHOUT tainting it, so
// canvas.toBlob('image/png') succeeds. This is why Task 2 chose SVG-native.

import { HEAD_H, ROW_H, contentBounds, type CardModel, type EdgeModel } from "./diagram";
import { ICON_KEY, ICON_LINK, ICON_OPEN, ICON_TABLE, type IconPath } from "./icons";
import { embeddedFontFaceCss } from "./fonts";

/** Literal colours baked into the export (CSS vars don't resolve standalone). */
export interface ExportColors {
  bg0: string;
  bg1: string;
  bg2: string;
  bg3: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  /** edge stroke (accent mixed toward border) */
  edge: string;
  /** target-ring fill (accent mixed toward bg0) */
  ring: string;
  /** dot-grid colour */
  grid: string;
}

/** Read the live token values off the document so the export stays on-theme. */
export function readExportColors(): ExportColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => {
    const raw = cs.getPropertyValue(name).trim();
    return raw || fallback;
  };
  const accent = v("--accent", "#2dd4a7");
  const border = v("--border", "#2c3039");
  const bg0 = v("--bg0", "#131418");
  return {
    bg0,
    bg1: v("--bg1", "#191b20"),
    bg2: v("--bg2", "#20232a"),
    bg3: v("--bg3", "#282c35"),
    border,
    text: v("--text", "#e3e6eb"),
    textDim: v("--text-dim", "#9aa1ad"),
    textFaint: v("--text-faint", "#5d6470"),
    accent,
    // color-mix() can't be relied on in a standalone file; approximate the live
    // mixes with opacity (the stroke/ring read identically against bg).
    edge: accent,
    ring: bg0,
    grid: border,
  };
}

const MONO = "JetBrains Mono, ui-monospace, monospace";
const UI = "IBM Plex Sans, system-ui, sans-serif";

/** XML-escape a text node value. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Render one inline icon path at (x,y) scaled from its 24-box to `size`px. */
function iconSvg(icon: IconPath, x: number, y: number, size: number, fill: string): string {
  const s = size / 24;
  return `<path d="${icon.d}" fill="${fill}" transform="translate(${x} ${y}) scale(${s})"/>`;
}

/** One card → SVG markup, positioned in world coords. */
function cardSvg(card: CardModel, c: ExportColors): string {
  const { x, y, w, h, shownColumns, hiddenCount } = card;
  const parts: string[] = [];
  parts.push(`<g transform="translate(${x} ${y})">`);
  // body
  parts.push(
    `<rect x="0" y="0" width="${w}" height="${h}" rx="11" fill="${c.bg1}" stroke="${c.border}" stroke-width="1" filter="url(#cardShadow)"/>`,
  );
  // header background (rounded top, square bottom) + hairline rule
  parts.push(
    `<path d="M0 11a11 11 0 0 1 11-11h${w - 22}a11 11 0 0 1 11 11v${HEAD_H - 11}H0Z" fill="${c.bg2}"/>`,
  );
  parts.push(
    `<line x1="0" y1="${HEAD_H}" x2="${w}" y2="${HEAD_H}" stroke="${c.border}" stroke-width="1"/>`,
  );
  // table icon (14px) — vertically centred in header
  parts.push(iconSvg(ICON_TABLE, 8, HEAD_H / 2 - 7, 14, c.accent));
  // table name
  parts.push(
    `<text x="30" y="${HEAD_H / 2}" dominant-baseline="central" font-family="${MONO}" font-size="12" font-weight="600" fill="${c.text}">${esc(truncate(card.table, 18))}</text>`,
  );
  // open-in-new icon (13px)
  parts.push(iconSvg(ICON_OPEN, w - 20.5, HEAD_H / 2 - 6.5, 13, c.textFaint));

  // column rows
  shownColumns.forEach((col, i) => {
    const ry = HEAD_H + 4 + i * ROW_H;
    const cy = ry + ROW_H / 2;
    if (col.pk) {
      parts.push(iconSvg(ICON_KEY, 4, cy - 5.5, 11, c.accent));
    } else if (col.fk) {
      parts.push(iconSvg(ICON_LINK, 4, cy - 5.5, 11, c.textDim));
    }
    parts.push(
      `<text x="26" y="${cy}" dominant-baseline="central" font-family="${MONO}" font-size="11" fill="${col.fk ? c.text : c.textDim}">${esc(truncate(col.name, 16))}</text>`,
    );
    parts.push(
      `<text x="${w - 10}" y="${cy}" text-anchor="end" dominant-baseline="central" font-family="${MONO}" font-size="9" fill="${c.textFaint}">${esc(truncate(col.dataType.toLowerCase(), 12))}</text>`,
    );
  });
  if (hiddenCount > 0) {
    const cy = HEAD_H + 4 + shownColumns.length * ROW_H + ROW_H / 2;
    parts.push(
      `<text x="26" y="${cy}" dominant-baseline="central" font-family="${MONO}" font-size="11" font-style="italic" fill="${c.textFaint}">+ ${hiddenCount} more columns…</text>`,
    );
  }
  parts.push(`</g>`);
  return parts.join("");
}

/** One FK edge → SVG markup (path + source dot + target ring). */
function edgeSvg(edge: EdgeModel, c: ExportColors): string {
  return (
    `<path d="${edge.path}" fill="none" stroke="${c.edge}" stroke-width="1.5" stroke-opacity="0.65"/>` +
    `<circle cx="${edge.sx}" cy="${edge.sy}" r="3.5" fill="${c.accent}"/>` +
    `<circle cx="${edge.tx}" cy="${edge.ty}" r="5" fill="${c.bg0}" stroke="${c.accent}" stroke-width="1"/>` +
    `<circle cx="${edge.tx}" cy="${edge.ty}" r="2" fill="${c.accent}"/>`
  );
}

/**
 * Build the standalone export SVG string for the whole diagram. `fontCss` is
 * the embedded @font-face block (data: URIs); pass "" to fall back to system
 * fonts (last-resort — text drifts but still renders). Marker is unused; the
 * direction cue is the source dot + target ring like the live canvas.
 */
export function buildExportSvg(
  cards: CardModel[],
  edges: EdgeModel[],
  colors: ExportColors,
  fontCss: string,
): string {
  const b = contentBounds(cards, 48);
  const GRID = 22;
  const body =
    edges.map((e) => edgeSvg(e, colors)).join("") + cards.map((c) => cardSvg(c, colors)).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(b.width)}" height="${Math.round(b.height)}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" font-family="${UI}">` +
    `<defs>` +
    (fontCss ? `<style>${fontCss}</style>` : "") +
    // soft layered drop shadow for cards
    `<filter id="cardShadow" x="-20%" y="-20%" width="140%" height="160%">` +
    `<feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="#000000" flood-opacity="0.40"/>` +
    `</filter>` +
    // dot-grid pattern
    `<pattern id="dotGrid" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse" x="${b.x}" y="${b.y}">` +
    `<circle cx="1" cy="1" r="1" fill="${colors.grid}" fill-opacity="0.55"/>` +
    `</pattern>` +
    `</defs>` +
    // background + grid
    `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${colors.bg0}"/>` +
    `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="url(#dotGrid)"/>` +
    body +
    `</svg>`
  );
}

/**
 * Rasterise an export SVG string to a base64 PNG (no data: prefix — the backend
 * decodes raw base64). Draws at `scale`× for crispness. Resolves to the base64
 * string. Rejects if the image fails to load or the canvas is unexpectedly
 * tainted (it should not be — the SVG is fully self-contained).
 */
export async function rasterizeToPngBase64(
  svg: string,
  width: number,
  height: number,
  scale = 2,
): Promise<string> {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    // Prefer decode(): it resolves only once the image — including the SVG's
    // embedded data-URI @font-face glyphs — is fully ready to draw, avoiding a
    // race where text rasterizes blank because fonts hadn't parsed yet. Fall
    // back to onload on engines where decode() rejects for SVG sources.
    try {
      await img.decode();
    } catch {
      await new Promise<void>((resolve, reject) => {
        if (img.complete && img.naturalWidth > 0) {
          resolve();
          return;
        }
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to render diagram image."));
      });
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable.");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("Could not encode PNG.");
    return dataUrl.slice(comma + 1);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Re-export for the component (kept here so the export surface is one import). */
export { embeddedFontFaceCss };
