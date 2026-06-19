// Sidebar — ported from the prototype's sidebar.jsx (spec §3.3): workspace
// header, schema switcher popover, refresh, searchable table list with
// inline expandable column lists, table context menu, "New SQL query"
// footer. Backed by real introspection via the introspection slice's cache
// (this component composes workspace identity; the data lives there).
//
// Per-workspace state split (WorkspaceUiState doc): structural sidebar state
// — selected schema, expanded tables — lives on `workspace.ui` so switching
// workspaces preserves it; the search text and open popovers are transient
// local state (prototype keeps them local too) and reset with the component
// (App keys the sidebar by workspace id).
//
// M4: opening tables/SQL/map now drive the tab system (store actions). The
// `.active` table styling is wired — a table row lights up when the active
// tab is a table tab for this schema+table. M7: "View structure" opens (or
// focuses + switches) the table tab in structure mode (§3.6).

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { useToast } from "../../../shared/ui/toastContext";
import { normalizeEnv } from "../../../shared/types";
import {
  connectionDetail,
  connectionIsTunneled,
  connectionSchemas,
  tunnelTitle,
  type SchemaInfo,
} from "../../connections/api";
import { CreateSchemaModal } from "../../export/components/CreateSchemaModal";
import { CreateTableModal } from "../../export/components/CreateTableModal";
import { DropSchemaModal } from "../../export/components/DropSchemaModal";
import { ExportProgressModal } from "../../export/components/ExportProgressModal";
import { TruncateModal } from "../../export/components/TruncateModal";
import { GenerateModal } from "../../generate/components/GenerateModal";
import { useGenerateStore } from "../../generate/state";
import { type ExportKind } from "../../export/exportFlow";
import { ImportModal } from "../../import/components/ImportModal";
import { SchemaImportModal } from "../../import/components/SchemaImportModal";
import { tablesKey, columnsKey, useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../state";
import { useTabMetaStore } from "../tabMeta";
import type { Workspace } from "../types";
import "./Sidebar.css";

/** Stable default so the no-expansions case never re-triggers effects. */
const NO_EXPANDED: string[] = [];

/** Engine display labels for the connection header's detail line. */
const ENGINE_LABEL: Record<string, string> = {
  sqlite: "SQLite",
  mysql: "MySQL",
  postgres: "PostgreSQL",
  redis: "Redis",
};

/** The context menu's anchor + target table. */
interface CtxMenu {
  x: number;
  y: number;
  table: string;
}

// Approximate rendered size of the context menu, for clamping it inside the
// viewport (min-width 190 + padding). M15 grew it to 7 items + a separator.
const CTX_MENU_W = 200;
const CTX_MENU_H = 280;

/**
 * Roving-focus keyboard nav shared by the schema popover and the context
 * menu (role=menu): arrows cycle the menuitems, Home/End jump. Escape is
 * handled by the global close listener.
 */
function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  const { key } = event;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role^='menuitem']"));
  if (items.length === 0) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (key === "Home") next = 0;
  else if (key === "End") next = items.length - 1;
  else if (key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
  else next = current <= 0 ? items.length - 1 : current - 1;
  items[next]?.focus();
}

export function Sidebar({ workspace }: { workspace: Workspace }) {
  const toast = useToast();
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);
  const patchWorkspaceUi = useWorkspacesStore((state) => state.patchWorkspaceUi);
  const setWorkspaceSchemas = useWorkspacesStore((state) => state.setWorkspaceSchemas);
  const openTableTab = useWorkspacesStore((state) => state.openTableTab);
  const openSqlTab = useWorkspacesStore((state) => state.openSqlTab);
  const openMapTab = useWorkspacesStore((state) => state.openMapTab);

  const { handleId } = workspace;
  const engine = workspace.saved.engine;

  // Selected schema: per-workspace ui state, defaulting to the first schema
  // the connection listed (SQLite: always "main"). If a refresh dropped the
  // selected schema (out-of-band DETACH), fall back rather than introspect
  // a ghost.
  const uiSchema = workspace.ui.schemaName;
  const schemaName =
    (uiSchema !== undefined && workspace.schemas.some((s) => s.name === uiSchema)
      ? uiSchema
      : workspace.schemas[0]?.name) ?? (engine === "sqlite" ? "main" : "");
  const expandedTables = workspace.ui.expandedTables ?? NO_EXPANDED;

  // Active-table styling (§3.3/§3.4 restored): the sidebar row matching the
  // active tab — when it is a table tab in the currently-selected schema —
  // gets `.active` + an accent table icon. Read off the workspace's ui
  // (the prop is the live store object, re-rendered on tab changes).
  const tabs = workspace.ui.tabs ?? [];
  const activeTab = tabs.find((t) => t.id === workspace.ui.activeTabId) ?? null;
  const activeTable =
    activeTab?.kind === "table" && activeTab.schema === schemaName ? activeTab.table : null;

  // Introspection cache. Whole-map selects are fine here: entries change
  // only on (rare) fetch completions, unlike the per-keystroke ui churn the
  // narrow-selector rule in types.ts is about.
  const tKey = tablesKey(handleId, schemaName);
  const tablesEntry = useIntrospectionStore((state) => state.tables[tKey]);
  const tablesMap = useIntrospectionStore((state) => state.tables);
  const columnsMap = useIntrospectionStore((state) => state.columns);
  const errorsMap = useIntrospectionStore((state) => state.errors);
  const loadTables = useIntrospectionStore((state) => state.loadTables);
  const loadColumns = useIntrospectionStore((state) => state.loadColumns);

  // Transient local state (prototype sidebar.jsx keeps the same set local).
  const [query, setQuery] = useState("");
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // M15 Task 2: which table the truncate modal targets (null when closed).
  const [truncateTarget, setTruncateTarget] = useState<string | null>(null);
  // The export-in-progress (drives the progress modal): the kind + (for a table
  // export) its name. null = no export open.
  const [exportJob, setExportJob] = useState<{
    kind: ExportKind;
    table?: string;
  } | null>(null);
  // M15 SQL enhancements: the schema-actions three-dot menu, the table-level
  // import modal target, and the schema-level dump-import modal.
  const [schemaMenu, setSchemaMenu] = useState(false);
  const [importTarget, setImportTarget] = useState<string | null>(null);
  const [schemaImportOpen, setSchemaImportOpen] = useState(false);
  // M15 SQL enhancements: the destructive drop-schema confirm (null when closed).
  const [dropSchemaOpen, setDropSchemaOpen] = useState(false);
  // M16: open the Generate-data modal for this (handle, schema).
  const openGenerate = useGenerateStore((s) => s.openModal);
  // Create-schema modal (from the schema switcher's "Create schema" item).
  const [createSchemaOpen, setCreateSchemaOpen] = useState(false);
  // Create-table modal (from the schema-actions menu's "Create table…" item).
  const [createTableOpen, setCreateTableOpen] = useState(false);
  const secActionsRef = useRef<HTMLDivElement | null>(null);
  const secActionsBtnRef = useRef<HTMLButtonElement | null>(null);

  // Focus bookkeeping for the popover/menu (Rail pattern): focus moves into
  // the menu on open and back to its opener on close.
  const schemaBtnRef = useRef<HTMLButtonElement | null>(null);
  const ctxOpenerRef = useRef<HTMLElement | null>(null);
  const schemaPopRef = useRef<HTMLDivElement | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  // Load the selected schema's tables (cache-first — switching back to a
  // visited schema/workspace renders instantly).
  useEffect(() => {
    void loadTables(handleId, schemaName);
  }, [handleId, schemaName, loadTables]);

  // Lazily fetch columns for expanded tables that exist in the current
  // list. Re-runs when refresh rewrites the entry (fetchedAt bump dropped
  // the schema's column caches), so expanded rows re-introspect too.
  useEffect(() => {
    if (!tablesEntry) return;
    const present = new Set(tablesEntry.tables.map((t) => t.name));
    for (const name of expandedTables) {
      if (present.has(name)) void loadColumns(handleId, schemaName, name);
    }
  }, [tablesEntry, expandedTables, handleId, schemaName, loadColumns]);

  // Outside mousedown / Escape / window blur close the popover and context
  // menu (prototype effect + the Rail's Escape handling).
  useEffect(() => {
    if (!ctxMenu && !schemaOpen && !schemaMenu) return;
    const close = () => {
      setCtxMenu(null);
      setSchemaOpen(false);
      setSchemaMenu(false);
    };
    const onDown = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".schema-pop, .schema-btn, .ctx-menu, .sec-actions")
      )
        return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      // Return focus to the element that opened whatever was on top.
      if (ctxMenu) ctxOpenerRef.current?.focus();
      else if (schemaMenu) secActionsBtnRef.current?.focus();
      else schemaBtnRef.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [ctxMenu, schemaOpen, schemaMenu]);

  // Move focus into the menu/popover when it opens (a11y: keyboard users
  // land on the first item / the active schema).
  useEffect(() => {
    if (!ctxMenu) return;
    ctxMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [ctxMenu]);
  useEffect(() => {
    if (!schemaOpen) return;
    const pop = schemaPopRef.current;
    (
      pop?.querySelector<HTMLElement>("[aria-checked='true']") ??
      pop?.querySelector<HTMLElement>("[role^='menuitem']")
    )?.focus();
  }, [schemaOpen]);
  useEffect(() => {
    if (!schemaMenu) return;
    secActionsRef.current
      ?.querySelector<HTMLElement>(".sec-actions-menu [role='menuitem']")
      ?.focus();
  }, [schemaMenu]);

  const tables = tablesEntry?.tables ?? null;
  const tablesError = errorsMap[tKey];
  const trimmed = query.trim().toLowerCase();
  const filtered =
    tables?.filter((t) => trimmed === "" || t.name.toLowerCase().includes(trimmed)) ?? [];

  const setSchema = (name: string) => {
    patchWorkspaceUi(workspace.id, { schemaName: name });
    setSchemaOpen(false);
    schemaBtnRef.current?.focus();
  };

  // After creating a schema: re-introspect the connection's schema list (so the
  // new one appears in the switcher), then switch to it.
  const onSchemaCreated = (newName: string) => {
    void (async () => {
      try {
        setWorkspaceSchemas(workspace.id, await connectionSchemas(handleId));
      } catch {
        /* keep the stale list — we still switch to the new schema below */
      }
      setSchema(newName);
    })();
  };

  const toggleExpanded = (name: string) => {
    patchWorkspaceUi(workspace.id, {
      expandedTables: expandedTables.includes(name)
        ? expandedTables.filter((t) => t !== name)
        : [...expandedTables, name],
    });
  };

  // Refresh: re-introspect schemas + tables (force — picks up out-of-band
  // DDL), spinning for at least 750ms so the feedback is perceivable, then
  // toast the prototype's exact copy.
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    const started = Date.now();
    void (async () => {
      let refreshed: number | null = null;
      let failure: string | null = null;
      try {
        const [schemas, fresh] = await Promise.all([
          connectionSchemas(handleId),
          loadTables(handleId, schemaName, { force: true }),
        ]);
        setWorkspaceSchemas(workspace.id, schemas);
        if (fresh) refreshed = fresh.length;
        else
          failure =
            useIntrospectionStore.getState().errors[tKey] ?? "Could not refresh the schema.";
      } catch (err) {
        failure = appErrorMessage(err, "Could not refresh the schema.");
      }
      const remaining = 750 - (Date.now() - started);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      setRefreshing(false);
      if (failure === null) {
        toast("Schema “" + schemaName + "” refreshed — " + refreshed + " tables", "ok");
      } else {
        toast(failure, "err");
      }
    })();
  };

  const openCtxMenu = (x: number, y: number, table: string, opener: HTMLElement) => {
    ctxOpenerRef.current = opener;
    setSchemaOpen(false);
    setCtxMenu({
      x: Math.max(0, Math.min(x, window.innerWidth - CTX_MENU_W)),
      y: Math.max(0, Math.min(y, window.innerHeight - CTX_MENU_H)),
      table,
    });
  };

  const closeCtxMenu = (refocus: boolean) => {
    setCtxMenu(null);
    if (refocus) ctxOpenerRef.current?.focus();
  };

  // M4 tab opens (store actions on the active workspace's ui).
  const openTable = (table: string) => openTableTab(schemaName, table);
  // "View structure" (M7): open-or-focus the table tab in structure mode
  // (§3.6). On an already-open tab this switches it to structure mode.
  const openStructure = (table: string) => openTableTab(schemaName, table, "structure");
  const openMap = () => openMapTab(schemaName);

  // M15: open the export progress modal — it owns the whole flow (SQL opens on
  // the scope-choice step, CSV straight to the building bar, then save dialog →
  // write → toast). Reused by the table context menu + the schema-row download.
  const doExport = (kind: ExportKind, table?: string) => setExportJob({ kind, table });

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, table: string) => {
    // Keydowns on the nested expand chevron bubble up here — they belong to
    // the chevron (its native click), not the row.
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTable(table);
    } else if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      // Keyboard path to the context menu, anchored at the row (Rail
      // pattern).
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openCtxMenu(rect.left + 24, rect.bottom, table, event.currentTarget);
    }
  };

  // Popover table counts: live cache first, else what opening/refreshing
  // the connection reported (null when not cheaply known).
  const schemaTableCount = (schema: SchemaInfo): number | null =>
    tablesMap[tablesKey(handleId, schema.name)]?.tables.length ?? schema.tableCount;

  return (
    <aside className="sidebar">
      <div className="sidebar-conn" title={connectionDetail(workspace.saved.params)}>
        <span className="ws-color-bar" style={{ background: workspace.color }} />
        <EngineBadge engine={engine} size={26} />
        <div className="sidebar-conn-info">
          <div className="sidebar-conn-name">{workspace.name}</div>
          {/* Detail line (design refresh): the env as a small uppercase, env-
              colored label + the engine name. The host:port detail moves to the
              header's hover tooltip. Tunnel lock (M12) shows when reached through
              an SSH bastion. */}
          <div className="sidebar-conn-detail">
            {connectionIsTunneled(workspace.saved.params) ? (
              <span className="tunnel-lock" title={tunnelTitle(workspace.saved.params)}>
                <Icon name="vpn_lock" size={11} style={{ color: "var(--text-faint)" }} />
              </span>
            ) : null}
            <span
              className="conn-env"
              style={{ color: ENV_COLOR[normalizeEnv(workspace.saved.env)] }}
            >
              {normalizeEnv(workspace.saved.env)}
            </span>
            <span className="conn-eng">{ENGINE_LABEL[engine] ?? engine}</span>
          </div>
        </div>
        <IconBtn
          icon="power_settings_new"
          title="Close workspace"
          size={16}
          danger
          onClick={() => closeWorkspace(workspace.id)}
        />
      </div>

      <div className="schema-row">
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <button
            ref={schemaBtnRef}
            type="button"
            className="schema-btn"
            onClick={() => setSchemaOpen(!schemaOpen)}
            title="Switch schema"
            aria-haspopup="menu"
            aria-expanded={schemaOpen}
          >
            <Icon name="schema" size={15} style={{ color: "var(--accent)" }} />
            <span className="schema-btn-name">{schemaName}</span>
            <Icon name="expand_more" size={15} style={{ color: "var(--text-faint)" }} />
          </button>
          {schemaOpen ? (
            <div
              ref={schemaPopRef}
              className="schema-pop"
              role="menu"
              aria-label="Switch schema"
              onKeyDown={onMenuKeyDown}
            >
              <button
                type="button"
                className="schema-pop-create"
                role="menuitem"
                onClick={() => {
                  setSchemaOpen(false);
                  setCreateSchemaOpen(true);
                }}
              >
                <Icon name="create_new_folder" size={14} />
                <span>Create schema</span>
              </button>
              <div className="schema-pop-sep" />
              {workspace.schemas.map((s) => {
                const count = schemaTableCount(s);
                return (
                  <button
                    key={s.name}
                    type="button"
                    className={"schema-pop-item" + (s.name === schemaName ? " active" : "")}
                    role="menuitemradio"
                    aria-checked={s.name === schemaName}
                    onClick={() => setSchema(s.name)}
                  >
                    <Icon name="schema" size={14} />
                    <span>{s.name}</span>
                    <span className="schema-pop-count">{count === null ? "—" : count}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <IconBtn icon="hub" title="Schema map (ER diagram)" onClick={openMap} />
        <IconBtn
          icon="download"
          title={"Export schema “" + schemaName + "” as .sql"}
          onClick={() => doExport("schemaSql")}
        />
        <IconBtn
          icon="sync"
          title="Refresh schema"
          onClick={refresh}
          className={refreshing ? "sidebar-sync-spinning" : undefined}
        />
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
        <input
          placeholder="Filter tables…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck="false"
          aria-label="Filter tables"
        />
        {query ? (
          <IconBtn icon="close" size={13} title="Clear" onClick={() => setQuery("")} />
        ) : null}
      </div>

      <div className="sidebar-section-label">
        <span>Tables</span>
        <div className="sec-actions" ref={secActionsRef}>
          <span className="sidebar-count">{tables === null ? "" : tables.length}</span>
          <button
            ref={secActionsBtnRef}
            type="button"
            className="sec-actions-btn"
            title="Schema actions"
            aria-haspopup="menu"
            aria-expanded={schemaMenu}
            onClick={() => {
              setSchemaOpen(false);
              setCtxMenu(null);
              setSchemaMenu((o) => !o);
            }}
          >
            <Icon name="more_horiz" size={15} />
          </button>
          {schemaMenu ? (
            <div
              className="ctx-menu sec-actions-menu"
              role="menu"
              aria-label={"Schema actions for " + schemaName}
              onKeyDown={onMenuKeyDown}
            >
              <div className="ctx-menu-label">Schema · {schemaName}</div>
              <button
                type="button"
                className="ctx-item ctx-item-accent"
                role="menuitem"
                onClick={() => {
                  setSchemaMenu(false);
                  setCreateTableOpen(true);
                }}
              >
                <Icon name="add" size={15} /> Create table…
              </button>
              <button
                type="button"
                className="ctx-item"
                role="menuitem"
                onClick={() => {
                  setSchemaMenu(false);
                  setSchemaImportOpen(true);
                }}
              >
                <Icon name="upload" size={15} /> Import SQL dump…
              </button>
              <button
                type="button"
                className="ctx-item"
                role="menuitem"
                onClick={() => {
                  setSchemaMenu(false);
                  doExport("schemaSql");
                }}
              >
                <Icon name="download" size={15} /> Export schema (.sql)
              </button>
              <button
                type="button"
                className="ctx-item"
                role="menuitem"
                onClick={() => {
                  setSchemaMenu(false);
                  openGenerate(handleId, schemaName);
                }}
              >
                <Icon name="auto_awesome" size={15} /> Generate data…
              </button>
              <div className="ctx-sep" />
              <button
                type="button"
                className="ctx-item danger"
                role="menuitem"
                onClick={() => {
                  setSchemaMenu(false);
                  setDropSchemaOpen(true);
                }}
              >
                <Icon name="delete_forever" size={15} /> Drop schema…
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="sidebar-tables">
        {tablesError !== undefined && tables === null ? (
          // §5: a human sentence where the action happened. A stale list
          // (refresh failed) keeps rendering instead; the toast carried it.
          <div className="sidebar-error">{tablesError}</div>
        ) : tables === null ? (
          <div className="sidebar-loading">
            <span className="spinner" /> Loading tables…
          </div>
        ) : tables.length === 0 ? (
          <div className="sidebar-nomatch">No tables in this schema yet.</div>
        ) : (
          <>
            {filtered.map((t) => {
              const isExpanded = expandedTables.includes(t.name);
              const isActive = t.name === activeTable;
              const cKey = columnsKey(handleId, schemaName, t.name);
              const columnsEntry = columnsMap[cKey];
              const columnsError = errorsMap[cKey];
              return (
                <div key={t.name}>
                  <div
                    className={"table-item" + (isActive ? " active" : "")}
                    role="button"
                    tabIndex={0}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => openTable(t.name)}
                    onKeyDown={(event) => onRowKeyDown(event, t.name)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openCtxMenu(event.clientX, event.clientY, t.name, event.currentTarget);
                    }}
                    title={t.name}
                  >
                    <button
                      type="button"
                      className={"table-expand" + (isExpanded ? " open" : "")}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleExpanded(t.name);
                      }}
                      title={isExpanded ? "Hide columns" : "Show columns"}
                      aria-expanded={isExpanded}
                    >
                      <Icon name="chevron_right" size={14} />
                    </button>
                    <Icon
                      name="table"
                      size={16}
                      style={{ color: isActive ? "var(--accent)" : "var(--text-faint)" }}
                    />
                    <span className="table-item-name">{t.name}</span>
                  </div>
                  {isExpanded ? (
                    columnsEntry ? (
                      <div className="table-cols">
                        {columnsEntry.columns.map((c) => (
                          <div className="table-col" key={c.name}>
                            <span className="table-col-icon">
                              {c.pk ? (
                                <Icon
                                  name="key"
                                  size={11}
                                  style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
                                />
                              ) : c.fk ? (
                                <Icon
                                  name="link"
                                  size={11}
                                  style={{ color: "var(--text-faint)" }}
                                />
                              ) : null}
                            </span>
                            <span className="table-col-name">{c.name}</span>
                            <span className="table-col-type">{c.dataType.toLowerCase()}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="table-cols">
                        <div className="table-col-note">{columnsError ?? "Loading…"}</div>
                      </div>
                    )
                  ) : null}
                </div>
              );
            })}
            {filtered.length === 0 ? (
              <div className="sidebar-nomatch">No tables match “{query}”</div>
            ) : null}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <Btn
          icon="terminal"
          variant="tonal"
          onClick={openSqlTab}
          style={{ width: "100%", justifyContent: "center" }}
        >
          New SQL query
        </Btn>
      </div>

      {ctxMenu ? (
        <div
          ref={ctxMenuRef}
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          aria-label={"Table " + ctxMenu.table}
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              openTable(ctxMenu.table);
              closeCtxMenu(true);
            }}
          >
            <Icon name="table" size={15} /> Open data
          </button>
          <button
            type="button"
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              openStructure(ctxMenu.table);
              closeCtxMenu(true);
            }}
          >
            <Icon name="account_tree" size={15} /> View structure
          </button>
          <button
            type="button"
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              openSqlTab();
              closeCtxMenu(true);
            }}
          >
            <Icon name="terminal" size={15} /> Query in SQL editor
          </button>
          <button
            type="button"
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              openMap();
              closeCtxMenu(true);
            }}
          >
            <Icon name="hub" size={15} /> Show in schema map
          </button>
          <div className="ctx-sep" />
          <button
            type="button"
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              doExport("tableCsv", ctxMenu.table);
              closeCtxMenu(true);
            }}
          >
            <Icon name="table_view" size={15} /> Export as CSV
          </button>
          <button
            type="button"
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              doExport("tableSql", ctxMenu.table);
              closeCtxMenu(true);
            }}
          >
            <Icon name="code" size={15} /> Export as SQL
          </button>
          <button
            type="button"
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              const t = ctxMenu.table;
              closeCtxMenu(false);
              setImportTarget(t);
            }}
          >
            <Icon name="upload" size={15} /> Import data…
          </button>
          <div className="ctx-sep" />
          <button
            type="button"
            className="ctx-item danger"
            role="menuitem"
            onClick={() => {
              const t = ctxMenu.table;
              closeCtxMenu(false);
              setTruncateTarget(t);
            }}
          >
            <Icon name="delete_sweep" size={15} /> Truncate table…
          </button>
        </div>
      ) : null}

      {/* Export progress (M15): SQL opens on the scope-choice step (structure /
          data / both), CSV straight to the bar; both write via the save dialog. */}
      {exportJob ? (
        <ExportProgressModal
          kind={exportJob.kind}
          handleId={handleId}
          schema={schemaName}
          table={exportJob.table}
          onClose={() => setExportJob(null)}
        />
      ) : null}

      {/* Truncate confirm (M15 Task 2): env-aware. Refreshes sidebar counts
          itself; onDone re-fetches any open data grid for this table. */}
      {truncateTarget ? (
        <TruncateModal
          handleId={handleId}
          schemaName={schemaName}
          table={truncateTarget}
          env={workspace.saved.env}
          onClose={() => setTruncateTarget(null)}
          onDone={() => {
            // If a data tab for this schema+table is open, bump its grid.
            const target = truncateTarget;
            for (const t of tabs) {
              if (t.kind === "table" && t.schema === schemaName && t.table === target) {
                useTabMetaStore.getState().requestRefetch(t.id);
              }
            }
          }}
        />
      ) : null}

      {/* Table-level import (M15 SQL enhancements): CSV / SQL-INSERT data into
          one table. Refreshes the sidebar counts + the open grid itself. */}
      {importTarget ? (
        <ImportModal
          handleId={handleId}
          schemaName={schemaName}
          table={importTarget}
          onClose={() => setImportTarget(null)}
        />
      ) : null}

      {/* Schema-level import: a multi-table .sql dump into this schema. */}
      {schemaImportOpen ? (
        <SchemaImportModal
          handleId={handleId}
          schemaName={schemaName}
          onClose={() => setSchemaImportOpen(false)}
        />
      ) : null}

      {/* Drop schema (M15): destructive, env-aware. Drops every table and
          leaves the schema empty. Refreshes the (now-empty) sidebar itself. */}
      {dropSchemaOpen ? (
        <DropSchemaModal
          handleId={handleId}
          schemaName={schemaName}
          tables={tables ?? []}
          env={workspace.saved.env}
          onClose={() => setDropSchemaOpen(false)}
        />
      ) : null}

      {/* Generate data (M16): append realistic fake data across the schema.
          The store gates its own visibility (renders only when opened). */}
      <GenerateModal />

      {createSchemaOpen ? (
        <CreateSchemaModal
          handleId={handleId}
          existing={workspace.schemas.map((s) => s.name)}
          onCreated={onSchemaCreated}
          onClose={() => setCreateSchemaOpen(false)}
        />
      ) : null}

      {/* Create table (Prompt 6): runs the previewed CREATE TABLE DDL, then
          re-introspects the schema (so the new empty table appears) and opens
          it automatically. */}
      {createTableOpen ? (
        <CreateTableModal
          handleId={handleId}
          schemaName={schemaName}
          engine={engine}
          existing={(tables ?? []).map((t) => t.name)}
          onCreated={(newName) => {
            void loadTables(handleId, schemaName, { force: true });
            openTable(newName);
          }}
          onClose={() => setCreateTableOpen(false)}
        />
      ) : null}
    </aside>
  );
}
