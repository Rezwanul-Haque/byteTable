// The link between a SQL tab and the saved query its buffer came from. It is
// what makes "load a saved query, tweak it, save" an UPDATE instead of a second
// near-identical entry, so the rules worth pinning are: a load links, editing
// keeps the link, and replacing the buffer from anywhere else drops it.

import { beforeEach, describe, expect, it } from "vitest";

import { useWorkspacesStore } from "./state";
import type { Workspace } from "./types";

const WS = "ws-test";
const TAB = "tab-sql-test";

/** Seed a workspace holding one SQL tab, optionally already linked. */
function seed(savedQueryId: string | null = null) {
  const tab = {
    id: TAB,
    kind: "sql",
    title: "Query 1",
    text: "SELECT 1",
    runs: [],
    activeRunId: null,
    history: [],
    editorHeight: null,
    savedQueryId,
  };
  useWorkspacesStore.setState({
    activeWorkspaceId: WS,
    workspaces: [{ id: WS, ui: { tabs: [tab], activeTabId: TAB } } as unknown as Workspace],
  });
}

function sqlTabs() {
  const tabs = useWorkspacesStore.getState().workspaces[0]?.ui.tabs ?? [];
  return tabs.filter((t) => t.kind === "sql");
}

function linkOf(tabId: string) {
  const tab = sqlTabs().find((t) => t.id === tabId);
  if (!tab) throw new Error("seed failed");
  return tab.savedQueryId ?? null;
}

describe("saved-query link", () => {
  beforeEach(() => seed());

  it("starts unlinked on a fresh tab", () => {
    useWorkspacesStore.getState().openSqlTab();
    const fresh = sqlTabs().at(-1);
    expect(fresh?.savedQueryId).toBeNull();
  });

  it("links a tab opened with a saved query's SQL", () => {
    useWorkspacesStore.getState().openSqlTabWith("SELECT 2", "sq-7");
    const opened = sqlTabs().at(-1);
    expect(opened?.text).toBe("SELECT 2");
    expect(opened?.savedQueryId).toBe("sq-7");
  });

  it("leaves SQL opened for something other than a saved query unlinked", () => {
    // Object DDL / templates come through the same action without an id.
    useWorkspacesStore.getState().openSqlTabWith("CREATE VIEW v AS SELECT 1");
    expect(sqlTabs().at(-1)?.savedQueryId).toBeNull();
  });

  it("keeps the link while the buffer is edited", () => {
    seed("sq-7");
    useWorkspacesStore.getState().setSqlText(TAB, "SELECT 1 -- tweaked");
    expect(linkOf(TAB)).toBe("sq-7");
  });

  it("links an existing tab when a saved query is loaded into it", () => {
    useWorkspacesStore.getState().setSqlSavedLink(TAB, "sq-7");
    expect(linkOf(TAB)).toBe("sq-7");
  });

  it("unlinks on request (snippet, history entry, opened file)", () => {
    seed("sq-7");
    useWorkspacesStore.getState().setSqlSavedLink(TAB, null);
    expect(linkOf(TAB)).toBeNull();
  });
});
