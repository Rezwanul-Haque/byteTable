import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Bundled fonts (no runtime Google Fonts).
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "material-symbols/rounded.css";

import "./shared/styles/tokens.css";
import "./shared/styles/global.css";

// Apply saved settings (theme/accent/fonts/sizes) synchronously off the
// localStorage fast-path BEFORE React mounts, so the first painted frame is
// already themed — no flash of the default palette. The Tauri disk mirror is
// reconciled afterwards by the settings store (App).
import "./features/settings/bootstrap";

import { App } from "./App";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dismiss the index.html splash once React has painted, keeping it up long
// enough to read (matches the prototype's ~1.4s min). Two rAFs ⇒ after the
// first committed frame; then fade out (.hide) and remove.
(() => {
  const splash = document.getElementById("bt-splash");
  if (!splash) return;
  const start = performance.now();
  const minShow = 1400;
  const hide = () => {
    const wait = Math.max(0, minShow - (performance.now() - start));
    setTimeout(() => {
      splash.classList.add("hide");
      setTimeout(() => splash.remove(), 500);
    }, wait);
  };
  requestAnimationFrame(() => requestAnimationFrame(hide));
})();
