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

import { DataGrid } from "../../browse/components/DataGrid";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { useWorkspacesStore } from "../state";
import { rowCountLabel, useTabMetaStore } from "../tabMeta";
import type { Tab } from "../types";
import "./TableTab.css";

/** Narrow the union — the router only renders this for table tabs. */
type TableTabModel = Extract<Tab, { kind: "table" }>;

export function TableTab({ tab, handleId }: { tab: TableTabModel; handleId: string }) {
  const toast = useToast();
  const setTableTabMode = useWorkspacesStore((state) => state.setTableTabMode);
  // Narrow selector: only this tab's meta, so other tabs' fetches don't
  // re-render the toolbar.
  const meta = useTabMetaStore((state) => state.meta[tab.id]);
  const requestRefetch = useTabMetaStore((state) => state.requestRefetch);

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
        <button type="button" className="filter-toggle" disabled title="Filters arrive in M5">
          <Icon name="filter_list" size={15} /> Filters
          <Icon name="expand_more" size={14} style={{ color: "var(--text-faint)" }} />
        </button>

        {/* Effective-WHERE readout — empty until M5. */}
        <span className="applied-where empty">no filters applied</span>

        <div style={{ flex: 1 }} />

        {/* Refresh: bumps the tab's refetch nonce on the tabMeta seam; the
            mounted grid watches it and clears its cache + re-fetches +
            re-counts. Declarative — the toolbar need not know a grid exists. */}
        <IconBtn icon="refresh" title="Refresh" onClick={() => requestRefetch(tab.id)} />
        <span className="table-rowcount">{rowCountLabel(meta)}</span>
      </div>

      {/* The virtualized data grid (Task 3). Receives the tab identity +
          backend handle; reports totalRows/elapsedMs/shownRows back through
          the tabMeta seam, which the toolbar label and status bar read. */}
      <DataGrid handleId={handleId} tabId={tab.id} schema={tab.schema} table={tab.table} />
    </div>
  );
}
