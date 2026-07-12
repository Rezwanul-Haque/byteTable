// Cassandra sidebar (M19 §19.1, ported from cassandra.jsx CassandraSidebar):
// keyspace selector, filterable table list with per-table + keyspace-actions
// context menus, header icons (schema map / refresh / dashboard), cqlsh footer.
// No per-table row counts (Cassandra has no cheap COUNT(*)). Reuses the shared
// sidebar chrome (.sidebar, .schema-row, .table-item, .ctx-menu).

import { useEffect, useState } from "react";

import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Btn } from "../../../../shared/ui/Btn";
import type { Env } from "../../../../shared/types";
import type { TableDescriptor } from "../api";

interface CtxMenu {
  x: number;
  y: number;
  ks?: boolean;
  table?: string;
}

interface CassandraSidebarProps {
  workspaceName: string;
  workspaceColor: string;
  env: Env;
  envColor: string;
  detail: string;
  ks: string;
  keyspaces: string[];
  tables: TableDescriptor[];
  activeTable: string | null;
  onKsChange: (ks: string) => void;
  onOpenTable: (name: string) => void;
  onOpenShell: () => void;
  onOpenDashboard: () => void;
  onOpenMap: () => void;
  onExportTable: (table: string) => void;
  onImportTable: (table: string | null) => void;
  onExportAll: () => void;
  onCreateKeyspace: () => void;
  onCreateTable: () => void;
  onAddIndex: (table: string) => void;
  onRefresh: () => void;
  /** Spin the refresh icon while an auto-refresh tick is in flight. */
  refreshing?: boolean;
  onCloseWorkspace: () => void;
}

export function CassandraSidebar({
  workspaceName,
  workspaceColor,
  env,
  envColor,
  detail,
  ks,
  keyspaces,
  tables,
  activeTable,
  onKsChange,
  onOpenTable,
  onOpenShell,
  onOpenDashboard,
  onOpenMap,
  onExportTable,
  onImportTable,
  onExportAll,
  onCreateKeyspace,
  onCreateTable,
  onAddIndex,
  onRefresh,
  refreshing,
  onCloseWorkspace,
}: CassandraSidebarProps) {
  const [q, setQ] = useState("");
  const [ksOpen, setKsOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  const filtered = tables.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));

  useEffect(() => {
    if (!ctxMenu && !ksOpen) return;
    const close = () => {
      setCtxMenu(null);
      setKsOpen(false);
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [ctxMenu, ksOpen]);

  return (
    <aside className="sidebar cass-sidebar">
      <div className="sidebar-conn" title={detail}>
        <span className="ws-color-bar" style={{ background: workspaceColor }} />
        <EngineBadge engine="cassandra" size={26} />
        <div className="sidebar-conn-info">
          <div className="sidebar-conn-name">{workspaceName}</div>
          <div className="sidebar-conn-detail">
            <span className="conn-env" style={{ color: envColor }}>
              {env}
            </span>
            <span className="conn-eng">Cassandra</span>
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

      <div className="schema-row">
        <div style={{ position: "relative", flex: 1 }}>
          <button
            className="schema-btn"
            style={{ width: "100%" }}
            title="Switch keyspace"
            onClick={(e) => {
              e.stopPropagation();
              setKsOpen((o) => !o);
            }}
          >
            <Icon name="hub" size={15} style={{ color: "var(--accent)" }} />
            <span className="schema-btn-name">{ks}</span>
            <Icon
              name="expand_more"
              size={15}
              style={{ marginLeft: "auto", color: "var(--text-faint)" }}
            />
          </button>
          {ksOpen ? (
            <div className="schema-pop" onClick={(e) => e.stopPropagation()}>
              {keyspaces.map((d) => (
                <div
                  key={d}
                  className={"schema-pop-item" + (d === ks ? " active" : "")}
                  onClick={() => {
                    onKsChange(d);
                    setKsOpen(false);
                  }}
                >
                  <Icon name="hub" size={14} />
                  <span>{d}</span>
                </div>
              ))}
              <div className="ctx-sep" />
              <div
                className="schema-pop-item schema-pop-create"
                onClick={() => {
                  setKsOpen(false);
                  onCreateKeyspace();
                }}
              >
                <Icon name="add" size={14} style={{ color: "var(--accent)" }} />
                <span style={{ color: "var(--accent)" }}>Create keyspace…</span>
              </div>
            </div>
          ) : null}
        </div>
        <IconBtn icon="schema" title="Schema map" onClick={onOpenMap} />
        <IconBtn
          icon="refresh"
          title="Refresh tables"
          onClick={onRefresh}
          className={refreshing ? "sidebar-sync-spinning" : undefined}
        />
        <IconBtn icon="monitoring" title="Keyspace dashboard" onClick={onOpenDashboard} />
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
        <input
          placeholder="Filter tables…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="sidebar-section-label">
        <span>Tables</span>
        <div
          className="sec-actions"
          style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}
        >
          <span className="sidebar-count">{tables.length}</span>
          <button
            className="sec-actions-btn"
            title="Keyspace actions"
            onClick={(e) => {
              e.stopPropagation();
              if (ctxMenu?.ks) {
                setCtxMenu(null);
                return;
              }
              const r = e.currentTarget.getBoundingClientRect();
              setCtxMenu({ x: r.right - 200, y: r.bottom + 4, ks: true });
            }}
          >
            <Icon name="more_horiz" size={15} />
          </button>
        </div>
      </div>

      <div className="sidebar-tables">
        {filtered.map((t) => {
          const open = expanded[t.name];
          return (
            <div key={t.name}>
              <div
                className={"table-item" + (t.name === activeTable ? " active" : "")}
                onClick={() => onOpenTable(t.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, table: t.name });
                }}
                title={t.comment || t.name}
              >
                <button
                  className={"table-expand" + (open ? " open" : "")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded({ ...expanded, [t.name]: !open });
                  }}
                >
                  <Icon name="chevron_right" size={14} />
                </button>
                <Icon
                  name="table_chart"
                  size={15}
                  style={{ color: t.name === activeTable ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="table-item-name">{t.name}</span>
                {t.mvs.length ? (
                  <span
                    title={t.mvs.length + " materialized view(s)"}
                    style={{ display: "inline-flex" }}
                  >
                    <Icon name="dvr" size={12} style={{ color: "var(--text-faint)" }} />
                  </span>
                ) : null}
              </div>
              {open ? (
                <div className="table-cols">
                  <div className="cass-pk-line">
                    <Icon name="key" size={11} style={{ color: "var(--accent)" }} />
                    <span className="cass-pk-text">{t.primaryKey}</span>
                  </div>
                  {t.indexes.map((idx) => (
                    <div key={idx.name} className="mg-idx-line">
                      <Icon name="bolt" size={11} style={{ color: "#e2b340" }} />
                      <span className="mg-idx-name">{idx.name}</span>
                      <span className="mg-idx-flag">2i · {idx.target}</span>
                    </div>
                  ))}
                  {t.mvs.map((mv) => (
                    <div key={mv.name} className="mg-idx-line">
                      <Icon name="dvr" size={11} style={{ color: "#61afef" }} />
                      <span className="mg-idx-name">{mv.name}</span>
                      <span className="mg-idx-flag">MV</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {filtered.length === 0 ? (
          <div className="sidebar-nomatch">No tables match “{q}”</div>
        ) : null}
      </div>

      <div className="sidebar-footer">
        <Btn
          icon="terminal"
          variant="tonal"
          onClick={onOpenShell}
          style={{ width: "100%", justifyContent: "center" }}
        >
          cqlsh
        </Btn>
      </div>

      {ctxMenu ? (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.ks ? (
            <>
              <div
                className="ctx-item ctx-item-accent"
                onClick={() => {
                  setCtxMenu(null);
                  onCreateTable();
                }}
              >
                <Icon name="add" size={15} /> Create table…
              </div>
              <div className="ctx-sep" />
              <div
                className="ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onImportTable(null);
                }}
              >
                <Icon name="upload" size={15} /> Import into table…
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onExportAll();
                }}
              >
                <Icon name="download" size={15} /> Export keyspace (CQL dump)…
              </div>
              <div className="ctx-sep" />
              <div
                className="ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onRefresh();
                }}
              >
                <Icon name="refresh" size={15} /> Refresh
              </div>
            </>
          ) : (
            <>
              <div
                className="ctx-item"
                onClick={() => {
                  if (ctxMenu.table) onOpenTable(ctxMenu.table);
                  setCtxMenu(null);
                }}
              >
                <Icon name="table_chart" size={15} /> Open table
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  if (ctxMenu.table) onAddIndex(ctxMenu.table);
                  setCtxMenu(null);
                }}
              >
                <Icon name="bolt" size={15} /> Add index / materialized view…
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  onOpenMap();
                  setCtxMenu(null);
                }}
              >
                <Icon name="schema" size={15} /> Show in schema map
              </div>
              <div className="ctx-sep" />
              <div
                className="ctx-item"
                onClick={() => {
                  const t = ctxMenu.table;
                  setCtxMenu(null);
                  if (t) onExportTable(t);
                }}
              >
                <Icon name="download" size={15} /> Export table…
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  const t = ctxMenu.table;
                  setCtxMenu(null);
                  if (t) onImportTable(t);
                }}
              >
                <Icon name="upload" size={15} /> Import rows…
              </div>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}
