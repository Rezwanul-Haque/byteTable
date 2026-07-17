// DynamoDB sidebar (M17 §17.1): the table list with search + per-table
// key-schema/GSI preview, the header icons (schema map `hub`, export-all
// `download`, dashboard `monitoring`), a refresh, the per-table context menu,
// and the PartiQL footer button. Ported from `DynamoSidebar` in `dynamo.jsx`.

import { useEffect, useState } from "react";

import { Btn } from "../../../../shared/ui/Btn";
import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
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
  showDashboard?: boolean;
  onOpenMap: () => void;
  onExportTable: (name: string) => void;
  onImportTable: (name: string) => void;
  onExportAll: () => void;
  onRefresh: () => void;
  /** Spin the refresh icon while an auto-refresh tick is in flight. */
  refreshing?: boolean;
  onCloseWorkspace: () => void;
}

interface CtxMenu {
  x: number;
  y: number;
  /** Set for a per-table menu (right-click a table row). */
  table?: string;
  /** Set for the database-actions menu (the section-label ⋯ button). */
  db?: boolean;
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
  refreshing,
  onCloseWorkspace,
  showDashboard = true,
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
        <IconBtn icon="schema" title="Schema map (single-table design)" onClick={onOpenMap} />
        <IconBtn icon="download" title="Export all tables" onClick={onExportAll} />
        {showDashboard ? (
          <IconBtn icon="monitoring" title="Tables dashboard" onClick={onOpenDashboard} />
        ) : null}
        <IconBtn
          icon="sync"
          title="Refresh tables"
          onClick={onRefresh}
          className={refreshing ? "sidebar-sync-spinning" : undefined}
        />
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
        <div
          className="sec-actions"
          style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}
        >
          <span className="ddb-sidebar-count">{tables.length}</span>
          <button
            type="button"
            className="sec-actions-btn"
            title="Database actions"
            onClick={(e) => {
              e.stopPropagation();
              // Toggle: a second press on the open db-actions menu closes it.
              if (ctxMenu?.db) {
                setCtxMenu(null);
                return;
              }
              const r = e.currentTarget.getBoundingClientRect();
              setCtxMenu({ x: r.right - 196, y: r.bottom + 4, db: true });
            }}
          >
            <Icon name="more_horiz" size={15} />
          </button>
        </div>
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
          {ctxMenu.db ? (
            <>
              <button
                type="button"
                className="ddb-ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onExportAll();
                }}
              >
                <Icon name="download" size={15} /> Export all tables…
              </button>
              <button
                type="button"
                className="ddb-ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onOpenPartiql();
                }}
              >
                <Icon name="terminal" size={15} /> PartiQL editor
              </button>
              <div className="ddb-ctx-sep" />
              <button
                type="button"
                className="ddb-ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onRefresh();
                }}
              >
                <Icon name="refresh" size={15} /> Refresh
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ddb-ctx-item"
                onClick={() => {
                  if (ctxMenu.table) onOpenTable(ctxMenu.table);
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
                <Icon name="schema" size={15} /> Show in schema map
              </button>
              <div className="ddb-ctx-sep" />
              <button
                type="button"
                className="ddb-ctx-item"
                onClick={() => {
                  const tbl = ctxMenu.table;
                  setCtxMenu(null);
                  if (tbl) onExportTable(tbl);
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
                  if (tbl) onImportTable(tbl);
                }}
              >
                <Icon name="upload" size={15} /> Import items…
              </button>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}
