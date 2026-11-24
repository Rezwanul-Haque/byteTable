// The masking switch, everywhere it lives (M49 B): the status-bar chip, the
// title-bar pill, and the watcher that owns ⌘⇧M, the `mask` command and the
// on / off toast (one toast per change, whatever the route).

import { useCallback, useEffect } from "react";

import { useT } from "../../../shared/i18n/useT";
import { useBtCmd } from "../../../shared/ui/btCmd";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { useSettingsStore } from "../../settings/state";
import { toggleMask, useMaskStore, useOnMaskChange } from "../state";
import "./Masking.css";

/** Status bar: the switch itself, always in sight. */
export function MaskStatusChip() {
  const t = useT();
  const on = useSettingsStore((s) => s.settings.maskOn);
  const n = useMaskStore((s) => s.revealed.size);
  return (
    <button
      type="button"
      className={"status-btn mask-chip" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      title={t(on ? "mask.chip.onHint" : "mask.chip.offHint")}
      onClick={() => toggleMask()}
    >
      <Icon name={on ? "visibility_off" : "visibility"} size={13} />{" "}
      {on ? (n ? t("mask.chip.onShown", { n }) : t("mask.chip.on")) : t("mask.chip.off")}
    </button>
  );
}

/** Title bar: "Masking on", on every screen. Clicking turns masking off. */
export function MaskTitlePill() {
  const t = useT();
  const on = useSettingsStore((s) => s.settings.maskOn);
  if (!on) return null;
  return (
    <button
      type="button"
      className="tb-mask"
      title={t("mask.pill.hint")}
      onClick={() => toggleMask(false)}
      // Not a drag area, and a double-click must not maximize the window.
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Icon name="visibility_off" size={13} /> {t("mask.pill")}
    </button>
  );
}

/** ⌘⇧M / Ctrl+Shift+M, the `mask` command, and the toast on every change. */
export function MaskWatcher() {
  const t = useT();
  const toast = useToast();
  useBtCmd("mask", () => toggleMask());
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "KeyM") {
        event.preventDefault();
        toggleMask();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const announce = useCallback(
    (on: boolean) => toast(t(on ? "mask.toast.on" : "mask.toast.off"), "info"),
    [toast, t],
  );
  useOnMaskChange(announce);
  return null;
}
