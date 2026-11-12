// Open Settings on the AI assistant tab — what every "off" state links to.

import { useSettingsStore } from "../settings/state";

export const openAiSettings = (): void => useSettingsStore.getState().openSettings("ai");
