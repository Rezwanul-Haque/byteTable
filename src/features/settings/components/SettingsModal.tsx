// Settings modal (M20.2–20.5): a 4-tab dialog — Appearance, Fonts & text,
// Data grid, Behavior — editing the global settings contract. Every change
// applies + persists immediately through the settings store (no Save button).
// Ported from the prototype's settings.jsx; the store replaces its useSettings.

import { useEffect, useRef, useState } from "react";

import { Modal } from "../../../shared/ui/Modal";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Select } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import type { AutoRefreshSec, DefaultLimit, Density, Settings, SidebarSide } from "../api";
import {
  ACCENTS,
  monoMetaFor,
  MONO_FONTS,
  THEMES,
  type Theme,
  type ThemeId,
  UI_FONTS,
  type UiFontId,
} from "../catalogs";
import { platform } from "@tauri-apps/plugin-os";
import { detectSystemMonos } from "../fonts";
import { renderSqlPreview } from "../sqlPreview";
import { useSettingsStore } from "../state";
import "./SettingsModal.css";

const TABS = [
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "fonts", label: "Fonts & text", icon: "text_fields" },
  { id: "grid", label: "Data grid", icon: "table_rows" },
  { id: "behavior", label: "Behavior", icon: "tune" },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ---- small controls (ported from settings.jsx) ----

function ThemeSwatch({
  id,
  theme,
  active,
  onPick,
}: {
  id: ThemeId;
  theme: Theme;
  active: boolean;
  onPick: (id: ThemeId) => void;
}) {
  return (
    <button
      type="button"
      className={"set-theme" + (active ? " active" : "")}
      onClick={() => onPick(id)}
      title={theme.label}
      aria-pressed={active}
    >
      <div className="set-theme-prev" style={{ background: theme.bg0, borderColor: theme.border }}>
        <div className="set-theme-bar" style={{ background: theme.bg1 }}>
          <span style={{ background: theme.accent }} />
          <span style={{ background: theme.dim }} />
        </div>
        <div className="set-theme-body">
          <i style={{ background: theme.text, width: "60%" }} />
          <i style={{ background: theme.dim, width: "85%" }} />
          <i style={{ background: theme.accent, width: "40%" }} />
        </div>
      </div>
      <div className="set-theme-name">
        {theme.label}
        {active ? (
          <Icon name="check_circle" size={13} fill={1} style={{ color: "var(--accent)" }} />
        ) : null}
      </div>
    </button>
  );
}

function SetRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-label">
        <span>{label}</span>
        {hint ? <span className="set-row-hint">{hint}</span> : null}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function SetToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={"set-switch" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="set-switch-knob" />
    </button>
  );
}

function SetSeg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="set-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={"set-seg-btn" + (value === o.value ? " active" : "")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const SQL_SAMPLE =
  "SELECT id, name, total\nFROM orders\nWHERE total >= 1000  -- 0O1l => != <=\nORDER BY created_at DESC\nLIMIT 10;";

function FontPreview({ stack }: { stack: string }) {
  return (
    <pre className="set-font-prev" style={{ fontFamily: stack }}>
      {renderSqlPreview(SQL_SAMPLE)}
    </pre>
  );
}

// Dropdown: bundled web fonts + canvas-probed system monos, with an optional
// queryLocalFonts() "Load all…" path on Chromium.
function MonoFontPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [sysFonts, setSysFonts] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement | null>(null);

  // Probe installed monospace faces when the menu first opens — synchronous +
  // cached, no permission. Done in the open handler (not an effect) so it
  // never triggers a cascading render.
  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next && !sysFonts.length) setSysFonts(detectSystemMonos());
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target))
        setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const meta = monoMetaFor(value);
  const bundled = Object.entries(MONO_FONTS);

  const loadAll = async () => {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> })
      .queryLocalFonts;
    if (!q) return;
    try {
      const fonts = await q();
      const fams = Array.from(new Set(fonts.map((f) => f.family))).filter((f) =>
        /mono|consol|courier|code|typewriter|terminal/i.test(f),
      );
      setSysFonts((prev) => Array.from(new Set(prev.concat(fams))).sort());
    } catch {
      /* permission denied — keep the probed list */
    }
  };

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const hasQueryLocalFonts = "queryLocalFonts" in window;

  return (
    <div className="mono-picker" ref={ref}>
      <button
        type="button"
        className={"mono-picker-btn" + (open ? " open" : "")}
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mono-picker-val" style={{ fontFamily: meta.stack }}>
          {meta.label}
        </span>
        {meta.system ? (
          <span className="mono-picker-tag sys">system</span>
        ) : meta.google ? (
          <span className="mono-picker-tag">bundled</span>
        ) : null}
        {meta.liga ? <span className="set-liga-tag">ligatures</span> : null}
        <span className="mono-picker-sample" style={{ fontFamily: meta.stack }}>
          {"=> != <= 0O1l"}
        </span>
        <Icon name={open ? "expand_less" : "expand_more"} size={18} />
      </button>
      {open ? (
        <div className="mono-picker-menu" role="listbox">
          <div className="mono-picker-group">Bundled with ByteTable</div>
          {bundled.map(([id, f]) => (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={value === id}
              className={"mono-picker-item" + (value === id ? " on" : "")}
              onClick={() => pick(id)}
            >
              <span className="mono-picker-item-name" style={{ fontFamily: f.stack }}>
                {f.label}
              </span>
              {f.liga ? <span className="set-liga-tag">lig</span> : null}
              {value === id ? (
                <Icon name="check" size={15} style={{ color: "var(--accent)" }} />
              ) : null}
            </button>
          ))}
          <div className="mono-picker-group">
            System fonts
            <span className="mono-picker-group-n">{sysFonts.length} detected</span>
          </div>
          {sysFonts.length ? (
            sysFonts.map((fam) => {
              const id = "sys:" + fam;
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={value === id}
                  className={"mono-picker-item" + (value === id ? " on" : "")}
                  onClick={() => pick(id)}
                >
                  <span
                    className="mono-picker-item-name"
                    style={{ fontFamily: `'${fam}', monospace` }}
                  >
                    {fam}
                  </span>
                  {value === id ? (
                    <Icon name="check" size={15} style={{ color: "var(--accent)" }} />
                  ) : null}
                </button>
              );
            })
          ) : (
            <div className="mono-picker-empty">
              No extra monospace fonts detected on this device.
            </div>
          )}
          {hasQueryLocalFonts ? (
            <button type="button" className="mono-picker-loadall" onClick={() => void loadAll()}>
              <Icon name="travel_explore" size={14} /> Load all installed fonts…
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- the modal ----

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useSettingsStore((s) => s.settings);
  const setSettingRaw = useSettingsStore((s) => s.setSetting);
  const reset = useSettingsStore((s) => s.reset);
  const toast = useToast();
  const [tab, setTab] = useState<TabId>("appearance");

  // Narrow helper so each call site stays type-safe per key.
  function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setSettingRaw(key, value);
  }

  const mono = monoMetaFor(settings.monoFont);

  // Group themes by their catalog `group`, preserving catalog order.
  const groups: Record<string, [ThemeId, Theme][]> = {};
  (Object.entries(THEMES) as [ThemeId, Theme][]).forEach(([id, th]) => {
    (groups[th.group] = groups[th.group] ?? []).push([id, th]);
  });

  return (
    <Modal onClose={onClose} className="set-modal" label="Settings">
      <div className="set-head">
        <Icon name="settings" size={18} style={{ color: "var(--accent)" }} />
        <div className="modal-title-text">Settings</div>
        <div style={{ flex: 1 }} />
        <IconBtn icon="close" onClick={onClose} title="Close (Esc)" />
      </div>

      <div className="set-body">
        <nav className="set-nav">
          {TABS.map((tb) => (
            <button
              key={tb.id}
              type="button"
              className={"set-nav-item" + (tab === tb.id ? " active" : "")}
              onClick={() => setTab(tb.id)}
            >
              <Icon name={tb.icon} size={16} /> {tb.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="set-nav-reset"
            onClick={() => {
              reset();
              toast("Settings reset to defaults");
            }}
          >
            <Icon name="restart_alt" size={15} /> Reset all
          </button>
        </nav>

        <div className="set-pane">
          {tab === "appearance" ? (
            <>
              <div className="set-section-label">Theme</div>
              {Object.entries(groups).map(([g, list]) => (
                <div key={g} className="set-theme-group">
                  <div className="set-theme-group-label">{g}</div>
                  <div className="set-theme-grid">
                    {list.map(([id, th]) => (
                      <ThemeSwatch
                        key={id}
                        id={id}
                        theme={th}
                        active={settings.theme === id}
                        onPick={(v) => setSetting("theme", v)}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <div className="set-section-label">Accent color</div>
              <SetRow label="Accent" hint="“Auto” follows the theme’s own accent">
                <div className="set-accents">
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={
                        "set-accent" +
                        (settings.accent === a ? " active" : "") +
                        (a === "auto" ? " auto" : "")
                      }
                      style={a === "auto" ? undefined : { background: a }}
                      onClick={() => setSetting("accent", a)}
                      title={a === "auto" ? "Auto (theme accent)" : a}
                      aria-pressed={settings.accent === a}
                    >
                      {a === "auto" ? (
                        <Icon name="auto_awesome" size={13} />
                      ) : settings.accent === a ? (
                        <Icon name="check" size={13} style={{ color: "var(--on-accent)" }} />
                      ) : null}
                    </button>
                  ))}
                </div>
              </SetRow>
              <SetRow label="Reduce motion" hint="Minimize animations and transitions">
                <SetToggle
                  on={settings.reduceMotion}
                  onChange={(v) => setSetting("reduceMotion", v)}
                />
              </SetRow>

              <div className="set-section-label">Layout</div>
              <SetRow label="Sidebar position" hint="Which side the table / object list sits on">
                <SetSeg<SidebarSide>
                  value={settings.sidebarSide}
                  onChange={(v) => setSetting("sidebarSide", v)}
                  options={[
                    { value: "left", label: "Left" },
                    { value: "right", label: "Right" },
                  ]}
                />
              </SetRow>
              {platform() !== "macos" && (
                <div style={{ paddingBottom: "200px" }}>
                  <SetRow
                    label="Title bar position"
                    hint="Top or bottom edge, and which side the controls are on"
                  >
                    <Select
                      value={settings.titlebarPosition}
                      onChange={(v) => setSetting("titlebarPosition", v)}
                      className="set-select"
                      mono={false}
                      options={[
                        { value: "topLeftIcon", label: "Top (Left icon)" },
                        { value: "topRightIcon", label: "Top (Right icon)" },
                        { value: "bottomLeftIcon", label: "Bottom (Left icon)" },
                        { value: "bottomRightIcon", label: "Bottom (Right icon)" },
                      ]}
                    />
                  </SetRow>
                </div>
              )}
            </>
          ) : null}

          {tab === "fonts" ? (
            <>
              <div className="set-section-label">Database client font</div>
              <MonoFontPicker
                value={settings.monoFont}
                onChange={(id) => setSetting("monoFont", id)}
              />
              <FontPreview stack={mono.stack} />
              <SetRow
                label="Font ligatures"
                hint="Render => != <= as combined glyphs (Fira / JetBrains / System)"
              >
                <SetToggle on={settings.ligatures} onChange={(v) => setSetting("ligatures", v)} />
              </SetRow>

              <div className="set-section-label">Interface font</div>
              <SetRow label="UI typeface">
                <Select
                  className="set-select"
                  value={settings.uiFont}
                  onChange={(id) => setSetting("uiFont", id)}
                  mono={false}
                  options={Object.entries(UI_FONTS).map(([id, f]) => ({
                    value: id as UiFontId,
                    label: f.label,
                  }))}
                />
              </SetRow>

              <div className="set-section-label">Text size</div>
              <SetRow
                label="App text size"
                hint={`Scales all text — chrome, editor, and grid (${Math.round((settings.fontSize / 13) * 100)}%)`}
              >
                <div className="set-size">
                  <button
                    type="button"
                    className="set-size-btn"
                    onClick={() => setSetting("fontSize", Math.max(10, settings.fontSize - 1))}
                    aria-label="Decrease size"
                  >
                    <Icon name="remove" size={15} />
                  </button>
                  <input
                    type="range"
                    min={10}
                    max={18}
                    step={1}
                    value={settings.fontSize}
                    onChange={(e) => setSetting("fontSize", Number(e.target.value))}
                    className="set-range"
                    aria-label="Monospace size"
                  />
                  <button
                    type="button"
                    className="set-size-btn"
                    onClick={() => setSetting("fontSize", Math.min(18, settings.fontSize + 1))}
                    aria-label="Increase size"
                  >
                    <Icon name="add" size={15} />
                  </button>
                  <span className="set-size-val">{settings.fontSize}px</span>
                </div>
              </SetRow>
            </>
          ) : null}

          {tab === "grid" ? (
            <>
              <div className="set-section-label">Row layout</div>
              <SetRow label="Density" hint="Row height in data tables">
                <SetSeg<Density>
                  value={settings.density}
                  onChange={(v) => setSetting("density", v)}
                  options={[
                    { value: "compact", label: "Compact" },
                    { value: "comfortable", label: "Comfortable" },
                  ]}
                />
              </SetRow>
              <SetRow label="Highlight active row" hint="Tint the row under the cursor">
                <SetToggle
                  on={settings.highlightRow}
                  onChange={(v) => setSetting("highlightRow", v)}
                />
              </SetRow>
              <div className="set-section-label">Query defaults</div>
              <SetRow
                label="Default row limit"
                hint="Rows fetched before paging — protects against huge tables"
              >
                <SetSeg<DefaultLimit>
                  value={settings.defaultLimit}
                  onChange={(v) => setSetting("defaultLimit", v)}
                  options={[
                    { value: 100, label: "100" },
                    { value: 300, label: "300" },
                    { value: 1000, label: "1000" },
                  ]}
                />
              </SetRow>
              <SetRow label="Relative timestamps" hint="Show “2h ago” instead of full datetimes">
                <SetToggle
                  on={settings.relativeTime}
                  onChange={(v) => setSetting("relativeTime", v)}
                />
              </SetRow>

              <div className="set-section-label">Live data</div>
              <SetRow
                label="Auto-refresh"
                hint="Periodically refresh the sidebar object list (and the Redis keyspace)"
              >
                <SetToggle
                  on={settings.autoRefresh}
                  onChange={(v) => setSetting("autoRefresh", v)}
                />
              </SetRow>
              {settings.autoRefresh ? (
                <SetRow label="Refresh every" hint="How often the lists re-check the server">
                  <SetSeg<AutoRefreshSec>
                    value={settings.autoRefreshSec}
                    onChange={(v) => setSetting("autoRefreshSec", v)}
                    options={[
                      { value: 5, label: "5s" },
                      { value: 10, label: "10s" },
                      { value: 30, label: "30s" },
                    ]}
                  />
                </SetRow>
              ) : null}
            </>
          ) : null}

          {tab === "behavior" ? (
            <>
              <div className="set-section-label">Safety</div>
              <SetRow
                label="Confirm writes on production"
                hint="Require a typed confirm for UPDATE / DELETE / TRUNCATE on prod connections"
              >
                <SetToggle
                  on={settings.confirmProd}
                  onChange={(v) => setSetting("confirmProd", v)}
                />
              </SetRow>
              <div className="set-section-label">Session</div>
              <SetRow label="Restore tabs on launch" hint="Reopen the tabs you had open last time">
                <SetToggle
                  on={settings.restoreTabs}
                  onChange={(v) => setSetting("restoreTabs", v)}
                />
              </SetRow>
              <div className="set-foot-note">
                <Icon name="lock" size={13} /> ByteTable is local-first — every setting is stored
                only on this machine. No account, no sync, no telemetry.
              </div>
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
