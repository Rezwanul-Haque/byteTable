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

import { HEAD_H, ROW_H, contentBounds, crowFoot, type CardModel, type EdgeModel } from "./diagram";
import { GROUP_HEAD_H, GROUP_PAD_TOP, type GroupBox } from "./groups";
import { type GroupLinkModel } from "./groupLinks";
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
  // A MATERIAL theme's surface tokens are translucent by design: correct over
  // the app's backdrop, wrong in an exported file, where a see-through card
  // lands on whatever the viewer puts behind it (and resvg composites it onto
  // nothing). Substitute the opaque equivalents of what the canvas actually
  // renders — the flattened values of glass.css's `.map-card-box` and friends.
  // Text and accent are already opaque in every theme, so they read live.
  const material = document.documentElement.hasAttribute("data-material");
  const border = material ? "#3e4252" : v("--border", "#2c3039");
  const bg0 = material ? "#0b1120" : v("--bg0", "#131418");
  return {
    bg0,
    bg1: material ? "#0e1427" : v("--bg1", "#191b20"),
    bg2: material ? "#23293b" : v("--bg2", "#20232a"),
    bg3: material ? "#2c3550" : v("--bg3", "#282c35"),
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

// ONE FAMILY, ON PURPOSE. The PNG path rasterizes this SVG with resvg, whose
// font database is loaded with JetBrains Mono and nothing else — no system fonts
// are consulted (see `render.rs`). Text in any other family silently vanishes
// from the PNG, so every <text> here — and the document default — must be MONO.
const MONO = "JetBrains Mono, ui-monospace, monospace";

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

/**
 * A filename-safe local timestamp for default export names, e.g.
 * `20260722-143005` (YYYYMMDD-HHMMSS). Local time so it matches the user's
 * clock; sortable and free of characters that break file systems.
 */
export function exportTimestamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
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
  // Static offset "shadow" (a dark rounded rect nudged down) instead of an SVG
  // blur filter. A per-card feDropShadow gaussian blur is by far the most
  // expensive thing to rasterize on the CPU (resvg/tiny-skia) — it dominated
  // export time (~5× the whole render on a 40-card diagram). This flat offset
  // keeps a depth cue for near-free.
  parts.push(
    `<rect x="0" y="5" width="${w}" height="${h}" rx="11" fill="#000000" fill-opacity="0.35"/>`,
  );
  parts.push(
    `<rect x="0" y="0" width="${w}" height="${h}" rx="11" fill="${c.bg1}" stroke="${c.border}" stroke-width="1"/>`,
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

/** One FK edge → SVG markup: path, endpoint dots, and the crow's-foot
 *  cardinality markers (one/many) at each end — matching the live canvas. */
function edgeSvg(edge: EdgeModel, c: ExportColors): string {
  const foot = (d: string): string =>
    `<path d="${d}" fill="none" stroke="${c.accent}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  return (
    `<path d="${edge.path}" fill="none" stroke="${c.edge}" stroke-width="1.5" stroke-opacity="0.65"/>` +
    `<circle cx="${edge.sx}" cy="${edge.sy}" r="3.5" fill="${c.accent}"/>` +
    `<circle cx="${edge.tx}" cy="${edge.ty}" r="5" fill="${c.bg0}" stroke="${c.accent}" stroke-width="1"/>` +
    `<circle cx="${edge.tx}" cy="${edge.ty}" r="2" fill="${c.accent}"/>` +
    foot(crowFoot(edge.sx, edge.sy, edge.sOut, edge.childEnd)) +
    foot(crowFoot(edge.tx, edge.ty, edge.tOut, edge.parentEnd))
  );
}

/** One group frame → SVG markup: tinted box, coloured border, title bar. The
 *  frame's colour is baked into the group itself, so no theme tokens apply. */
function groupSvg(box: GroupBox): string {
  return (
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="14" ` +
    `fill="${box.color}" fill-opacity="0.06" stroke="${box.color}" stroke-opacity="0.55" stroke-width="1.5"/>` +
    `<rect x="${box.x + 10}" y="${box.y + (GROUP_PAD_TOP - GROUP_HEAD_H) / 2}" ` +
    `width="${Math.max(60, box.name.length * 7.2 + 20)}" height="${GROUP_HEAD_H}" rx="7" ` +
    `fill="${box.color}" fill-opacity="0.16"/>` +
    `<text x="${box.x + 20}" y="${box.y + GROUP_PAD_TOP / 2}" dominant-baseline="central" ` +
    `font-family="${MONO}" font-size="12" font-weight="600" fill="${box.color}">${esc(box.name)}</text>`
  );
}

/** Advance width of one 11px JetBrains Mono character — the label pill is
 *  measured from its text, since SVG can't size a rect to a text node. */
const LABEL_CHAR_W = 6.7;

/** One group-to-group arrow → SVG markup: curve, filled head, and its caption
 *  pill. The arrow's colour comes from its source group (baked, like the frame's
 *  own colour), so no theme token applies. */
function groupLinkSvg(link: GroupLinkModel, c: ExportColors): string {
  const parts = [
    `<path d="${link.path}" fill="none" stroke="${link.color}" stroke-width="2" ` +
      `stroke-opacity="0.9" stroke-linecap="round"/>`,
    `<path d="${link.head}" fill="${link.color}" fill-opacity="0.95"/>`,
  ];
  if (link.label) {
    const text = truncate(link.label, 28);
    const w = text.length * LABEL_CHAR_W + 14;
    parts.push(
      `<rect x="${link.mx - w / 2}" y="${link.my - 9}" width="${w}" height="18" rx="6" ` +
        `fill="${c.bg0}" stroke="${link.color}" stroke-opacity="0.6" stroke-width="1"/>`,
      `<text x="${link.mx}" y="${link.my}" text-anchor="middle" dominant-baseline="central" ` +
        `font-family="${MONO}" font-size="11" fill="${link.color}">${esc(text)}</text>`,
    );
  }
  return parts.join("");
}

/**
 * Build the standalone export SVG string for the diagram. `fontCss` is the
 * embedded @font-face block (data: URIs); pass "" to fall back to system fonts
 * (last-resort — text drifts but still renders). Edges carry crow's-foot
 * cardinality markers at each end, matching the live canvas.
 *
 * `groups` paints the named frames behind the cards and `links` the arrows
 * between those frames. Exporting a single group is just passing that group's
 * cards/edges/frame — the framing bounding box follows the cards handed in, so
 * no separate crop step is needed (see `scopeToGroup`).
 */
export function buildExportSvg(
  cards: CardModel[],
  edges: EdgeModel[],
  colors: ExportColors,
  fontCss: string,
  groups: GroupBox[] = [],
  links: GroupLinkModel[] = [],
): string {
  // Frame from the cards, then widen to hold every group frame — a frame the
  // user has stretched beyond its cards must not be cropped out of the export.
  const cb = contentBounds(cards, 48);
  const b = groups.reduce(
    (acc, g) => {
      const x = Math.min(acc.x, g.x - 24);
      const y = Math.min(acc.y, g.y - 24);
      const right = Math.max(acc.x + acc.width, g.x + g.w + 24);
      const bottom = Math.max(acc.y + acc.height, g.y + g.h + 24);
      return { x, y, width: right - x, height: bottom - y };
    },
    { ...cb },
  );
  // A bent arrow can swing outside every frame; its handle is the furthest the
  // curve reaches, so widening to that keeps it in the picture.
  for (const l of links) {
    const x = Math.min(b.x, l.mx - 24);
    const y = Math.min(b.y, l.my - 24);
    b.width = Math.max(b.x + b.width, l.mx + 24) - x;
    b.height = Math.max(b.y + b.height, l.my + 24) - y;
    b.x = x;
    b.y = y;
  }
  const GRID = 22;
  const body =
    groups.map((g) => groupSvg(g)).join("") +
    links.map((l) => groupLinkSvg(l, colors)).join("") +
    edges.map((e) => edgeSvg(e, colors)).join("") +
    cards.map((c) => cardSvg(c, colors)).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(b.width)}" height="${Math.round(b.height)}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" font-family="${MONO}">` +
    `<defs>` +
    (fontCss ? `<style>${fontCss}</style>` : "") +
    // NOTE: no blur filter here — cards use a cheap static offset shadow (see
    // cardSvg). A per-card feDropShadow gaussian blur is the single most
    // expensive thing to CPU-rasterize and dominated export time.
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

// PNG rasterization moved to the Rust backend (`render::svg_to_png`, resvg): the
// webview-canvas path (SVG → <img> → <canvas> → toDataURL) is unsupported by
// WebKitGTK on Linux, so it failed there while working on macOS/Windows. The
// backend renders the same SVG identically on every platform. See api.ts.

/** Re-export for the component (kept here so the export surface is one import). */
export { embeddedFontFaceCss };
