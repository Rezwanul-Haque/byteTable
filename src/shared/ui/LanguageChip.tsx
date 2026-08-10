// The interface language, as a short code, in the sidebar's connection header
// (M31). Clicking it drops the same language list the Settings pane uses, so
// switching language is one click from any workspace — no modal, no hunting for
// the tab.
//
// Deliberately a code and not a flag: languages are not countries (Español is
// not Spain, العربية is not Saudi Arabia), and the shipped set already includes
// two Chinese variants that no flag can distinguish.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { LOCALES, type LocaleId } from "../i18n";
import { useLocale } from "../i18n/useT";
import { useSettingsStore } from "../../features/settings/state";
import { LanguageMenu } from "./LanguageMenu";
import "./LanguageChip.css";

/** Menu width (`.lang-pop` min-width) + the gap kept from the window edge. */
const MENU_WIDTH = 268;
const EDGE_GAP = 8;

export function LanguageChip() {
  // Subscribes to the locale, so the code updates the moment it changes.
  const locale = useLocale();
  const setSetting = useSettingsStore((s) => s.setSetting);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const meta = LOCALES[locale] ?? LOCALES.en;

  const open = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Below the chip, left-aligned with it, pulled back in when that would run
    // past the window edge (the menu is wider than the sidebar).
    const left = Math.max(EDGE_GAP, Math.min(rect.left, window.innerWidth - MENU_WIDTH - EDGE_GAP));
    setAt({ top: rect.bottom + 6, left });
  };

  const close = () => setAt(null);

  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // The menu is anchored to a rect, so it would drift away from the chip if
    // the window changed size underneath it.
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [at]);

  const pick = (code: LocaleId) => {
    setSetting("locale", code);
    close();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={"lang-chip" + (at ? " open" : "")}
        // The endonym carries the meaning the short code can't.
        title={`${meta.endonym} · ${meta.name} — change the interface language`}
        aria-label={`Interface language: ${meta.name}`}
        aria-haspopup="listbox"
        aria-expanded={at !== null}
        onClick={() => (at ? close() : open())}
      >
        {locale.toUpperCase()}
      </button>
      {at
        ? createPortal(
            <>
              {/* Click-catcher: closes on any outside press, including one that
                  would otherwise land on a control behind the menu. */}
              <div className="lang-pop-overlay" onMouseDown={close} />
              <LanguageMenu
                value={locale}
                onPick={pick}
                className="lang-pop-floating"
                style={{ top: at.top, left: at.left }}
              />
            </>,
            document.body,
          )
        : null}
    </>
  );
}
