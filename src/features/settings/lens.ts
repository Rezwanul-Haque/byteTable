// Liquid Glass's edge refraction (M38 Task 7) — progressive enhancement.
//
// One hidden SVG filter, `#bt-lg-lens`: a displacement map that is FLAT in the
// middle (128,128 = no offset) with ramps at the four edges, fed to
// `feDisplacementMap`. Applied through `backdrop-filter: url(#bt-lg-lens)`, it
// bends what is behind a pane only near its rim — which is what a lens does,
// and what distinguishes Liquid Glass from a plain blur.
//
// GATED, never unconditional. `backdrop-filter: url()` renders in Chromium
// only; in WebKit the whole declaration is dropped and the surface loses its
// blur with it, so an ungated rule would leave every pane transparent on
// macOS. ByteTable ships on three engines — WKWebView (macOS), WebView2
// (Windows, Chromium) and WebKitGTK (Linux) — so the check decides at runtime
// and the class it toggles is what the CSS keys on.

/** Chromium-based webview? `userAgentData` exists in Chromium and nowhere else
 *  we ship on, so its brand list is the engine check, not a UA-string guess. */
export function supportsBackdropLens(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } })
    .userAgentData?.brands;
  return Array.isArray(brands) && brands.some((b) => /Chromium/i.test(b.brand));
}

/** The displacement map: red ramps left→right, green top→bottom, both held at
 *  the neutral 128 across the middle so only the edges displace. */
const DISPLACEMENT_MAP =
  "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200' preserveAspectRatio='none'>" +
  "<defs><linearGradient id='x' x1='0' x2='1'>" +
  "<stop offset='0' stop-color='rgb(255,0,0)'/><stop offset='.14' stop-color='rgb(128,0,0)'/>" +
  "<stop offset='.86' stop-color='rgb(128,0,0)'/><stop offset='1' stop-color='rgb(0,0,0)'/>" +
  "</linearGradient>" +
  "<linearGradient id='y' x1='0' y1='0' x2='0' y2='1'>" +
  "<stop offset='0' stop-color='rgb(0,255,0)'/><stop offset='.22' stop-color='rgb(0,128,0)'/>" +
  "<stop offset='.78' stop-color='rgb(0,128,0)'/><stop offset='1' stop-color='rgb(0,0,0)'/>" +
  "</linearGradient></defs>" +
  "<rect width='200' height='200' fill='url(%23x)'/>" +
  "<rect width='200' height='200' fill='url(%23y)' style='mix-blend-mode:screen'/></svg>";

/** Inject the filter once. No-op when it is already there, when the document
 *  body does not exist yet (pre-mount apply), or on a non-Chromium engine. */
export function ensureLensDefs(): void {
  if (!supportsBackdropLens()) return;
  if (!document.body || document.getElementById("bt-lg-defs")) return;
  const wrap = document.createElement("div");
  wrap.id = "bt-lg-defs";
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  wrap.innerHTML =
    '<svg width="0" height="0"><filter id="bt-lg-lens" x="0" y="0" width="100%" height="100%" ' +
    'color-interpolation-filters="sRGB">' +
    '<feImage href="data:image/svg+xml,' +
    DISPLACEMENT_MAP.replace(/#/g, "%23") +
    '" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="m"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="m" scale="26" xChannelSelector="R" ' +
    'yChannelSelector="G"/></filter></svg>';
  document.body.appendChild(wrap);
}
