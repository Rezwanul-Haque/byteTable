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

import { useEffect, useMemo, useState } from "react";

import { DataGrid } from "../../browse/components/DataGrid";
import { FilterPanel } from "../../browse/components/FilterPanel";
import { StructureView } from "../../browse/components/StructureView";
import { appliedDisplaySql, compileToSpec, emptyDraft } from "../../browse/filter";
import { useIntrospectionStore, columnsKey } from "../../introspection/state";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Icon } from "../../../shared/ui/Icon";
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
  const setTableTabMode = useWorkspacesStore((state) => state.setTableTabMode);
  // Narrow selector: only this tab's meta, so other tabs' fetches don't
  // re-render the toolbar.
  const meta = useTabMetaStore((state) => state.meta[tab.id]);
  const requestRefetch = useTabMetaStore((state) => state.requestRefetch);

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
            onFilterError={(message) => {
              setFilterError(message);
              setPanelOpen(true); // keep the panel open so the user can fix it
            }}
            onFilterOk={() => setFilterError(null)}
          />
        </>
      )}
    </div>
  );
}
