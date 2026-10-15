import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS } from "../settings/api";
import { useSettingsStore } from "../settings/state";
import { liftLegacyHistory, SQL_HISTORY_HARD_MAX, withHistoryEntry } from "./state";
import type { SqlHistoryEntry, Tab } from "./types";

function entry(sql: string, ranAt = 0): SqlHistoryEntry {
  return { sql, ok: true, ranAt };
}

function setCap(sqlHistoryMax: number): void {
  useSettingsStore.setState({ settings: { ...DEFAULTS, sqlHistoryMax } });
}

function sqlTab(id: string, history?: SqlHistoryEntry[]): Tab {
  return {
    id,
    kind: "sql",
    title: id,
    text: "",
    runs: [],
    activeRunId: null,
    editorHeight: null,
    ...(history ? { history } : {}),
  };
}

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULTS } });
});

describe("withHistoryEntry", () => {
  it("keeps the newest first", () => {
    const after = withHistoryEntry([entry("one")], entry("two"));
    expect(after.map((h) => h.sql)).toEqual(["two", "one"]);
  });

  it("drops the oldest once the cap is reached", () => {
    setCap(5);
    let history = [] as SqlHistoryEntry[];
    for (const sql of ["1", "2", "3", "4", "5"]) history = withHistoryEntry(history, entry(sql));
    expect(history.map((h) => h.sql)).toEqual(["5", "4", "3", "2", "1"]);
    // The sixth evicts "1" — the oldest — and everything else shifts down.
    history = withHistoryEntry(history, entry("6"));
    expect(history.map((h) => h.sql)).toEqual(["6", "5", "4", "3", "2"]);
  });

  it("moves a re-run statement to the top instead of duplicating it", () => {
    setCap(5);
    const history = ["a", "b", "c"].reduce(
      (acc, sql) => withHistoryEntry(acc, entry(sql)),
      [] as SqlHistoryEntry[],
    );
    const after = withHistoryEntry(history, entry("a", 99));
    expect(after.map((h) => h.sql)).toEqual(["a", "c", "b"]);
    expect(after.filter((h) => h.sql === "a")).toHaveLength(1);
    // …carrying the NEW run's outcome, not the old one's.
    expect(after[0]?.ranAt).toBe(99);
  });

  it("clamps the setting to the app's ceiling and to at least one", () => {
    setCap(5000);
    let history = [] as SqlHistoryEntry[];
    for (let i = 0; i < SQL_HISTORY_HARD_MAX + 20; i++)
      history = withHistoryEntry(history, entry(`q${i}`));
    expect(history).toHaveLength(SQL_HISTORY_HARD_MAX);

    setCap(0);
    expect(withHistoryEntry(history, entry("only"))).toHaveLength(1);
  });

  it("defaults to 30 when the setting is missing (a session from an older build)", () => {
    useSettingsStore.setState({
      settings: { ...DEFAULTS, sqlHistoryMax: undefined as unknown as number },
    });
    let history = [] as SqlHistoryEntry[];
    for (let i = 0; i < 40; i++) history = withHistoryEntry(history, entry(`q${i}`));
    expect(history).toHaveLength(30);
  });
});

describe("liftLegacyHistory", () => {
  it("folds per-tab histories into the workspace list, newest first", () => {
    const ui = liftLegacyHistory({
      tabs: [sqlTab("t1", [entry("older", 10)]), sqlTab("t2", [entry("newer", 20)])],
    });
    expect(ui.history?.map((h) => h.sql)).toEqual(["newer", "older"]);
  });

  it("dedupes across tabs, keeping the most recent run of a statement", () => {
    const ui = liftLegacyHistory({
      tabs: [sqlTab("t1", [entry("same", 10)]), sqlTab("t2", [entry("same", 99)])],
    });
    expect(ui.history).toHaveLength(1);
    expect(ui.history?.[0]?.ranAt).toBe(99);
  });

  it("clears the tab copies so the migration runs once", () => {
    const ui = liftLegacyHistory({ tabs: [sqlTab("t1", [entry("x")])] });
    const tab = ui.tabs?.[0];
    expect(tab?.kind === "sql" && tab.history).toBeUndefined();
  });

  it("leaves a workspace with no legacy entries untouched", () => {
    const before = { tabs: [sqlTab("t1")], history: [entry("kept")] };
    expect(liftLegacyHistory(before)).toBe(before);
  });

  it("respects the cap while merging", () => {
    setCap(2);
    const ui = liftLegacyHistory({
      tabs: [sqlTab("t1", [entry("a", 1), entry("b", 2), entry("c", 3)])],
    });
    expect(ui.history?.map((h) => h.sql)).toEqual(["c", "b"]);
  });
});
