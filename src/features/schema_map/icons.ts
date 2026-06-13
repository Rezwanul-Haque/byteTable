// Inline SVG icon paths for the schema-map diagram (M9 Task 3).
//
// WHY inline paths instead of the Material Symbols font: the diagram exports to
// a standalone SVG / rasterised PNG. When an SVG is opened on its own or drawn
// to a <canvas>, the document's webfonts are NOT guaranteed to be available, so
// Material Symbols glyphs (which are private-use-area codepoints behind a
// ligature font) render as blank boxes. Embedding the ~5MB icon font as base64
// just to draw four glyphs is wasteful. Drawing the four diagram icons as tiny
// inline <path> shapes — identical in the live canvas and the export — is
// robust, self-contained, and keeps the export small. (The text fonts are
// embedded separately as subsettable woff2; see exportSvg.ts.)
//
// Each path is authored in a 24×24 viewBox so the component can scale it to any
// pixel size with a single transform. Shapes are simple, filled, single-colour
// (currentColor / a fill prop) so they read crisply at 11–16px.

/** One icon: its path `d` data, all drawn in a 0..24 coordinate box. */
export interface IconPath {
  /** `d` attribute(s) for the icon's `<path>`. */
  d: string;
}

/** Table / grid glyph — the card header icon. */
export const ICON_TABLE: IconPath = {
  d: "M3.5 4.5h17a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Zm.5 4.5v3h6v-3H4Zm8 0v3h8v-3h-8ZM4 13.5v3.5h6v-3.5H4Zm8 0V17h8v-3.5h-8Z",
};

/** Primary-key glyph — a stylised key. */
export const ICON_KEY: IconPath = {
  d: "M14.5 3a6.5 6.5 0 0 0-6.3 8.2L3 16.4V21h4.6v-2.2h2.2v-2.2h2.2l1.2-1.2A6.5 6.5 0 1 0 14.5 3Zm2.5 5.5a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Z",
};

/** Foreign-key glyph — a link / chain. */
export const ICON_LINK: IconPath = {
  d: "M9.2 13.4a3.9 3.9 0 0 1 0-2.8h-2.2a4 4 0 1 0 0 4h2.2a3.9 3.9 0 0 1-2 .6 2 2 0 1 1 0-4Zm5.6-5.4h-2.2a3.9 3.9 0 0 1 2-.6 2 2 0 1 1 0 4 3.9 3.9 0 0 1 .2 1.4 3.9 3.9 0 0 1-.2 1.4h2.2a4 4 0 1 0 0-6.2ZM8 11h8v2H8z",
};

/** Open-in-new glyph — box with an out-arrow. */
export const ICON_OPEN: IconPath = {
  d: "M14 3v2h3.6l-7.3 7.3 1.4 1.4L19 6.4V10h2V3h-7ZM5 5h5v2H6.5v10.5h11V14h2v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
};
