// Table tab shell — ported from the prototype's workspace.jsx `TableDataTab`
// toolbar (spec §3.5). Renders the real toolbar, the M5 stackable filter
// builder panel (FilterPanel), and the data grid.
//
// Mode segmented control (M7): Data renders the grid + filter toolbar;
// Structure renders the read-only StructureView (§3.6). The segmented control
// stays in both modes; the Filters / WHERE readout / refresh / row-count are
// data-mode only (the structure view has its own header), so they are not
// rendered in structure mode.
//
// FILTERS (M5): the per-tab filter state lives in the workspace `ui.filters`
// map (survives workspace switches per WorkspaceUiState). This shell owns the
// panel-open toggle (transient, local) and the inline raw-mode error; it
// compiles the *applied* draft to the wire `FilterSpec` and threads it (plus a
// stable key) into the grid. The grid re-windows + re-counts on filter change
// exactly like sort; tabMeta.shownRows/totalRows then drive "n of N rows".

import { useEffect, useMemo, useRef, useState } from "react";

import { DataGrid } from "../../browse/components/DataGrid";
import { FilterPanel } from "../../browse/components/FilterPanel";
import { StructureView } from "../../browse/components/StructureView";
import { appliedDisplaySql, compileToSpec, emptyDraft } from "../../browse/filter";
import { TruncateModal } from "../../export/components/TruncateModal";
import { runExport } from "../../export/exportFlow";
import { useIntrospectionStore, columnsKey } from "../../introspection/state";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import type { ColumnInfo } from "../../../shared/api/engine";
import { useWorkspacesStore } from "../state";
import { rowCountLabel, useTabMetaStore } from "../tabMeta";
import type { TabFilterState, Tab } from "../types";
import "./TableTab.css";

/** Narrow the union — the router only renders this for table tabs. */
type TableTabModel = Extract<Tab, { kind: "table" }>;

export function TableTab({
  tab,
  handleId,
  defaultSchema,
}: {
  tab: TableTabModel;
  handleId: string;
  defaultSchema: string;
}) {
  const toast = useToast();
  const setTableTabMode = useWorkspacesStore((state) => state.setTableTabMode);
  // Narrow selector: only this tab's meta, so other tabs' fetches don't
  // re-render the toolbar.
  const meta = useTabMetaStore((state) => state.meta[tab.id]);
  const requestRefetch = useTabMetaStore((state) => state.requestRefetch);

  // Connection deployment env — drives the TruncateModal's production gate.
  const env =
    useWorkspacesStore((state) => state.workspaces.find((ws) => ws.handleId === handleId)?.saved.env) ??
    "";

  // --- filter state (per-tab, persisted in workspace ui) ---------------
  const setTabFilter = useWorkspacesStore((state) => state.setTabFilter);
  const filterState = useWorkspacesStore(
    (state) =>
      state.workspaces.find((ws) => ws.id === state.activeWorkspaceId)?.ui.filters?.[tab.id],
  );

  // Columns for the panel's column select + value typing + cosmetic SQL. Reads
  // the introspection cache (the grid warms it too) and triggers a load.
  const loadColumns = useIntrospectionStore((state) => state.loadColumns);
  const columnsEntry = useIntrospectionStore(
    (state) => state.columns[columnsKey(handleId, tab.schema, tab.table)],
  );
  const columns: ColumnInfo[] = useMemo(() => columnsEntry?.columns ?? [], [columnsEntry]);
  useEffect(() => {
    void loadColumns(handleId, tab.schema, tab.table);
  }, [loadColumns, handleId, tab.schema, tab.table]);

  // Panel open/close (transient, local) and the inline raw-mode error.
  const [panelOpen, setPanelOpen] = useState(false);
  const [filterError, setFilterError] = useState<string | null>(null);

  // --- M15 Task 2: column show/hide + table-actions + truncate ----------
  // Column hide is display-only, kept as local component state (the prototype
  // keeps it local too — it resets on tab close, which is acceptable). The set
  // holds the *hidden* column names; the grid render-filters on it.
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => new Set());
  const [colOpen, setColOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [truncateOpen, setTruncateOpen] = useState(false);
  const colRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);

  const visibleCount = columns.length - hiddenCols.size;
  const toggleCol = (name: string) =>
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // Outside-mousedown / Escape close the column popover + actions menu.
  useEffect(() => {
    if (!colOpen && !actionsOpen) return;
    const onDown = (event: MouseEvent) => {
      const t = event.target;
      if (!(t instanceof Node)) return;
      if (colOpen && colRef.current?.contains(t)) return;
      if (actionsOpen && actionsRef.current?.contains(t)) return;
      setColOpen(false);
      setActionsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setColOpen(false);
        setActionsOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [colOpen, actionsOpen]);

  const doExport = (kind: "tableCsv" | "tableSql") => {
    setActionsOpen(false);
    void runExport(kind, { handleId, schema: tab.schema, table: tab.table }, toast);
  };

  // The effective applied draft + its compiled wire spec. `applied` is the
  // committed filter the grid fetches with; null/empty → no filter param.
  const applied = filterState?.applied ?? null;
  const filterSpec = useMemo(
    () => (applied ? compileToSpec(applied, columns) : null),
    [applied, columns],
  );
  // Stable identity for the grid's reset machinery (recompute window on change).
  const filterKey = useMemo(() => (filterSpec ? JSON.stringify(filterSpec) : ""), [filterSpec]);
  const appliedWhere = useMemo(() => appliedDisplaySql(applied, columns), [applied, columns]);
  const hasApplied = filterSpec !== null;

  // Ensure a draft exists (lazily) when the panel opens.
  const ensuredState: TabFilterState = filterState ?? {
    draft: emptyDraft(columns[0]?.name ?? ""),
    applied: null,
  };

  const openPanel = () => {
    if (!filterState) {
      setTabFilter(tab.id, { draft: emptyDraft(columns[0]?.name ?? ""), applied: null });
    }
    setPanelOpen((v) => !v);
  };

  const clearFilters = () => {
    // Clears applied AND draft (toolbar clear-filters icon, §3.5).
    setTabFilter(tab.id, { draft: emptyDraft(columns[0]?.name ?? ""), applied: null });
    setFilterError(null);
  };

  const onFilterChange = (next: TabFilterState) => {
    setTabFilter(tab.id, next);
    // A fresh apply supersedes any prior error; the grid clears it on success.
    setFilterError(null);
  };

  return (
    <div className="table-tab">
      <div className="table-toolbar">
        <div className="seg" role="tablist" aria-label="View mode">
          <button
            type="button"
            role="tab"
            aria-selected={tab.mode === "data"}
            className={"seg-btn" + (tab.mode === "data" ? " active" : "")}
            onClick={() => {
              if (tab.mode !== "data") setTableTabMode(tab.id, "data");
            }}
          >
            <Icon name="table" size={14} /> Data
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab.mode === "structure"}
            className={"seg-btn" + (tab.mode === "structure" ? " active" : "")}
            onClick={() => {
              if (tab.mode !== "structure") setTableTabMode(tab.id, "structure");
            }}
          >
            <Icon name="account_tree" size={14} /> Structure
          </button>
        </div>

        {/* Data-mode-only toolbar: the structure view has its own header. */}
        {tab.mode === "data" ? (
          <>
            {/* Filters toggle: opens the builder panel; accent dot when a filter
            is applied (spec §3.5 "filter icon + accent dot when applied"). */}
            <button
              type="button"
              className={
                "filter-toggle" + (panelOpen ? " open" : "") + (hasApplied ? " has-applied" : "")
              }
              onClick={openPanel}
              aria-expanded={panelOpen}
            >
              <Icon name="filter_list" size={15} /> Filters
              {hasApplied ? <span className="filter-dot" /> : null}
              <Icon name="expand_more" size={14} style={{ color: "var(--text-faint)" }} />
            </button>

            {/* Columns popover (M15 Task 2): show/hide columns, All/None,
                per-column checkbox + pk/fk icon + type. The toggle shows a
                shown/total count badge when any column is hidden. */}
            <div className="col-ctrl" ref={colRef} style={{ position: "relative" }}>
              <button
                type="button"
                className={"filter-toggle col-btn" + (hiddenCols.size ? " has-applied" : "")}
                onClick={() => setColOpen((o) => !o)}
                title="Choose which columns are shown"
                aria-haspopup="dialog"
                aria-expanded={colOpen}
                disabled={columns.length === 0}
              >
                <Icon name="view_column" size={15} /> Columns
                {hiddenCols.size ? (
                  <span className="col-count">
                    {visibleCount}/{columns.length}
                  </span>
                ) : null}
                <Icon
                  name={colOpen ? "expand_less" : "expand_more"}
                  size={14}
                  style={{ color: "var(--text-faint)" }}
                />
              </button>
              {colOpen ? (
                <div className="col-pop" role="dialog" aria-label="Show or hide columns">
                  <div className="col-pop-head">
                    <span>Columns</span>
                    <div className="col-pop-actions">
                      <button type="button" onClick={() => setHiddenCols(new Set())}>
                        All
                      </button>
                      <button
                        type="button"
                        onClick={() => setHiddenCols(new Set(columns.map((c) => c.name)))}
                      >
                        None
                      </button>
                    </div>
                  </div>
                  <div className="col-pop-list">
                    {columns.map((c) => {
                      const shown = !hiddenCols.has(c.name);
                      return (
                        <label key={c.name} className="col-pop-item">
                          <input
                            type="checkbox"
                            checked={shown}
                            onChange={() => toggleCol(c.name)}
                          />
                          <span className="col-pop-check">
                            {shown ? <Icon name="check" size={12} /> : null}
                          </span>
                          {c.pk ? (
                            <Icon
                              name="key"
                              size={11}
                              style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
                            />
                          ) : c.fk ? (
                            <Icon name="link" size={11} style={{ color: "var(--text-faint)" }} />
                          ) : null}
                          <span className="col-pop-name">{c.name}</span>
                          <span className="col-pop-type">{c.dataType.toLowerCase()}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Effective-WHERE readout — the applied filter's cosmetic clause,
            ellipsized; italic "no filters applied" when none. */}
            {hasApplied && appliedWhere ? (
              <span className="applied-where" title={appliedWhere}>
                {appliedWhere}
              </span>
            ) : (
              <span className="applied-where empty">no filters applied</span>
            )}

            {/* Clear-filters icon — appears only when a filter is applied. */}
            {hasApplied ? (
              <IconBtn icon="filter_alt_off" title="Clear filters" onClick={clearFilters} />
            ) : null}

            <div style={{ flex: 1 }} />

            <IconBtn icon="refresh" title="Refresh" onClick={() => requestRefetch(tab.id)} />

            {/* Table-actions menu (M15 Task 2): export CSV / SQL, truncate. */}
            <div className="table-actions" ref={actionsRef} style={{ position: "relative" }}>
              <IconBtn
                icon="more_vert"
                title="Table actions"
                active={actionsOpen}
                aria-haspopup="menu"
                aria-expanded={actionsOpen}
                onClick={() => setActionsOpen((o) => !o)}
              />
              {actionsOpen ? (
                <div
                  className="ctx-menu table-actions-menu"
                  role="menu"
                  aria-label={"Actions for " + tab.table}
                >
                  <div className="ctx-menu-label">Export</div>
                  <button
                    type="button"
                    className="ctx-item"
                    role="menuitem"
                    onClick={() => doExport("tableCsv")}
                  >
                    <Icon name="table_view" size={15} /> Export as CSV
                  </button>
                  <button
                    type="button"
                    className="ctx-item"
                    role="menuitem"
                    onClick={() => doExport("tableSql")}
                  >
                    <Icon name="code" size={15} /> Export as SQL (schema + data)
                  </button>
                  <div className="ctx-sep" />
                  <button
                    type="button"
                    className="ctx-item danger"
                    role="menuitem"
                    onClick={() => {
                      setActionsOpen(false);
                      setTruncateOpen(true);
                    }}
                  >
                    <Icon name="delete_sweep" size={15} /> Truncate table…
                  </button>
                </div>
              ) : null}
            </div>

            <span className="table-rowcount">{rowCountLabel(meta)}</span>
          </>
        ) : (
          <div style={{ flex: 1 }} />
        )}
      </div>

      {tab.mode === "structure" ? (
        <StructureView
          handleId={handleId}
          tabId={tab.id}
          schema={tab.schema}
          table={tab.table}
          defaultSchema={defaultSchema}
        />
      ) : (
        <>
          {/* The filter builder panel (M5), under the toolbar. */}
          <FilterPanel
            open={panelOpen}
            columns={columns}
            state={ensuredState}
            error={filterError}
            onChange={onFilterChange}
          />

          {/* The virtualized data grid. Receives the applied filter + a stable
              key; reports totalRows/shownRows/elapsedMs back through tabMeta. */}
          <DataGrid
            handleId={handleId}
            tabId={tab.id}
            schema={tab.schema}
            table={tab.table}
            filter={filterSpec}
            filterKey={filterKey}
            hiddenColumns={hiddenCols}
            onFilterError={(message) => {
              setFilterError(message);
              setPanelOpen(true); // keep the panel open so the user can fix it
            }}
            onFilterOk={() => setFilterError(null)}
          />
        </>
      )}

      {/* Truncate confirm (M15 Task 2): env-aware. On success it refreshes the
          sidebar counts itself; onDone re-fetches this tab's open grid. */}
      {truncateOpen ? (
        <TruncateModal
          handleId={handleId}
          schemaName={tab.schema}
          table={tab.table}
          env={env}
          onClose={() => setTruncateOpen(false)}
          onDone={() => requestRefetch(tab.id)}
        />
      ) : null}
    </div>
  );
}
