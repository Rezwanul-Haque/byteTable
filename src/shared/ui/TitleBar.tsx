import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { defaultWindowIcon } from "@tauri-apps/api/app";
import { useSettingsStore } from "../../features/settings/state";
import "./TitleBar.css";

export function TitleBar() {
  const appWindow = getCurrentWindow();
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const { settings, setSetting } = useSettingsStore();

  const cyclePosition = () => {
    const current = settings.titlebarPosition;
    const next =
      current === "topLeftIcon"
        ? "bottomLeftIcon"
        : current === "bottomLeftIcon"
          ? "bottomRightIcon"
          : current === "bottomRightIcon"
            ? "topRightIcon"
            : "topLeftIcon";
    setSetting("titlebarPosition", next);
  };

  useEffect(() => {
    async function loadIcon() {
      try {
        const icon = await defaultWindowIcon();
        if (icon) {
          // defaultWindowIcon returns an Image object with rgba() data.
          // We convert the raw RGBA pixels into a Data URL for the <img> tag
          const rgba = await icon.rgba();
          const size = await icon.size();

          const canvas = document.createElement("canvas");
          canvas.width = size.width;
          canvas.height = size.height;
          const ctx = canvas.getContext("2d");

          if (ctx) {
            const imgData = new ImageData(new Uint8ClampedArray(rgba), size.width, size.height);
            ctx.putImageData(imgData, 0, 0);
            setIconUrl(canvas.toDataURL("image/png"));
          }
        }
      } catch (err) {
        console.error("Failed to load window icon", err);
      }
    }
    loadIcon();
  }, []);

  return (
    <div data-tauri-drag-region className="bt-titlebar">
      <div className="bt-titlebar-left" data-tauri-drag-region>
        {iconUrl && (
          <img src={iconUrl} alt="App Icon" className="bt-titlebar-icon" data-tauri-drag-region />
        )}
        <span className="bt-titlebar-title" data-tauri-drag-region>
          ByteTable
        </span>
      </div>

      <div className="bt-titlebar-buttons">
        <button className="bt-titlebar-btn" onClick={cyclePosition} title="Cycle Titlebar Position">
          <span className="msym">swap_vert</span>
        </button>
        <button className="bt-titlebar-btn" onClick={() => appWindow.hide()} title="Hide to Tray">
          <span className="msym">visibility_off</span>
        </button>
        <button className="bt-titlebar-btn" onClick={() => appWindow.minimize()} title="Minimize">
          <span className="msym">remove</span>
        </button>
        <button
          className="bt-titlebar-btn"
          onClick={() => appWindow.toggleMaximize()}
          title="Maximize"
        >
          <span className="msym">crop_square</span>
        </button>
        <button className="bt-titlebar-btn close" onClick={() => appWindow.close()} title="Close">
          <span className="msym">close</span>
        </button>
      </div>
    </div>
  );
}
