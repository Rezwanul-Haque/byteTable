// Table tab shell — ported from the prototype's workspace.jsx `TableDataTab`
// toolbar (spec §3.5). This milestone (M4-Task2) renders the *real* toolbar
// and a marked content placeholder where Task 3 mounts the data grid; the
// grid + filter builder + structure body are NOT this task.
//
// Mode segmented control: Data is live, Structure is M7 — clicking Structure
// toasts and stays on data (it never calls setTableTabMode('structure')), so
// the toolbar always reflects data mode this milestone.
//
// Row count comes from the Task-3 seam (tabMeta store): the grid reports
// totalRows/elapsedMs per fetch; until it does, the label reads "— rows".

import { IconBtn } from "../../../shared/ui/IconBtn";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { useWorkspacesStore } from "../state";
import { rowCountLabel, useTabMetaStore } from "../tabMeta";
import type { Tab } from "../types";
import "./TableTab.css";

/** Narrow the union — the router only renders this for table tabs. */
type TableTabModel = Extract<Tab, { kind: "table" }>;

export function TableTab({ tab }: { tab: TableTabModel }) {
  const toast = useToast();
  const setTableTabMode = useWorkspacesStore((state) => state.setTableTabMode);
  // Narrow selector: only this tab's meta, so other tabs' fetches don't
  // re-render the toolbar.
  const meta = useTabMetaStore((state) => state.meta[tab.id]);

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
              // Already data, but keep the call for symmetry / future modes.
              if (tab.mode !== "data") setTableTabMode(tab.id, "data");
            }}
          >
            <Icon name="table" size={14} /> Data
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            // Structure body is M7 — toast and stay on data (we never persist
            // 'structure' this milestone). Rendered active=false always.
            className="seg-btn"
            onClick={() => toast("Structure view arrives in M7", "info")}
          >
            <Icon name="account_tree" size={14} /> Structure
          </button>
        </div>

        {/* Filters are M5 — the button renders for layout fidelity but is
            disabled with an explanatory title (no empty panel to open yet). */}
        <button
          type="button"
          className="filter-toggle"
          disabled
          title="Filters arrive in M5"
        >
          <Icon name="filter_list" size={15} /> Filters
          <Icon name="expand_more" size={14} style={{ color: "var(--text-faint)" }} />
        </button>

        {/* Effective-WHERE readout — empty until M5. */}
        <span className="applied-where empty">no filters applied</span>

        <div style={{ flex: 1 }} />

        {/* Refresh: until the grid (Task 3) owns a refetch handle, this nudges
            the seam — a no-op visual today, real once the grid subscribes to
            a refresh signal. Kept enabled so the control is not dead. */}
        <IconBtn
          icon="refresh"
          title="Refresh"
          onClick={() => toast("Refreshed " + tab.table, "ok")}
        />
        <span className="table-rowcount">{rowCountLabel(meta)}</span>
      </div>

      {/*
        M4-Task3: <DataGrid> mounts here.

        Task 3 replaces this placeholder div with the real virtualized grid.
        The grid receives the tab's identity (handleId from the active
        workspace, tab.schema, tab.table, tab.id) and on each rows_fetch
        reports back via the tabMeta seam:

            useTabMetaStore.getState().setTabMeta(tab.id, {
              totalRows: page.totalRows,
              elapsedMs: page.elapsedMs,
            });

        which this toolbar's "N rows" label and the status bar's context info
        read live. Scroll offset stays in a grid-local ref (high-frequency —
        see the WorkspaceUiState churn rule), committed to `ui` only on
        tab/workspace switch if persistence is wanted later.
      */}
      <div className="grid-placeholder">
        <Icon name="table" size={32} style={{ opacity: 0.4 }} />
        <p>Data grid arrives in M4 · Task 3</p>
        <span>{tab.schema + "." + tab.table}</span>
      </div>
    </div>
  );
}
