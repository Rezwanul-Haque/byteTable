// Export a NoSQL "card map" (HTML-card maps: MongoDB collections, DynamoDB
// single-table) to PNG / SVG, reusing the SQL schema-map's rasterizer, embedded
// fonts, theme colors, and the `diagram_export` backend writer + save dialog.
//
// The SQL map is already pure SVG, so it serializes directly. The NoSQL maps
// render as HTML cards + an SVG edge layer; HTML-in-SVG (<foreignObject>) taints
// the canvas and breaks PNG export, so this module REDRAWS the cards as native
// SVG (rect + text) from a generic model the caller builds from its own card
// shapes. Edge `d` paths are reused as-is (same coordinate space as the cards).

import { diagramExport } from "./api";
import { embeddedFontFaceCss, rasterizeToPngBase64, readExportColors } from "./export";

const MONO = "JetBrains Mono";
const HEAD_H = 36;
const ROW_H = 21;
const COLS_PAD = 8;
const MARGIN = 40;

/** One field/attribute row drawn inside a card. */
export interface ExportMapRow {
  name: string;
  type?: string;
  /** Type-chip color (falls back to the faint text color). */
  typeColor?: string;
  /** Render muted + italic (e.g. a "+ N more…" row). */
  muted?: boolean;
}

/** One card: absolute position + size + header + rows. */
export interface ExportMapCard {
  x: number;
  y: number;
  w: number;
  name: string;
  /** Right-aligned header count (e.g. document count). */
  count?: string;
  rows: ExportMapRow[];
}

/** One edge path (absolute coords, same space as the cards). */
export interface ExportMapEdge {
  d: string;
  dashed?: boolean;
}

export type ExportFormat = "png" | "svg";

export type ExportResult =
  | { status: "ok"; file: string }
  | { status: "empty" }
  | { status: "cancelled" }
  | { status: "no-dialog" };

const cardHeight = (c: ExportMapCard) => HEAD_H + COLS_PAD + c.rows.length * ROW_H;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function saveDialog(defaultName: string, ext: string, label: string) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] });
}

function cardSvg(card: ExportMapCard, colors: ReturnType<typeof readExportColors>): string {
  const w = card.w;
  const h = cardHeight(card);
  const r = 11;
  const parts: string[] = [
    `<rect width="${w}" height="${h}" rx="${r}" fill="${colors.bg1}" stroke="${colors.border}" stroke-width="1"/>`,
    // Header with only the TOP corners rounded.
    `<path d="M0 ${HEAD_H} V${r} a${r} ${r} 0 0 1 ${r} -${r} H${w - r} a${r} ${r} 0 0 1 ${r} ${r} V${HEAD_H} Z" fill="${colors.bg2}"/>`,
    `<line x1="0" y1="${HEAD_H}" x2="${w}" y2="${HEAD_H}" stroke="${colors.border}"/>`,
    `<text x="11" y="${HEAD_H / 2}" dominant-baseline="central" font-family="${MONO}" font-size="12" font-weight="600" fill="${colors.text}">${esc(card.name)}</text>`,
  ];
  if (card.count) {
    parts.push(
      `<text x="${w - 11}" y="${HEAD_H / 2}" text-anchor="end" dominant-baseline="central" font-family="${MONO}" font-size="10" fill="${colors.textFaint}">${esc(card.count)}</text>`,
    );
  }
  card.rows.forEach((row, i) => {
    const cy = HEAD_H + COLS_PAD + i * ROW_H + ROW_H / 2;
    const nameFill = row.muted ? colors.textFaint : colors.textDim;
    const italic = row.muted ? ` font-style="italic"` : "";
    parts.push(
      `<text x="11" y="${cy}" dominant-baseline="central" font-family="${MONO}" font-size="11" fill="${nameFill}"${italic}>${esc(row.name)}</text>`,
    );
    if (row.type) {
      parts.push(
        `<text x="${w - 11}" y="${cy}" text-anchor="end" dominant-baseline="central" font-family="${MONO}" font-size="9" fill="${row.typeColor ?? colors.textFaint}">${esc(row.type)}</text>`,
      );
    }
  });
  return `<g transform="translate(${card.x},${card.y})">${parts.join("")}</g>`;
}

function buildSvg(
  cards: ExportMapCard[],
  edges: ExportMapEdge[],
  colors: ReturnType<typeof readExportColors>,
  fontCss: string,
): { svg: string; width: number; height: number } {
  const left = Math.min(...cards.map((c) => c.x));
  const top = Math.min(...cards.map((c) => c.y));
  const right = Math.max(...cards.map((c) => c.x + c.w));
  const bottom = Math.max(...cards.map((c) => c.y + cardHeight(c)));
  const width = right - left + MARGIN * 2;
  const height = bottom - top + MARGIN * 2;

  const edgeSvg = edges
    .map(
      (e) =>
        `<path d="${e.d}" fill="none" stroke="${e.dashed ? colors.textFaint : colors.accent}" stroke-width="1.5"${e.dashed ? ' stroke-dasharray="5 4"' : ""}/>`,
    )
    .join("");
  const cardsSvg = cards.map((c) => cardSvg(c, colors)).join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (fontCss ? `<style>${fontCss}</style>` : "") +
    `<rect width="${width}" height="${height}" fill="${colors.bg0}"/>` +
    `<g transform="translate(${MARGIN - left},${MARGIN - top})">${edgeSvg}${cardsSvg}</g>` +
    `</svg>`;
  return { svg, width, height };
}

/** Build the export SVG, prompt for a save path, and write it (PNG rasterized,
 *  SVG verbatim) via the `diagram_export` backend. Returns a status the caller
 *  turns into a toast. */
export async function exportCardMap(opts: {
  cards: ExportMapCard[];
  edges: ExportMapEdge[];
  fileBase: string;
  format: ExportFormat;
}): Promise<ExportResult> {
  const { cards, edges, fileBase, format } = opts;
  if (cards.length === 0) return { status: "empty" };

  const colors = readExportColors();
  const fontCss = await embeddedFontFaceCss();
  const { svg, width, height } = buildSvg(cards, edges, colors, fontCss);

  const defaultName = `${fileBase}.${format}`;
  let path: string | null;
  try {
    path = await saveDialog(defaultName, format, format === "png" ? "PNG image" : "SVG image");
  } catch {
    return { status: "no-dialog" };
  }
  if (!path) return { status: "cancelled" };

  const data = format === "png" ? await rasterizeToPngBase64(svg, width, height, 2) : svg;
  await diagramExport(path, format, data);
  const file = path.split(/[\\/]/).pop() ?? defaultName;
  return { status: "ok", file };
}
