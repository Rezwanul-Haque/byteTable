// Typesense workspace shell (M30 Task 5) — the sixth sibling of WorkspaceShell /
// RedisWorkspace / DynamoWorkspace / MongoWorkspace / CassandraWorkspace the App
// routes to when a connection's kind is "typesense". Same frame (sidebar | tab
// bar + content | status bar). Opens on the Cluster dashboard.
//
// Tab kinds: search | schema | docs | curation | keys | dashboard. Search tabs
// are per collection and titled `Search · <collection>`; every other kind is a
// singleton that follows the sidebar's selected collection.
//
// Shortcuts: ⌘T opens a search playground for the current collection, Ctrl/⌘+`
// toggles the HTTP console, `/` focuses the search input.
//
// Key scope drives the whole load path. With a search-only key `GET /collections`
// is refused and a scoped key's allowed collections cannot be read back at all,
// so the sidebar falls back to the single collection configured on the
// connection. That is not an error state — see `loadCollections`.

import { useCallback, useEffect, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../../shared/api/error";
import { Icon } from "../../../../shared/ui/Icon";
import { BuiltByCredit } from "../../../../shared/ui/BuiltByCredit";
import { SidebarResizer } from "../../../../shared/ui/SidebarResizer";
import { ENV_COLOR } from "../../../../shared/ui/envColors";
import { useTabMenu } from "../../../../shared/ui/useTabMenu";
import { useToast } from "../../../../shared/ui/toastContext";
import { connectionDetail } from "../../../connections/api";
import { TerminalPanel } from "../../../console/TerminalPanel";
import { shellLabel, usePanelStore } from "../../../console/state";
import { useAutoRefresh } from "../../../settings/useAutoRefresh";
import { useWorkspacesStore } from "../../../workspaces/state";
import type { Workspace } from "../../../workspaces/types";
import {
  typesenseAliases,
  typesenseAnalytics,
  typesenseCapabilities,
  typesenseCollection,
  typesenseCollections,
  typesenseClusterStats,
  typesenseNodes,
  type AliasInfo,
  type AnalyticsOverview,
  type ClusterStats,
  type CollectionDescriptor,
  type NodeInfo,
  type ServerCapabilities,
} from "../api";
import { tsCount } from "../format";
import { useTsTabsStore } from "../workspaceTabs";
import { TsCurationTab } from "./TsCurationTab";
import { TsDocsTab } from "./TsDocsTab";
import { TsKeysTab } from "./TsKeysTab";
import { TsSchemaTab } from "./TsSchemaTab";
import { TsSearchTab } from "./TsSearchTab";
import { TypesenseDashboard } from "./TypesenseDashboard";
import { TypesenseSidebar, type TsSectionKind } from "./TypesenseSidebar";
// Shared chrome the Typesense slice REUSES (importing the owning components' CSS
// keeps the workspace self-contained in `vite dev` and prod alike).
import "../../../workspaces/components/WorkspaceContent.css";
import "../../../workspaces/components/Sidebar.css";
import "../../../workspaces/components/TabBar.css";
import "../../../workspaces/components/StatusBar.css";
import "../../../workspaces/components/TableTab.css"; // .table-footer / .pager / .seg
import "../../../workspaces/components/SqlEditorTab.css"; // .snippet-chip
import "../../shared/StructureView.css";
import "../../shared/dashboard.css";
import "../../shared/mongoShared.css"; // .mg-mono
import "../../cassandra/components/Cassandra.css"; // .cass-dash-num / .cass-dash-key
import "../../../console/SqlTerminalTab.css"; // .rcli-* terminal chrome
import "../../../console/TerminalPanel.css";
import "./Typesense.css";

const TAB_ICON: Record<string, string> = {
  search: "search",
  schema: "schema",
  docs: "data_object",
  curation: "tune",
  keys: "key",
  dashboard: "monitoring",
};

export interface TsTab {
  id: string;
  kind: "search" | "schema" | "docs" | "curation" | "keys" | "dashboard";
  title: string;
  /** Search tabs are per collection; the other kinds follow the sidebar. */
  coll?: string;
  /** A query seeded from elsewhere (a curation rule, a popular query). */
  seedQuery?: string;
}

const SECTION_TITLE: Record<TsSectionKind, string> = {
  schema: "Schema",
  docs: "Documents",
  curation: "Curation",
  keys: "API keys",
};

let seq = 0;
const nextId = (p: string) => "ts-" + p + "-" + ++seq;

export function TypesenseWorkspace({ workspace }: { workspace: Workspace }) {
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);
  const toast = useToast();
  const openPanel = usePanelStore((s) => s.openPanel);
  const togglePanel = usePanelStore((s) => s.togglePanel);
  const termLabel = shellLabel("typesense");
  const handleId = workspace.handleId;
  const env = workspace.saved.env;
  const envColor = ENV_COLOR[env];
  const detail = connectionDetail(workspace.saved.params);

  const ensureTabs = useTsTabsStore((s) => s.ensure);
  const patchTabs = useTsTabsStore((s) => s.patch);
  const tabState = useTsTabsStore((s) => s.byWorkspace[workspace.id]);
  const tabs: TsTab[] = tabState?.tabs ?? [{ id: "ts-dash", kind: "dashboard", title: "Cluster" }];
  const activeId = tabState?.activeId ?? "ts-dash";
  const coll = tabState?.coll ?? "";

  const peekTabs = () => useTsTabsStore.getState().byWorkspace[workspace.id]?.tabs ?? tabs;
  const setTabs = (next: TsTab[] | ((ts: TsTab[]) => TsTab[])) =>
    patchTabs(workspace.id, { tabs: typeof next === "function" ? next(peekTabs()) : next });
  const setActiveId = (id: string) => patchTabs(workspace.id, { activeId: id });
  const setColl = (c: string) => patchTabs(workspace.id, { coll: c });

  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [collections, setCollections] = useState<CollectionDescriptor[]>([]);
  const [aliases, setAliases] = useState<AliasInfo[]>([]);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [stats, setStats] = useState<ClusterStats | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a write so the document tab and the counts reload.
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * Load the collection list, honouring key scope.
   *
   * An admin key lists everything. A search-only key gets a 401 from
   * `/collections` — and because a scoped key's allowed collections are baked
   * into the key with no endpoint to read them back, the *only* name we can try
   * is the `defaultCollection` configured on the connection. Fetching that one
   * collection's schema directly works (it is a per-collection read the scoped
   * key is allowed), so the workspace stays usable with exactly one collection.
   */
  const loadCollections = useCallback(
    async (caps: ServerCapabilities): Promise<CollectionDescriptor[]> => {
      if (caps.adminKey) return typesenseCollections(handleId);
      if (!caps.defaultCollection) return [];
      try {
        return [await typesenseCollection(handleId, caps.defaultCollection)];
      } catch {
        return [];
      }
    },
    [handleId],
  );

  const loadAll = useCallback(async () => {
    const caps = await typesenseCapabilities(handleId);
    setCapabilities(caps);
    const [list, aliasList, nodeList, clusterStats, an] = await Promise.all([
      loadCollections(caps),
      caps.adminKey ? typesenseAliases(handleId).catch(() => []) : Promise.resolve([]),
      typesenseNodes(handleId).catch(() => []),
      typesenseClusterStats(handleId).catch(() => null),
      typesenseAnalytics(handleId).catch(() => null),
    ]);
    setCollections(list);
    setAliases(aliasList);
    setNodes(nodeList);
    setStats(clusterStats);
    setAnalytics(an);
    return { caps, list };
  }, [handleId, loadCollections]);

  // Initial load. The selected collection prefers the persisted one, then the
  // connection's configured default, then the first listed.
  useEffect(() => {
    ensureTabs(workspace.id);
    let live = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { caps, list } = await loadAll();
        if (!live) return;
        const stored = useTsTabsStore.getState().byWorkspace[workspace.id]?.coll ?? "";
        const target =
          (stored && list.some((c) => c.name === stored) ? stored : "") ||
          (caps.defaultCollection && list.some((c) => c.name === caps.defaultCollection)
            ? caps.defaultCollection
            : "") ||
          list[0]?.name ||
          "";
        if (target && target !== stored) setColl(target);
      } catch (e) {
        if (!live) return;
        setError(isAppErrorPayload(e) ? e.message : "Could not reach the Typesense cluster.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, workspace.id, loadAll]);

  // Drop this workspace's persisted tab state when it is CLOSED (not on a mere
  // switch): on unmount, prune only if the workspace is gone from the store.
  useEffect(() => {
    const wsId = workspace.id;
    return () => {
      const stillOpen = useWorkspacesStore.getState().workspaces.some((w) => w.id === wsId);
      if (!stillOpen) useTsTabsStore.getState().prune(wsId);
    };
  }, [workspace.id]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const collection = collections.find((c) => c.name === coll) ?? null;
  const adminKey = capabilities?.adminKey ?? false;

  const openSearch = (target?: string, seedQuery?: string) => {
    const name = target || coll;
    if (!name) return;
    if (name !== coll) setColl(name);
    const existing = peekTabs().find((t) => t.kind === "search" && t.coll === name);
    if (existing) {
      // Re-opening with a seeded query rewrites the tab's seed so the playground
      // picks it up; without one, it is a plain focus.
      if (seedQuery !== undefined) {
        setTabs((ts) => ts.map((t) => (t.id === existing.id ? { ...t, seedQuery } : t)));
      }
      setActiveId(existing.id);
      return;
    }
    const tab: TsTab = {
      id: nextId("s-" + name),
      kind: "search",
      title: "Search · " + name,
      coll: name,
      seedQuery,
    };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };

  const openSection = (kind: TsSectionKind, target?: string) => {
    if (target && target !== coll) setColl(target);
    const existing = peekTabs().find((t) => t.kind === kind);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const tab: TsTab = { id: nextId(kind), kind, title: SECTION_TITLE[kind] };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };

  const openDashboard = () => {
    const existing = peekTabs().find((t) => t.kind === "dashboard");
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const tab: TsTab = { id: nextId("dash"), kind: "dashboard", title: "Cluster" };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) =>
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      const fallback = next[Math.max(0, idx - 1)];
      if (id === activeId && fallback) setActiveId(fallback.id);
      return next;
    });

  const refresh = () => {
    void loadAll().catch(() => {});
    setReloadKey((k) => k + 1);
    toast("Cluster metadata refreshed", "ok");
  };

  // Settings-driven auto-refresh of the collection list (silent — no toast).
  const refreshSpinning = useAutoRefresh(() => {
    void loadAll().catch(() => {});
  });

  const openShell = () => openPanel(workspace.id, termLabel);
  const toggleShell = () => togglePanel(workspace.id, termLabel);

  const tabMenu = useTabMenu({
    ids: tabs.map((t) => t.id),
    close: (ids) => ids.forEach(closeTab),
    canClose: (id) => tabs.find((t) => t.id === id)?.kind !== "dashboard",
  });

  // ⌘T → a search playground for the current collection; Ctrl/⌘+` → the HTTP
  // console; `/` → focus the playground's query input from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "t" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        openSearch();
      }
      if (e.key === "`" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleShell();
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = document.activeElement;
        // Never steal `/` from a field the user is already typing in.
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
        const box = document.querySelector<HTMLInputElement>(".ts-qinput");
        if (box) {
          e.preventDefault();
          box.focus();
        }
      }
      if (e.metaKey && e.key.toLowerCase() === "w") {
        const st = useTsTabsStore.getState().byWorkspace[workspace.id];
        if (st?.tabs.length && st.activeId) {
          e.preventDefault();
          const idx = st.tabs.findIndex((t) => t.id === st.activeId);
          const next = st.tabs.filter((t) => t.id !== st.activeId);
          const fallback = next[Math.max(0, idx - 1)];
          useTsTabsStore
            .getState()
            .patch(workspace.id, { tabs: next, activeId: fallback?.id ?? next[0]?.id ?? "" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, coll]);

  // Scroll the active tab into view when it changes.
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  return (
    <div className="workspace" data-screen-label={"Typesense workspace: " + workspace.name}>
      <TypesenseSidebar
        workspaceName={workspace.name}
        workspaceColor={workspace.color}
        env={env}
        envColor={envColor}
        detail={detail}
        collections={collections}
        aliases={aliases}
        coll={coll}
        activeKind={activeTab?.kind ?? null}
        nodeCount={nodes.length || 1}
        healthy={stats?.healthy ?? nodes.every((n) => n.healthy)}
        version={capabilities?.version ?? ""}
        adminKey={adminKey}
        onOpenSearch={(c) => openSearch(c)}
        onOpenSection={openSection}
        onOpenDashboard={openDashboard}
        onOpenConsole={openShell}
        onRefresh={refresh}
        refreshing={refreshSpinning}
        onCloseWorkspace={() => closeWorkspace(workspace.id)}
      />
      <SidebarResizer />
      <div className="main-col">
        <div className="tabbar" data-screen-label="Typesense tab bar">
          <div className="tabbar-tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                ref={t.id === activeId ? activeTabRef : undefined}
                className={"tab" + (t.id === activeId ? " active" : "")}
                onClick={() => setActiveId(t.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(t.id);
                  }
                }}
                onContextMenu={(e) => tabMenu.onContextMenu(e, t.id)}
                title={t.title}
              >
                <Icon
                  name={TAB_ICON[t.kind] ?? "circle"}
                  size={14}
                  style={{ color: t.id === activeId ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="tab-title">{t.title}</span>
                {t.kind !== "dashboard" ? (
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <button
            className="tab-new"
            onClick={() => openSearch()}
            title="New search playground (⌘T)"
            disabled={!coll}
          >
            <Icon name="add" size={16} />
          </button>
          <div className="tabbar-tools">
            <button
              className="tabbar-tool"
              onClick={toggleShell}
              title="HTTP console (⌘` / Ctrl+`)"
            >
              <Icon name="terminal" size={15} />
              <span>HTTP console</span>
            </button>
          </div>
          {tabMenu.element}
        </div>

        <div className="tab-content">
          {error ? (
            <div className="ts-empty">
              <Icon name="error" size={26} style={{ color: "var(--danger)" }} />
              <p>{error}</p>
            </div>
          ) : (
            tabs.map((t) => (
              <div key={t.id} style={{ display: t.id === activeId ? "contents" : "none" }}>
                {t.kind === "dashboard" ? (
                  <TypesenseDashboard
                    version={capabilities?.version ?? ""}
                    stats={stats}
                    nodes={nodes}
                    collections={collections}
                    analytics={analytics}
                    adminKey={adminKey}
                    loading={loading}
                    onOpenSearch={(c, seed) => openSearch(c, seed)}
                    onOpenSchema={(c) => openSection("schema", c)}
                  />
                ) : t.kind === "schema" ? (
                  <TsSchemaTab collection={collection} loading={loading} />
                ) : t.kind === "docs" ? (
                  <TsDocsTab
                    handleId={handleId}
                    collection={collection}
                    reloadKey={reloadKey}
                    onChanged={() => {
                      void loadAll().catch(() => {});
                    }}
                  />
                ) : t.kind === "curation" ? (
                  <TsCurationTab
                    handleId={handleId}
                    collection={coll}
                    adminKey={adminKey}
                    onOpenSearch={(c, seed) => openSearch(c, seed)}
                  />
                ) : t.kind === "keys" ? (
                  <TsKeysTab handleId={handleId} adminKey={adminKey} aliases={aliases} />
                ) : (
                  <TsSearchTab
                    handleId={handleId}
                    collection={collections.find((c) => c.name === t.coll) ?? null}
                    seedQuery={t.seedQuery}
                    onSeedConsumed={() =>
                      setTabs((ts) =>
                        ts.map((x) => (x.id === t.id ? { ...x, seedQuery: undefined } : x)),
                      )
                    }
                    popularQueries={analytics?.popularQueries ?? []}
                    adminKey={adminKey}
                  />
                )}
              </div>
            ))
          )}
        </div>

        {/* The HTTP console docks here (above the status bar), like the other
            engines' REPLs. */}
        <TerminalPanel workspace={workspace} />
      </div>

      <div className="statusbar" data-screen-label="Typesense status bar">
        <span className="ws-chip" style={{ background: workspace.color }} />
        <span className="status-strong">{workspace.name}</span>
        <span
          className="env-tag"
          style={{ color: envColor, borderColor: envColor + "66", background: envColor + "14" }}
        >
          {env}
        </span>
        <span className="status-dim">{workspace.info.serverVersion}</span>
        {collection ? (
          <span className="status-dim">
            <Icon name="database" size={11} /> {collection.name} ·{" "}
            {tsCount(collection.numDocuments)} docs
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        {!adminKey ? <span className="status-dim">search-only key</span> : null}
        <span className="status-dim">
          {nodes.length || 1} {(nodes.length || 1) === 1 ? "node" : "nodes"} ·{" "}
          {(stats?.healthy ?? nodes.every((n) => n.healthy)) ? "healthy" : "degraded"}
        </span>
        <BuiltByCredit className="status-dim" />
      </div>
    </div>
  );
}
