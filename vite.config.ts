import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only: inject the standalone React DevTools connect script into <head>,
// BEFORE the app module runs so the DevTools hook is installed before React
// mounts. `apply: "serve"` guarantees this never lands in a production build.
// Requires the standalone GUI running first: `pnpm devtools` (port 8097).
// If the GUI isn't up the script simply fails to connect — the app is fine.
function reactDevtools(): Plugin {
  return {
    name: "bytetable:react-devtools",
    apply: "serve",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { src: "http://localhost:8097" },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [reactDevtools(), react()],

  // Vite options tailored for Tauri development.
  // 1. prevent Vite from obscuring Rust errors
  clearScreen: false,
  // 2. Tauri expects a fixed port; fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
});
