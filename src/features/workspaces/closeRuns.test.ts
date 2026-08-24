// Closing a set of result tabs from the strip's context menu. The interesting
// part is where focus lands: closing the tabs to the left of the focused one
// must not move it, and closing the focused one has to hand focus to a survivor
// rather than to a tab that is also on its way out.

import { beforeEach, describe, expect, it } from "vitest";

import { useWorkspacesStore } from "./state";
import type { SqlRun, Workspace } from "./types";

const WS = "ws-test";
const TAB = "tab-sql-test";

const run = (n: number): SqlRun => ({
  id: `r${n}`,
  sql: `SELECT ${n}`,
  result: null,
  error: null,
});

/** Seed a workspace holding one SQL tab with five results, focused on `active`. */
function seed(active: string) {
  const tab = {
    id: TAB,
    kind: "sql",
    title: "Query 1",
    runs: [run(1), run(2), run(3), run(4), run(5)],
    activeRunId: active,
    history: [],
  };
  useWorkspacesStore.setState({
    activeWorkspaceId: WS,
    workspaces: [{ id: WS, ui: { tabs: [tab] } } as unknown as Workspace],
  });
}

function state() {
  const ws = useWorkspacesStore.getState().workspaces[0];
  const tab = ws?.ui.tabs?.find((t) => t.id === TAB);
  if (!tab || tab.kind !== "sql") throw new Error("seed failed");
  return { ids: tab.runs.map((r) => r.id), active: tab.activeRunId };
}

describe("closeRuns", () => {
  beforeEach(() => seed("r3"));

  it("closes every id it is given", () => {
    useWorkspacesStore.getState().closeRuns(TAB, ["r1", "r2"]);
    expect(state().ids).toEqual(["r3", "r4", "r5"]);
  });

  it("leaves focus alone when the focused result survives", () => {
    // "Close to the left" of r3.
    useWorkspacesStore.getState().closeRuns(TAB, ["r1", "r2"]);
    expect(state().active).toBe("r3");
  });

  it("hands focus to the nearest survivor on the right", () => {
    useWorkspacesStore.getState().closeRuns(TAB, ["r2", "r3"]);
    expect(state().active).toBe("r4");
  });

  it("falls back to the left when nothing survives on the right", () => {
    // "Close to the right" of r2, plus the focused r3 itself.
    useWorkspacesStore.getState().closeRuns(TAB, ["r3", "r4", "r5"]);
    expect(state().ids).toEqual(["r1", "r2"]);
    expect(state().active).toBe("r2");
  });

  it("clears focus when everything is closed", () => {
    useWorkspacesStore.getState().closeRuns(TAB, ["r1", "r2", "r3", "r4", "r5"]);
    expect(state().ids).toEqual([]);
    expect(state().active).toBeNull();
  });

  it("is a no-op for an empty set", () => {
    useWorkspacesStore.getState().closeRuns(TAB, []);
    expect(state()).toEqual({ ids: ["r1", "r2", "r3", "r4", "r5"], active: "r3" });
  });
});
