// The interface-language list (M31) — one component behind both places a
// language can be picked: the Settings → Language & region trigger and the
// sidebar's language chip. A custom list, never a native <select>, because each
// row carries an endonym, an English name and (for RTL locales) a tag, none of
// which an <option> can hold.
//
// Positioning belongs to the caller: pass `lang-pop-anchored` to hang it under
// a trigger, or `lang-pop-floating` plus a fixed `style` for a portaled menu.

import type { CSSProperties } from "react";

import { LOCALES, type LocaleId } from "../i18n";
import "./LanguageMenu.css";

interface LanguageMenuProps {
  /** The locale currently in effect. */
  value: LocaleId;
  onPick: (code: LocaleId) => void;
  /** Positioning class — `lang-pop-anchored` or `lang-pop-floating`. */
  className?: string;
  style?: CSSProperties;
  ref?: React.Ref<HTMLDivElement>;
}

export function LanguageMenu({ value, onPick, className, style, ref }: LanguageMenuProps) {
  return (
    <div
      ref={ref}
      className={"lang-pop" + (className ? " " + className : "")}
      style={style}
      role="listbox"
      aria-label="Interface language"
    >
      {(Object.entries(LOCALES) as [LocaleId, (typeof LOCALES)[LocaleId]][]).map(([code, meta]) => {
        // const pct = coverage(code);
        return (
          <button
            key={code}
            type="button"
            role="option"
            aria-selected={code === value}
            className={"lang-item" + (code === value ? " active" : "")}
            onClick={() => onPick(code)}
          >
            <span className="lang-item-endonym">{meta.endonym}</span>
            <span className="lang-item-name">{meta.name}</span>
            {meta.dir === "rtl" ? <span className="lang-rtl-tag">RTL</span> : null}
            {/* Hidden until the percentage means what it says:
            <span className="lang-cov">
              <span className="lang-cov-bar">
                <span style={{ width: `${pct}%` }} />
              </span>
              {pct}%
            </span> */}
          </button>
        );
      })}
    </div>
  );
}
