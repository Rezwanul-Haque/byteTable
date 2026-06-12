// Preferences panel — the tweaks-panel theme controls (accent / darkness /
// density from app.jsx) restyled to the prototype's popover/panel look.
// Design-review-only controls (host protocol, drag, close) are dropped.
// Shown in the dev gallery for now; final placement comes in later milestones.

import type { Accent, Darkness, Density } from "../api";
import { usePreferencesStore } from "../state";
import "./PreferencesPanel.css";

// Accent values map to data-accent in tokens.css; hexes mirror the
// tweaks-panel options ['#2dd4a7', '#5aa7f5', '#b08cff', '#f5b54a'].
const ACCENTS: { value: Accent; color: string }[] = [
  { value: "teal", color: "#2dd4a7" },
  { value: "blue", color: "#5aa7f5" },
  { value: "violet", color: "#b08cff" },
  { value: "amber", color: "#f5b54a" },
];

const DARKNESS_OPTIONS: Darkness[] = ["black", "charcoal", "soft"];
const DENSITY_OPTIONS: Density[] = ["compact", "comfortable"];

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: T[];
  onChange: (value: T) => void;
}) {
  const idx = Math.max(0, options.indexOf(value));
  const n = options.length;
  return (
    <div className="prefs-seg" role="radiogroup" aria-label={label}>
      <div
        className="prefs-seg-thumb"
        style={{
          left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
          width: `calc((100% - 4px) / ${n})`,
        }}
      />
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export function PreferencesPanel() {
  const preferences = usePreferencesStore((state) => state.preferences);
  const setPreferences = usePreferencesStore((state) => state.setPreferences);

  return (
    <div className="prefs-panel">
      <div className="prefs-sect">Theme</div>

      <div className="prefs-row">
        <div className="prefs-lbl">Accent</div>
        <div className="prefs-chips" role="radiogroup" aria-label="Accent">
          {ACCENTS.map((a) => {
            const on = preferences.accent === a.value;
            return (
              <button
                key={a.value}
                type="button"
                role="radio"
                aria-checked={on}
                data-on={on ? "1" : "0"}
                className="prefs-chip"
                title={a.value}
                aria-label={a.value}
                style={{ background: a.color }}
                onClick={() => void setPreferences({ ...preferences, accent: a.value })}
              >
                {on && (
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    {/* All four accents are light per the tweaks-panel
                        luminance check, so the check is always dark. */}
                    <path
                      d="M3 7.2 5.8 10 11 4.2"
                      fill="none"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      stroke="rgba(0,0,0,.78)"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="prefs-row">
        <div className="prefs-lbl">Darkness</div>
        <Segmented
          label="Darkness"
          value={preferences.darkness}
          options={DARKNESS_OPTIONS}
          onChange={(darkness) => void setPreferences({ ...preferences, darkness })}
        />
      </div>

      <div className="prefs-sect">Data grid</div>

      <div className="prefs-row">
        <div className="prefs-lbl">Density</div>
        <Segmented
          label="Density"
          value={preferences.density}
          options={DENSITY_OPTIONS}
          onChange={(density) => void setPreferences({ ...preferences, density })}
        />
      </div>
    </div>
  );
}
