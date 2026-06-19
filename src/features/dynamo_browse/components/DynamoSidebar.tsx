// DynamoDB sidebar (M17 §17.1): the table list with search + per-table
// key-schema/GSI preview, the header icons (schema map `hub`, export-all
// `download`, dashboard `monitoring`), a refresh, the per-table context menu,
// and the PartiQL footer button. Ported from `DynamoSidebar` in `dynamo.jsx`.

import { useEffect, useState } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import type { TableDescriptor } from "../api";

interface DynamoSidebarProps {
  workspaceColor: string;
  workspaceName: string;
  envColor: string;
  envLabel: string;
  region: string;
  tables: TableDescriptor[];
  loading: boolean;
  activeTable: string | null;
  onOpenTable: (name: string) => void;
  onOpenPartiql: () => void;
  onOpenDashboard: () => void;
  onOpenMap: () => void;
  onExportTable: (name: string) => void;
  onImportTable: (name: string) => void;
  onExportAll: () => void;
  onRefresh: () => void;
  onCloseWorkspace: () => void;
}

interface CtxMenu {
  x: number;
  y: number;
  table: string;
}

export function DynamoSidebar({
  workspaceColor,
  workspaceName,
  envColor,
  envLabel,
  region,
  tables,
  loading,
  activeTable,
  onOpenTable,
  onOpenPartiql,
  onOpenDashboard,
  onOpenMap,
  onExportTable,
  onImportTable,
  onExportAll,
  onRefresh,
  onCloseWorkspace,
}: DynamoSidebarProps) {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  const filtered = tables.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [ctxMenu]);

  return (
    <aside className="sidebar ddb-sidebar">
      <div className="sidebar-conn ddb-sidebar-conn">
        <span className="ws-color-bar" style={{ background: workspaceColor }} />
        <EngineBadge engine="dynamodb" size={26} />
        <div className="sidebar-conn-info">
          <div className="sidebar-conn-name">{workspaceName}</div>
          <div className="sidebar-conn-detail">
            <span className="conn-env" style={{ color: envColor }}>
              {envLabel}
            </span>
            <span className="conn-eng">DynamoDB</span>
          </div>
        </div>
        <IconBtn
          icon="power_settings_new"
          title="Close workspace"
          onClick={onCloseWorkspace}
          size={16}
          danger
        />
      </div>

      <div className="ddb-schema-row">
        <button type="button" className="ddb-schema-btn" style={{ flex: 1 }} title="AWS region">
          <Icon name="public" size={15} style={{ color: "var(--accent)" }} />
          <span className="ddb-schema-btn-name">{region}</span>
        </button>
        <IconBtn icon="hub" title="Schema map (single-table design)" onClick={onOpenMap} />
        <IconBtn icon="download" title="Export all tables" onClick={onExportAll} />
        <IconBtn icon="monitoring" title="Tables dashboard" onClick={onOpenDashboard} />
        <IconBtn icon="refresh" title="Refresh tables" onClick={onRefresh} />
      </div>

      <div className="ddb-sidebar-search">
        <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
        <input
          placeholder="Filter tables…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="ddb-sidebar-section-label">
        <span>Tables</span>
        <span className="ddb-sidebar-count">{tables.length}</span>
      </div>

      <div className="ddb-sidebar-tables">
        {loading && tables.length === 0 ? <div className="ddb-sidebar-empty">Loading…</div> : null}
        {filtered.map((t) => {
          const open = expanded[t.name];
          return (
            <div key={t.name}>
              <div
                className={"ddb-table-item" + (t.name === activeTable ? " active" : "")}
                onClick={() => onOpenTable(t.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, table: t.name });
                }}
                title={t.name}
              >
                <button
                  type="button"
                  className={"ddb-table-expand" + (open ? " open" : "")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded({ ...expanded, [t.name]: !open });
                  }}
                >
                  <Icon name="chevron_right" size={14} />
                </button>
                <Icon
                  name="table_chart"
                  size={16}
                  style={{ color: t.name === activeTable ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="ddb-table-item-name">{t.name}</span>
              </div>
              {open ? (
                <div className="ddb-table-cols">
                  <div className="ddb-key-line">
                    <span className="ddb-key-badge pk">PK</span> {t.keySchema.pk}
                    {t.keySchema.sk ? (
                      <>
                        {" "}
                        <span className="ddb-key-badge sk">SK</span> {t.keySchema.sk}
                      </>
                    ) : null}
                  </div>
                  {t.gsis.map((g) => (
                    <div key={g.name} className="ddb-idx-line">
                      <Icon name="bolt" size={11} style={{ color: "#e2b340" }} /> {g.name}{" "}
                      <span className="ddb-idx-keys">
                        {g.pk}
                        {g.sk ? " / " + g.sk : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="ddb-sidebar-footer">
        <Btn
          icon="terminal"
          variant="tonal"
          onClick={onOpenPartiql}
          style={{ width: "100%", justifyContent: "center" }}
        >
          PartiQL editor
        </Btn>
      </div>

      {ctxMenu ? (
        <div
          className="ddb-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="ddb-ctx-item"
            onClick={() => {
              onOpenTable(ctxMenu.table);
              setCtxMenu(null);
            }}
          >
            <Icon name="table_chart" size={15} /> Open data
          </button>
          <button
            type="button"
            className="ddb-ctx-item"
            onClick={() => {
              onOpenMap();
              setCtxMenu(null);
            }}
          >
            <Icon name="hub" size={15} /> Show in schema map
          </button>
          <div className="ddb-ctx-sep" />
          <button
            type="button"
            className="ddb-ctx-item"
            onClick={() => {
              const tbl = ctxMenu.table;
              setCtxMenu(null);
              onExportTable(tbl);
            }}
          >
            <Icon name="download" size={15} /> Export table…
          </button>
          <button
            type="button"
            className="ddb-ctx-item"
            onClick={() => {
              const tbl = ctxMenu.table;
              setCtxMenu(null);
              onImportTable(tbl);
            }}
          >
            <Icon name="upload" size={15} /> Import items…
          </button>
        </div>
      ) : null}
    </aside>
  );
}
