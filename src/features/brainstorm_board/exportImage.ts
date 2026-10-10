// Image export for the board (M37 Task 9): the whole board, the focused layer,
// the current selection, or any one group — as a 2× PNG or an SVG.
//
// ============================== DESIGN ==============================
//
// **Why html-to-image and not a hand-emitted SVG.** The schema map re-emits its
// diagram as native SVG (see `schema_map/export.ts`) because it IS an SVG. The
// board is HTML: sticky notes in a handwritten font, table cards with CSS grid
// rows, flow nodes with custom-property-tinted borders. Redrawing that family by
// hand would be a second renderer to keep in step with the first. `html-to-image`
// serialises the live DOM instead, so the export is what the user sees.
//
// **Loaded on demand.** The dependency is dynamically imported on first export,
// so a board tab that is never exported from never pays for it.
//
// **Two filters, both load-bearing:**
//   - `.bb-noexport` drops hover-only chrome (the sketch's Promote pill), which
//     would otherwise be baked in at whatever opacity it happened to have.
//   - `.msym` drops the icon glyphs. Material Symbols is a LIGATURE font: the
//     element's text content is the icon's NAME, and the glyph only appears once
//     the font is applied. The serialiser cannot reliably inline that font, so
//     without this filter the image prints the words "table_view", "key",
//     "workspaces" where the icons were.
//
// **Scoping.** The caller sets `exportIds` first, which makes the canvas render
// only those objects (plus the edges whose BOTH ends are included and the groups
// wholly included), all layers at full strength and no selection outlines. Two
// animation frames later — one for React to commit, one for the browser to lay
// out and paint — the capture runs against `.bb-world` with a transform override
// that crops to the content bounds plus a margin.
//
// Writing goes through the native save dialog and the backend, like every other
// export in the app: the user's chosen path is the consent, and the renderer
// never writes to disk itself.

import { exportSave } from "../../shared/api/engine";
import { exportSaveBytes } from "./api";
import type { Box } from "./geometry";
import { snake } from "./naming";

export type ImageFormat = "png" | "svg";

/** What to put in the picture. */
export type ExportTarget =
  | { kind: "board" }
  | { kind: "layer" }
  | { kind: "selection" }
  | { kind: "group"; id: string };

export type ExportStatus =
  | { status: "ok"; file: string; count: number }
  | { status: "cancelled" }
  | { status: "no-dialog" }
  | { status: "failed"; message: string };

/** Margin left around the exported content, in world px. */
const PAD = 48;

/** PNG is rendered at 2× for HiDPI; SVG is resolution-independent. */
const PNG_SCALE = 2;

interface HtmlToImage {
  toPng: (node: HTMLElement, options?: Record<string, unknown>) => Promise<string>;
  toSvg: (node: HTMLElement, options?: Record<string, unknown>) => Promise<string>;
}

/** Kept out of the main bundle; resolved once and cached by the module system. */
async function loadExporter(): Promise<HtmlToImage> {
  const mod = await import("html-to-image");
  return { toPng: mod.toPng, toSvg: mod.toSvg };
}

async function saveDialog(defaultName: string, format: ImageFormat) {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath: defaultName,
    filters: [{ name: format === "png" ? "PNG image" : "SVG image", extensions: [format] }],
  });
}

/** Strip a `data:…;base64,` prefix, leaving the payload the backend decodes. */
function base64Payload(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/** html-to-image's `toSvg` returns a `data:image/svg+xml;charset=utf-8,<escaped>`
 *  URL; the document text is the decoded tail. */
function svgText(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  const tail = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  return dataUrl.includes(";base64,") ? atob(tail) : decodeURIComponent(tail);
}

/**
 * Capture `world` cropped to `bounds` and write it to a user-chosen path.
 *
 * The transform override is what does the cropping: the world is re-positioned
 * so the content's top-left lands at (PAD, PAD) inside a box sized to the
 * content, at scale 1 — the live view's pan and zoom are deliberately ignored,
 * so what you get does not depend on where you were looking.
 */
export async function exportBoardImage(opts: {
  world: HTMLElement;
  /** Background colour to flatten onto — read from the live viewport, so the
   *  export stays on-theme. */
  background: string;
  bounds: Box;
  format: ImageFormat;
  /** Used for the default file name and the toast. */
  name: string;
  /** Object count, reported in the toast. */
  count: number;
}): Promise<ExportStatus> {
  const { world, background, bounds, format, name, count } = opts;
  const width = Math.ceil(bounds.x2 - bounds.x1 + PAD * 2);
  const height = Math.ceil(bounds.y2 - bounds.y1 + PAD * 2);

  const defaultName = (snake(name) || "board") + "." + format;
  let path: string | null;
  try {
    path = await saveDialog(defaultName, format);
  } catch {
    return { status: "no-dialog" };
  }
  if (!path) return { status: "cancelled" };

  const options: Record<string, unknown> = {
    width,
    height,
    pixelRatio: format === "png" ? PNG_SCALE : 1,
    backgroundColor: background,
    cacheBust: true,
    style: {
      transform: `translate(${PAD - bounds.x1}px,${PAD - bounds.y1}px)`,
      width: width + "px",
      height: height + "px",
    },
    filter: (node: Node) =>
      !(
        node instanceof Element &&
        (node.classList.contains("bb-noexport") || node.classList.contains("msym"))
      ),
  };

  try {
    const exporter = await loadExporter();
    const render = format === "svg" ? exporter.toSvg : exporter.toPng;
    let dataUrl: string;
    try {
      dataUrl = await render(world, options);
    } catch {
      // Font embedding is the usual failure (a webfont served from a scheme the
      // serialiser can't fetch). Retrying without it yields a system-font
      // picture, which beats no picture.
      dataUrl = await render(world, { ...options, skipFonts: true });
    }
    if (format === "svg") await exportSave(path, svgText(dataUrl));
    else await exportSaveBytes(path, base64Payload(dataUrl));
    const file = path.split(/[\\/]/).pop() ?? defaultName;
    return { status: "ok", file, count };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
