// Applies preferences to <html> data attributes, matching the Task-2 token
// layer: default values mean "no attribute", anything else sets it.

import { defaultPreferences, type Preferences } from "./api";

function setOrRemove(name: string, value: string, defaultValue: string): void {
  const root = document.documentElement;
  if (value === defaultValue) {
    root.removeAttribute(name);
  } else {
    root.setAttribute(name, value);
  }
}

export function applyTheme(preferences: Preferences): void {
  setOrRemove("data-accent", preferences.accent, defaultPreferences.accent);
  setOrRemove("data-darkness", preferences.darkness, defaultPreferences.darkness);
  setOrRemove("data-density", preferences.density, defaultPreferences.density);
}
