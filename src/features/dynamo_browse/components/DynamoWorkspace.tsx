// DynamoDB workspace shell (M17) — the third sibling of WorkspaceShell /
// RedisWorkspace the App routes to when a connection's kind is "document". Same
// frame (sidebar | tab bar + content | status bar) but every inner piece is
// document-store shaped. Opens on the Dashboard tab (§17.1). Tab kinds:
// dashboard / table / map. PartiQL is NOT a tab — it docks as the shared bottom
// TerminalPanel (like the SQL/Redis console), per dynamo-shell.jsx.

import { useCallback, useEffect, useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { connectionDetail } from "../../connections/api";
import { TerminalPanel } from "../../console/TerminalPanel";
import { shellLabel, usePanelStore } from "../../console/state";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { Icon } from "../../../shared/ui/Icon";
import { useWorkspacesStore } from "../../workspaces/state";
import type { Workspace } from "../../workspaces/types";
import { dynamoListTables, type TableDescriptor } from "../api";
import { DynamoDashboard } from "./DynamoDashboard";
import { DynamoExportModal, DynamoImportModal } from "./DynamoIoModals";
import { DynamoSchemaMap } from "./DynamoSchemaMap";
import { DynamoSidebar } from "./DynamoSidebar";
import { DynamoTableTab } from "./DynamoTableTab";
import "./Dynamo.css";

type TabKind = "dashboard" | "table" | "map";

interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  table?: string;
  mode?: "scan" | "query" | "structure";
}

const TAB_ICON: Record<TabKind, string> = {
  table: "table_chart",
  dashboard: "monitoring",
  map: "hub",
};

let seq = 0;
const nextId = () => "ddb-" + ++seq;

export function DynamoWorkspace({ workspace }: { workspace: Workspace }) {
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);
  const handleId = workspace.handleId;
  const params = workspace.saved.params;
  const region = params.engine === "dynamodb" ? params.region : "";
  const env = workspace.saved.env;
  const envColor = ENV_COLOR[env];
  const isProduction = env === "production";

  const [tables, setTables] = useState<TableDescriptor[]>([]);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  const [tabs, setTabs] = useState<Tab[]>([
    { id: "ddb-dash", kind: "dashboard", title: "Dashboard" },
  ]);
  const [activeId, setActiveId] = useState("ddb-dash");

  const [exportJob, setExportJob] = useState<{ scope: "table" | "all"; table?: string } | null>(
    null,
  );
  const [importTarget, setImportTarget] = useState<string | null>(null);

  // PartiQL docks as the shared bottom terminal panel (keyed by workspace id).
  const termLabel = shellLabel(workspace.saved.engine);
  const openPanel = usePanelStore((s) => s.openPanel);
  const togglePanel = usePanelStore((s) => s.togglePanel);
  const openPartiql = useCallback(
    () => openPanel(workspace.id, termLabel),
    [openPanel, workspace.id, termLabel],
  );

  // Ctrl+` toggles the PartiQL panel (the VS Code convention, mirroring the
  // SQL/Redis workspaces).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        togglePanel(workspace.id, termLabel);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel, workspace.id, termLabel]);

  const refreshTables = useCallback(async () => {
    setTablesLoading(true);
    setTablesError(null);
    try {
      const list = await dynamoListTables(handleId);
      setTables(list);
    } catch (e) {
      setTablesError(
        isAppErrorPayload(e) ? e.message : "Could not list tables (desktop app required)",
      );
    } finally {
      setTablesLoading(false);
    }
  }, [handleId]);

  useEffect(() => {
    void refreshTables();
  }, [refreshTables]);

  const activeTab = tabs.find((t) => t.id === activeId);

  const openTable = (name: string) => {
    const ex = tabs.find((t) => t.kind === "table" && t.table === name);
    if (ex) {
      setActiveId(ex.id);
      return;
    }
    const tab: Tab = { id: nextId(), kind: "table", table: name, title: name, mode: "scan" };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };
  const openSingleton = (kind: "dashboard" | "map", title: string) => {
    const ex = tabs.find((t) => t.kind === kind);
    if (ex) {
      setActiveId(ex.id);
      return;
    }
    const tab: Tab = { id: nextId(), kind, title };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };
  const updateTab = (id: string, patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const closeTab = (id: string) =>
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      const fallback = next[Math.max(0, idx - 1)];
      if (id === activeId && fallback) setActiveId(fallback.id);
      return next;
    });

  const detail = connectionDetail(params);
  const descOf = (name?: string) => tables.find((t) => t.name === name);

  return (
    <div
      className="workspace ddb-workspace"
      data-screen-label={"DynamoDB workspace: " + workspace.name}
    >
      <DynamoSidebar
        workspaceColor={workspace.color}
        workspaceName={workspace.name}
        envColor={envColor}
        envLabel={env}
        region={region}
        tables={tables}
        loading={tablesLoading}
        activeTable={activeTab?.kind === "table" ? (activeTab.table ?? null) : null}
        onOpenTable={openTable}
        onOpenPartiql={openPartiql}
        onOpenDashboard={() => openSingleton("dashboard", "Dashboard")}
        onOpenMap={() => openSingleton("map", "Schema map")}
        onExportTable={(t) => setExportJob({ scope: "table", table: t })}
        onImportTable={(t) => setImportTarget(t)}
        onExportAll={() => setExportJob({ scope: "all" })}
        onRefresh={() => void refreshTables()}
        onCloseWorkspace={() => closeWorkspace(workspace.id)}
      />
      <main className="main-col ddb-main">
        <div className="ddb-tabbar">
          <div className="ddb-tabbar-tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={"ddb-tab" + (t.id === activeId ? " active" : "")}
                onClick={() => setActiveId(t.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(t.id);
                  }
                }}
                title={t.title}
              >
                <Icon
                  name={TAB_ICON[t.kind]}
                  size={14}
                  style={{ color: t.id === activeId ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="ddb-tab-title">{t.title}</span>
                {t.kind !== "dashboard" ? (
                  <button
                    type="button"
                    className="ddb-tab-close"
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
          <div className="ddb-tabbar-tools">
            <button
              type="button"
              className="ddb-tabbar-tool"
              onClick={openPartiql}
              title="PartiQL editor (Ctrl+`)"
            >
              <Icon name="terminal" size={15} />
              <span>PartiQL</span>
            </button>
          </div>
        </div>

        <div className="ddb-tab-content">
          {tabs.map((t) => (
            <div key={t.id} style={{ display: t.id === activeId ? "contents" : "none" }}>
              {t.kind === "dashboard" ? (
                <DynamoDashboard
                  tables={tables}
                  region={region}
                  loading={tablesLoading}
                  error={tablesError}
                />
              ) : t.kind === "map" ? (
                <DynamoSchemaMap handleId={handleId} tables={tables} onOpenTable={openTable} />
              ) : t.table && descOf(t.table) ? (
                <DynamoTableTab
                  table={descOf(t.table) as TableDescriptor}
                  handleId={handleId}
                  isProduction={isProduction}
                  mode={t.mode ?? "scan"}
                  onModeChange={(mode) => updateTab(t.id, { mode })}
                  version={dataVersion}
                  onExport={(tbl) => setExportJob({ scope: "table", table: tbl })}
                  onImport={(tbl) => setImportTarget(tbl)}
                />
              ) : (
                <div className="ddb-dash-empty">Table “{t.table}” is no longer available.</div>
              )}
            </div>
          ))}
        </div>
        {/* PartiQL docks here (above the status bar), only when open. */}
        <TerminalPanel workspace={workspace} />
      </main>

      <div className="ddb-statusbar">
        <span className="ws-chip" style={{ background: workspace.color }} />
        <span className="ddb-status-strong">{workspace.name}</span>
        <span
          className="env-tag"
          style={{ color: envColor, borderColor: envColor + "66", background: envColor + "14" }}
        >
          {env}
        </span>
        <span className="ddb-status-dim">{workspace.info.serverVersion}</span>
        <span className="ddb-status-dim">
          <Icon name="public" size={11} /> {detail}
        </span>
        <div style={{ flex: 1 }} />
        {activeTab?.kind === "table" && descOf(activeTab.table) ? (
          <span className="ddb-status-dim">
            {descOf(activeTab.table)?.itemCount.toLocaleString()} items
          </span>
        ) : null}
      </div>

      {exportJob ? (
        <DynamoExportModal
          scope={exportJob.scope}
          table={exportJob.table}
          handleId={handleId}
          tables={tables}
          region={region}
          onClose={() => setExportJob(null)}
        />
      ) : null}
      {importTarget && descOf(importTarget) ? (
        <DynamoImportModal
          table={importTarget}
          tableDescriptor={descOf(importTarget) as TableDescriptor}
          handleId={handleId}
          onClose={() => setImportTarget(null)}
          onDone={() => {
            setImportTarget(null);
            setDataVersion((v) => v + 1);
            void refreshTables();
          }}
        />
      ) : null}
    </div>
  );
}
