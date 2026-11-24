// Data masking's runtime (M49): the switch and categories (from Settings), the
// columns shown in the clear (in memory only), and THE entry point every render
// site calls — `maskShow` / `maskText`. No render site decides for itself.
//
// Reading is synchronous (`getState`), so a cell can ask without subscribing:
// a VIEW subscribes once with `useMask()` (the grid, the inspector, the chart)
// and re-renders its cells, rather than every cell holding a subscription.

import { useEffect } from "react";
import { create } from "zustand";

import type { CellValue } from "../../shared/api/engine";
import { useSettingsStore } from "../settings/state";
import { baseName, kindOf, maskSqlText, render, type MaskConfig, type MaskKind } from "./mask";

interface MaskState {
  /** Column base names shown in the clear. Never saved. */
  revealed: ReadonlySet<string>;
  reveal: (col: string, on: boolean) => void;
  hideAll: () => void;
}

export const useMaskStore = create<MaskState>((set) => ({
  revealed: new Set(),
  reveal: (col, on) =>
    set((s) => {
      const next = new Set(s.revealed);
      if (on) next.add(baseName(col));
      else next.delete(baseName(col));
      return { revealed: next };
    }),
  hideAll: () => set({ revealed: new Set() }),
}));

// Safe by default: columns shown in the clear are forgotten every time masking
// is switched on — from any route (shortcut, status bar, menu, Settings).
let wasOn = useSettingsStore.getState().settings.maskOn;
useSettingsStore.subscribe((s) => {
  const on = s.settings.maskOn;
  if (on && !wasOn) useMaskStore.getState().hideAll();
  wasOn = on;
});

const settings = () => useSettingsStore.getState().settings;
const config = (): MaskConfig => settings();

export const maskOn = (): boolean => settings().maskOn;

export const isRevealed = (col: string): boolean =>
  useMaskStore.getState().revealed.has(baseName(col));

/**
 * The masked form of a value, or null when it is drawn as it is. Respects the
 * switch and the columns shown in the clear.
 */
export function maskShow(
  value: CellValue | unknown,
  col: string | null | undefined,
): { text: string; kind: MaskKind } | null {
  if (!maskOn() || value === null || value === undefined || value === "") return null;
  if (col && isRevealed(col)) return null;
  const kind = kindOf(value, col, config());
  return kind ? { text: render(value, kind), kind } : null;
}

/**
 * Like `maskShow`, judged by the column NAME only — for a value the user is
 * typing, which must not vanish mid-word because it started to look like an
 * email in a column that is not masked.
 */
export function maskShowByName(
  value: unknown,
  col: string,
): { text: string; kind: MaskKind } | null {
  if (!maskOn() || value === null || value === undefined || value === "" || isRevealed(col)) {
    return null;
  }
  const kind = kindOf(null, col, config());
  return kind ? { text: render(value, kind), kind } : null;
}

/** The text to draw: the masked text, or the value as a string. */
export function maskText(value: unknown, col: string | null | undefined): string {
  const m = maskShow(value, col);
  if (m) return m.text;
  if (value === null || value === undefined) return "NULL";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Is this column masked (looking at its name, then a sample of its values),
 * and is it currently shown in the clear? Null when masking is off or the
 * column is not sensitive.
 */
export function maskColumn(
  col: string,
  sample?: (CellValue | unknown)[],
): { kind: MaskKind; revealed: boolean } | null {
  if (!maskOn()) return null;
  const cfg = config();
  let kind = kindOf(null, col, cfg);
  if (!kind && sample) {
    for (let i = 0; i < sample.length && i < 40 && !kind; i++) kind = kindOf(sample[i], col, cfg);
  }
  return kind ? { kind, revealed: isRevealed(col) } : null;
}

/** Mask string literals in a SQL text (see `maskSqlText`). */
export function maskSql(sql: string, known?: ReadonlyMap<string, string>): string {
  return maskOn() && sql ? maskSqlText(sql, config(), known) : sql;
}

/** Turn masking on or off (every route goes through here). */
export function toggleMask(on?: boolean): void {
  const s = useSettingsStore.getState();
  s.setSetting("maskOn", on ?? !s.settings.maskOn);
}

/**
 * Re-render a VIEW when masking is switched, reconfigured, or a column is
 * shown / hidden. Returns a value that changes whenever any of that does, for
 * use as a memo dependency.
 */
export function useMask(): string {
  const s = useSettingsStore((st) => st.settings);
  const revealed = useMaskStore((st) => st.revealed);
  return [
    s.maskOn ? 1 : 0,
    s.maskEmail ? 1 : 0,
    s.maskPhone ? 1 : 0,
    s.maskSecret ? 1 : 0,
    s.maskPerson ? 1 : 0,
    s.maskCustom,
    [...revealed].join(","),
  ].join("|");
}

/** Run `fn` whenever masking flips on or off (not on mount). */
export function useOnMaskChange(fn: (on: boolean) => void): void {
  useEffect(
    () =>
      useSettingsStore.subscribe((s, prev) => {
        if (s.settings.maskOn !== prev.settings.maskOn) fn(s.settings.maskOn);
      }),
    [fn],
  );
}
