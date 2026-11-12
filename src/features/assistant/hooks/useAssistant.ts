// The assistant's view of the settings for one workspace: the current keys, a
// setter, the lock state and where prompts go.
//
// The destination rule and the lock are computed by the backend
// (`assistant_describe`) from the settings this window is showing — one
// implementation, in Rust, beside the gates that use it. Answers are cached by
// their inputs, so every surface on the same workspace (toolbar button, drawer,
// status chip) reads the same answer without a call each, and the last answer
// stays on screen while a new one is on its way (a keystroke in a URL field).
// Display only: every real call is re-gated by the backend.

import { useEffect, useMemo, useState } from "react";

import { useSettingsStore } from "../../settings/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { aiSettingsOf, assistantDescribe, type Described } from "../api";
import type { AiConn } from "../logic";

/** Before the first answer arrives (or outside Tauri): off, nowhere. */
const FALLBACK: Described = {
  dest: { local: true, host: "", via: "", model: "", custom: false, ready: false },
  state: "off",
  rowsAllowed: true,
  runtime: { host: "", name: "", loopback: false, ok: false },
  custom: { host: "", name: "", loopback: false, ok: false },
};

const answers = new Map<string, Described>();

type WorkspacesState = ReturnType<typeof useWorkspacesStore.getState>;
const active = (st: WorkspacesState) =>
  st.workspaces.find((w) => w.id === st.activeWorkspaceId) ?? null;

/**
 * `conn` is the workspace a surface belongs to. Without one (the Settings
 * pane) it is the ACTIVE workspace — and with no workspace open, the assistant
 * is off: the switch is per saved connection (`aiEnabledFor`).
 */
export function useAssistant(given: AiConn | null) {
  // The active workspace's saved connection, as primitives (stable selectors).
  const activeId = useWorkspacesStore((st) => active(st)?.saved.id ?? null);
  const activeEnv = useWorkspacesStore((st) => active(st)?.saved.env ?? "");
  const activeName = useWorkspacesStore((st) => active(st)?.saved.name ?? "");
  const conn = useMemo<AiConn | null>(
    () => given ?? (activeId ? { id: activeId, env: activeEnv, name: activeName } : null),
    [given, activeId, activeEnv, activeName],
  );
  const s = useSettingsStore((st) => st.settings);
  const setAi = useSettingsStore((st) => st.setSetting);
  const ai = useMemo(() => aiSettingsOf(s), [s]);
  const production = conn?.env === "production";
  const id = conn?.id ?? null;
  const key = useMemo(() => JSON.stringify([ai, production, id]), [ai, production, id]);
  const [last, setLast] = useState<Described | null>(null);

  useEffect(() => {
    if (answers.has(key)) return;
    let live = true;
    assistantDescribe(ai, production, id)
      .then((d) => {
        // Bounded: typing a URL makes a new key per keystroke.
        if (answers.size > 200) answers.clear();
        answers.set(key, d);
        if (live) setLast(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, ai, production, id]);

  const described = answers.get(key) ?? last ?? FALLBACK;
  return {
    s,
    setAi,
    state: described.state,
    d: described.dest,
    rowsAllowed: described.rowsAllowed,
    runtime: described.runtime,
    custom: described.custom,
    isProd: production,
    /** The workspace this answer is for (null = none open). */
    conn,
    /** On for this workspace (on or locked) — off with no workspace. */
    enabled: !!(conn && s.aiEnabledFor[conn.id]),
  };
}
