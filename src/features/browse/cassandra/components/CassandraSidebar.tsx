// Cassandra sidebar (M19 §19.1, ported from cassandra.jsx CassandraSidebar):
// keyspace selector, filterable table list with per-table + keyspace-actions
// context menus, header icons (schema map / refresh / dashboard), cqlsh footer.
// No per-table row counts (Cassandra has no cheap COUNT(*)). Reuses the shared
// sidebar chrome (.sidebar, .schema-row, .table-item, .ctx-menu).

import { useEffect, useState } from "react";

import { useT } from "../../../../shared/i18n/useT";
import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { dropWordSelection } from "../../../../shared/ui/dropWordSelection";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Btn } from "../../../../shared/ui/Btn";
import { LanguageChip } from "../../../../shared/ui/LanguageChip";
import { ScopeSplitAction, ScopeSplitHint } from "../../../workspaces/components/ScopeSplitAction";
import { ScopeSwitcherModal } from "../../../workspaces/components/ScopeSwitcherModal";
import { useSettingsStore } from "../../../settings/state";
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
  /** Keyspaces that already have their own workspace (M33 sub-workspaces). */
  openedScopes: string[];
  /** Open (or focus) a keyspace as its own workspace, nested in the rail. */
  onOpenScopeWorkspace: (ks: string) => void;
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
  /** Confirm + empty one table, keeping its schema. */
  onTruncateTable: (table: string) => void;
  /** Confirm + drop one table (its 2i indexes go with it). */
  onDropTable: (table: string) => void;
  /** Confirm + drop every table, keeping the keyspace itself. */
  onEmptyKeyspace: () => void;
  /** Confirm + drop the whole keyspace. */
  onDropKeyspace: () => void;
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
  openedScopes,
  onOpenScopeWorkspace,
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
  onTruncateTable,
  onDropTable,
  onEmptyKeyspace,
  onDropKeyspace,
  onRefresh,
  refreshing,
  onCloseWorkspace,
}: CassandraSidebarProps) {
  // `tr`, not `t`: the table list below maps with `t` as the row variable.
  const tr = useT();
  const [q, setQ] = useState("");
  const [ksOpen, setKsOpen] = useState(false);
  // M36: dropdown (default) or an icon that opens the keyspace list as a
  // modal. One setting across the SQL, Cassandra and Mongo switchers.
  const scopeSwitcher = useSettingsStore((st) => st.settings.scopeSwitcher);
  const [ksModalOpen, setKsModalOpen] = useState(false);
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
        <LanguageChip />
        <IconBtn
          icon="power_settings_new"
          title={tr("cass.sidebar.close")}
          onClick={onCloseWorkspace}
          size={16}
          danger
        />
      </div>

      <div className="schema-row">
        {/* M36 `icon` mode: the list opens as a searchable modal instead of
            a popover. The active keyspace stays named in the status bar and on
            this button's tooltip. */}
        {scopeSwitcher === "icon" ? (
          // Same `.schema-btn` pill as the dropdown, so the row keeps the app's
          // shape and the label flexes the action icons back to the right edge.
          <button
            type="button"
            className="schema-btn"
            style={{ flex: 1, minWidth: 0 }}
            title={tr("cass.sidebar.keyspaceOf", { name: ks })}
            aria-label={tr("cass.sidebar.switchKeyspaceCurrent", { name: ks })}
            aria-haspopup="dialog"
            onClick={() => setKsModalOpen(true)}
          >
            <Icon name="hub" size={15} style={{ color: "var(--accent)" }} />
            <span className="schema-btn-name">{tr("cass.sidebar.switcher")}</span>
          </button>
        ) : (
          <div style={{ position: "relative", flex: 1 }}>
            <button
              className="schema-btn"
              style={{ width: "100%" }}
              title={tr("cass.sidebar.switchKeyspace")}
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
                {/* Create sits at the TOP, like the SQL schema switcher — the
                  keyspace list grows, and the action should not drift down
                  with it. */}
                <div
                  className="schema-pop-create"
                  onClick={() => {
                    setKsOpen(false);
                    onCreateKeyspace();
                  }}
                >
                  <Icon name="add" size={14} />
                  <span>{tr("cass.sidebar.createKeyspace")}</span>
                </div>
                <div className="schema-pop-sep" />
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
                    <ScopeSplitAction
                      scope={d}
                      opened={openedScopes.includes(d)}
                      onOpen={(scope) => {
                        setKsOpen(false);
                        onOpenScopeWorkspace(scope);
                      }}
                    />
                  </div>
                ))}
                <ScopeSplitHint />
              </div>
            ) : null}
          </div>
        )}
        <IconBtn icon="schema" title={tr("cass.sidebar.schemaMap")} onClick={onOpenMap} />
        <IconBtn icon="monitoring" title={tr("cass.sidebar.dashboard")} onClick={onOpenDashboard} />
        <IconBtn
          icon="sync"
          title={tr("cass.sidebar.refreshTables")}
          onClick={onRefresh}
          className={refreshing ? "sidebar-sync-spinning" : undefined}
        />
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
        <input
          placeholder={tr("cass.sidebar.filterTables")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="sidebar-section-label">
        <span>{tr("cass.sidebar.tables")}</span>
        <div
          className="sec-actions"
          style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}
        >
          <span className="sidebar-count">{tables.length}</span>
          <button
            className="sec-actions-btn"
            title={tr("cass.sidebar.keyspaceActions")}
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
                  dropWordSelection(e.currentTarget);
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
                    title={tr("cass.sidebar.mvCount", { count: t.mvs.length })}
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
                      <span className="mg-idx-flag">
                        {tr("cass.sidebar.index2i", { target: idx.target })}
                      </span>
                    </div>
                  ))}
                  {t.mvs.map((mv) => (
                    <div key={mv.name} className="mg-idx-line">
                      <Icon name="dvr" size={11} style={{ color: "#61afef" }} />
                      <span className="mg-idx-name">{mv.name}</span>
                      <span className="mg-idx-flag">{tr("cass.sidebar.mvTag")}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {/* Two different empty states. Only the filter one quotes the query —
            with no filter typed it rendered as the literal `No tables match “”`
            (reachable since "Empty keyspace", and on any new keyspace). */}
        {tables.length === 0 ? (
          <div className="sidebar-nomatch">{tr("cass.sidebar.noTables")}</div>
        ) : filtered.length === 0 ? (
          <div className="sidebar-nomatch">{tr("cass.sidebar.noTablesMatch", { q })}</div>
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
                <Icon name="add" size={15} /> {tr("cass.sidebar.ctxCreateTable")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onImportTable(null);
                }}
              >
                <Icon name="upload" size={15} /> {tr("cass.sidebar.ctxImportInto")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onExportAll();
                }}
              >
                <Icon name="download" size={15} /> {tr("cass.sidebar.ctxExportKeyspace")}
              </div>
              <div className="ctx-sep" />
              <div
                className="ctx-item danger"
                onClick={() => {
                  setCtxMenu(null);
                  onEmptyKeyspace();
                }}
              >
                <Icon name="delete_sweep" size={15} /> {tr("cass.sidebar.ctxEmptyKeyspace")}
              </div>
              <div
                className="ctx-item danger"
                onClick={() => {
                  setCtxMenu(null);
                  onDropKeyspace();
                }}
              >
                <Icon name="delete_forever" size={15} /> {tr("cass.sidebar.ctxDropKeyspace")}
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
                <Icon name="table_chart" size={15} /> {tr("cass.sidebar.ctxOpenTable")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  if (ctxMenu.table) onAddIndex(ctxMenu.table);
                  setCtxMenu(null);
                }}
              >
                <Icon name="bolt" size={15} /> {tr("cass.sidebar.ctxAddIndexOrMv")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  onOpenMap();
                  setCtxMenu(null);
                }}
              >
                <Icon name="schema" size={15} /> {tr("cass.sidebar.ctxShowInMap")}
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
                <Icon name="download" size={15} /> {tr("cass.sidebar.ctxExportTable")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  const t = ctxMenu.table;
                  setCtxMenu(null);
                  if (t) onImportTable(t);
                }}
              >
                <Icon name="upload" size={15} /> {tr("cass.sidebar.ctxImportRows")}
              </div>
              <div className="ctx-sep" />
              <div
                className="ctx-item danger"
                onClick={() => {
                  const t = ctxMenu.table;
                  setCtxMenu(null);
                  if (t) onTruncateTable(t);
                }}
              >
                <Icon name="delete_sweep" size={15} /> {tr("cass.sidebar.ctxTruncate")}
              </div>
              <div
                className="ctx-item danger"
                onClick={() => {
                  const t = ctxMenu.table;
                  setCtxMenu(null);
                  if (t) onDropTable(t);
                }}
              >
                <Icon name="delete_forever" size={15} /> {tr("cass.sidebar.ctxDropTable")}
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* M36 `icon` mode. Cassandra has no server-internal keyspaces to group
          and no per-keyspace table count on hand, so neither is passed. */}
      {ksModalOpen ? (
        <ScopeSwitcherModal
          noun="keyspace"
          icon="hub"
          items={keyspaces.map((name) => ({ name }))}
          current={ks}
          openedScopes={openedScopes}
          onSelect={onKsChange}
          onOpenWorkspace={onOpenScopeWorkspace}
          onCreate={onCreateKeyspace}
          onClose={() => setKsModalOpen(false)}
        />
      ) : null}
    </aside>
  );
}
