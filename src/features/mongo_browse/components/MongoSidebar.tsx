// MongoDB sidebar (M18 §18.1): database selector, collection list with index
// sub-rows + search, header icons (schema map hub / refresh / dashboard
// monitoring), the "Collections N ⋯" section label with database-actions menu,
// and the mongosh footer button. Ported from the prototype's MongoSidebar;
// reads real CollectionDescriptor[] instead of the mock window.BT_MONGO.

import { useEffect, useState } from "react";

import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Btn } from "../../../shared/ui/Btn";
import type { Env } from "../../../shared/types";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import type { CollectionDescriptor } from "../api";

interface CtxMenu {
  x: number;
  y: number;
  db?: boolean;
  coll?: string;
}

export function MongoSidebar({
  workspaceName,
  workspaceColor,
  env,
  detail,
  db,
  dbNames,
  collections,
  loading,
  activeColl,
  onDbChange,
  onOpenColl,
  onOpenShell,
  onOpenDashboard,
  onOpenMap,
  onNewPipeline,
  onExportColl,
  onImportColl,
  onExportAll,
  onRefresh,
  onCloseWorkspace,
}: {
  workspaceName: string;
  workspaceColor: string;
  env: Env;
  detail: string;
  db: string;
  dbNames: string[];
  collections: CollectionDescriptor[];
  loading: boolean;
  activeColl: string | null;
  onDbChange: (db: string) => void;
  onOpenColl: (coll: string) => void;
  onOpenShell: () => void;
  onOpenDashboard: () => void;
  onOpenMap: () => void;
  onNewPipeline: () => void;
  onExportColl: (coll: string) => void;
  onImportColl: (coll: string | null) => void;
  onExportAll: () => void;
  onRefresh: () => void;
  onCloseWorkspace: () => void;
}) {
  const [q, setQ] = useState("");
  const [dbOpen, setDbOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const envColor = ENV_COLOR[env];

  const filtered = collections.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));

  useEffect(() => {
    if (!ctxMenu && !dbOpen) return;
    const close = () => {
      setCtxMenu(null);
      setDbOpen(false);
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [ctxMenu, dbOpen]);

  return (
    <aside className="sidebar">
      <div className="sidebar-conn" title={detail}>
        <span className="ws-color-bar" style={{ background: workspaceColor }} />
        <EngineBadge engine="mongodb" size={26} />
        <div className="sidebar-conn-info">
          <div className="sidebar-conn-name">{workspaceName}</div>
          <div className="sidebar-conn-detail">
            <span className="conn-env" style={{ color: envColor }}>
              {env}
            </span>
            <span className="conn-eng">MongoDB</span>
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
            title="Switch database"
            onClick={(e) => {
              e.stopPropagation();
              setDbOpen((o) => !o);
            }}
          >
            <Icon name="database" size={15} style={{ color: "var(--accent)" }} />
            <span className="schema-btn-name">{db}</span>
            <Icon
              name="expand_more"
              size={15}
              style={{ marginLeft: "auto", color: "var(--text-faint)" }}
            />
          </button>
          {dbOpen ? (
            <div className="schema-pop" onClick={(e) => e.stopPropagation()}>
              {dbNames.map((d) => (
                <div
                  key={d}
                  className={"schema-pop-item" + (d === db ? " active" : "")}
                  onClick={() => {
                    onDbChange(d);
                    setDbOpen(false);
                  }}
                >
                  <Icon name="database" size={14} />
                  <span>{d}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <IconBtn icon="schema" title="Schema map" onClick={onOpenMap} />
        <IconBtn icon="refresh" title="Refresh collections" onClick={onRefresh} />
        <IconBtn icon="monitoring" title="Database dashboard" onClick={onOpenDashboard} />
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
        <input
          placeholder="Filter collections…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="sidebar-section-label">
        <span>Collections</span>
        <div
          className="sec-actions"
          style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}
        >
          <span className="sidebar-count">{collections.length}</span>
          <button
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

      <div className="sidebar-tables">
        {loading ? <div className="sidebar-empty">Loading…</div> : null}
        {filtered.map((c) => {
          const open = expanded[c.name];
          return (
            <div key={c.name}>
              <div
                className={"table-item" + (c.name === activeColl ? " active" : "")}
                onClick={() => onOpenColl(c.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, coll: c.name });
                }}
                title={c.name}
              >
                <button
                  className={"table-expand" + (open ? " open" : "")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded({ ...expanded, [c.name]: !open });
                  }}
                >
                  <Icon name="chevron_right" size={14} />
                </button>
                <Icon
                  name="folder_special"
                  size={15}
                  style={{ color: c.name === activeColl ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="table-item-name">{c.name}</span>
                {c.validator ? (
                  <Icon name="verified" size={12} style={{ color: "var(--text-faint)" }} />
                ) : null}
              </div>
              {open ? (
                <div className="table-cols">
                  {c.indexes.map((idx) => (
                    <div key={idx.name} className="mg-idx-line">
                      <Icon
                        name={idx.name === "_id_" ? "key" : "bolt"}
                        size={11}
                        style={{ color: idx.name === "_id_" ? "var(--accent)" : "#e2b340" }}
                      />
                      <span className="mg-idx-name">{idx.name}</span>
                      {idx.unique ? <span className="mg-idx-flag">unique</span> : null}
                      {idx.sparse ? <span className="mg-idx-flag">sparse</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <Btn
          icon="terminal"
          variant="tonal"
          onClick={onOpenShell}
          style={{ width: "100%", justifyContent: "center" }}
        >
          mongosh
        </Btn>
      </div>

      {ctxMenu ? (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.db ? (
            <>
              <div
                className="ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onImportColl(null);
                }}
              >
                <Icon name="upload" size={15} /> Import into collection…
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onExportAll();
                }}
              >
                <Icon name="download" size={15} /> Export database (mongodump)…
              </div>
              <div className="ctx-sep" />
              <div
                className="ctx-item"
                onClick={() => {
                  setCtxMenu(null);
                  onNewPipeline();
                }}
              >
                <Icon name="account_tree" size={15} /> New aggregation pipeline
              </div>
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
                  if (ctxMenu.coll) onOpenColl(ctxMenu.coll);
                  setCtxMenu(null);
                }}
              >
                <Icon name="folder_special" size={15} /> Open collection
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
                  const c = ctxMenu.coll;
                  setCtxMenu(null);
                  if (c) onExportColl(c);
                }}
              >
                <Icon name="download" size={15} /> Export collection…
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  const c = ctxMenu.coll;
                  setCtxMenu(null);
                  if (c) onImportColl(c);
                }}
              >
                <Icon name="upload" size={15} /> Import documents…
              </div>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}
