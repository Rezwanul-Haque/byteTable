// Typed invoke() wrappers for the preferences slice's Tauri commands.
// String literals mirror the Rust enums (serde rename_all = "lowercase").

import { invoke } from "@tauri-apps/api/core";

export type Accent = "teal" | "blue" | "violet" | "amber";
export type Darkness = "charcoal" | "black" | "soft";
export type Density = "compact" | "comfortable";

export interface Preferences {
  accent: Accent;
  darkness: Darkness;
  density: Density;
}

export const defaultPreferences: Preferences = {
  accent: "teal",
  darkness: "charcoal",
  density: "compact",
};

export function prefsGet(): Promise<Preferences> {
  return invoke<Preferences>("prefs_get");
}

export function prefsSet(preferences: Preferences): Promise<void> {
  return invoke("prefs_set", { preferences });
}
