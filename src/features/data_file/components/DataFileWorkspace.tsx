// Data-file workspace (M35) — the CSV/TSV viewer and editor, a sibling of
// WorkspaceShell / RedisWorkspace / … that the App routes to when a workspace
// carries a `file`. Same frame as every other engine (sidebar | tab bar +
// content | status bar), so it inherits the app's chrome, rail tile and colour.
//
// The single `doc` memo is the whole contract: parse → profile → issues →
// ad-hoc schema, computed once per file and read by all four tabs.
//
// The file is EDITABLE, and edits are staged: typing in a cell changes nothing
// on disk. The batch lives in this slice's store until Save writes it, exactly
// like the engines' staged grid edits — and the write is a splice that leaves
// every untouched byte alone (see `csvWrite.ts`). The SQLite database behind
// the SQL tab remains a private scratch copy that dies with the workspace; it
// is rebuilt after a save so queries never answer from pre-edit rows.

import { useMemo, useState } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { BuiltByCredit } from "../../../shared/ui/BuiltByCredit";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { Icon } from "../../../shared/ui/Icon";
import { SidebarResizer } from "../../../shared/ui/SidebarResizer";
import { useTabMenu } from "../../../shared/ui/useTabMenu";
import { useToast } from "../../../shared/ui/toastContext";
import { ResourceMeter } from "../../app_metrics/ResourceMeter";
import { useWorkspacesStore } from "../../workspaces/state";
import type { DataFileRef, Workspace } from "../../workspaces/types";
import { delimLabel, fmtBytes } from "../core";
import { isEmptyBatch } from "../csvWrite";
import { useDataFileDoc } from "../doc";
import { pickCopyPath } from "../save";
import { useReplaceDataFile, useSaveDataFile, type SaveTarget } from "../open";
import { DATA_FILE_TABS, initialViewState, useDataFileStore, type DataFileTabKind } from "../state";
import { DataFileDataTab } from "./DataFileDataTab";
import { DataFileIssuesTab } from "./DataFileIssuesTab";
import { DataFileProfileTab } from "./DataFileProfileTab";
import { DataFileSidebar } from "./DataFileSidebar";
import { DataFileSqlTab } from "./DataFileSqlTab";
import { OpenDataFileSheet } from "./OpenDataFileSheet";
// Shared chrome this slice REUSES (importing the owning components' CSS keeps
// the workspace self-contained in `vite dev` and prod alike).
import "../../../features/workspaces/components/WorkspaceContent.css";
import "../../../features/workspaces/components/Sidebar.css";
import "../../../features/workspaces/components/TabBar.css";
import "../../../features/workspaces/components/StatusBar.css";
import "../../../features/workspaces/components/TableTab.css"; // .table-footer / .pager / .filter-toggle
import "../../../features/workspaces/components/SqlEditorTab.css"; // .sql-error
import "../../browse/sql/components/FilterPanel.css";
import "../../browse/shared/DataGrid.css"; // .save-bar / .cell-edited / .row-staged
// Reuse the app's destructive-button styling (.btn-danger) for the discard confirm.
import "../../export/components/TruncateModal.css";
import "./DataFileWorkspace.css";

export function DataFileWorkspace({
  workspace,
  file,
}: {
  workspace: Workspace;
  /** `workspace.file`, already narrowed by the App's routing predicate. */
  file: DataFileRef;
}) {
  const closeWorkspace = useWorkspacesStore((state) => state.closeWorkspace);
  const replaceFile = useReplaceDataFile();
  const saveFile = useSaveDataFile();
  const toast = useToast();

  const view = useDataFileStore((s) => s.byWorkspace[workspace.id]);
  const patch = useDataFileStore((s) => s.patch);
  const openTab = useDataFileStore((s) => s.openTab);
  const closeTabAction = useDataFileStore((s) => s.closeTab);
  const toggleColumn = useDataFileStore((s) => s.toggleColumn);
  const focusColumnAction = useDataFileStore((s) => s.focusColumn);
  const showRowsAction = useDataFileStore((s) => s.showRows);
  const editCell = useDataFileStore((s) => s.editCell);
  const addRow = useDataFileStore((s) => s.addRow);
  const toggleDeleted = useDataFileStore((s) => s.toggleDeleted);
  const discardEdits = useDataFileStore((s) => s.discardEdits);
  const openSqlWith = useDataFileStore((s) => s.openSqlWith);
  const consumeSeedSql = useDataFileStore((s) => s.consumeSeedSql);

  const {
    tabs,
    activeId,
    hidden,
    focusCol,
    rowFilter,
    filter,
    filterOpen,
    filterError,
    sort,
    pendingSort,
    seedSql,
    edits,
  } = view ?? initialViewState();
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);

  const [sheetOpen, setSheetOpen] = useState(false);
  const doc = useDataFileDoc(file);

  const closeTab = (kind: string) => closeTabAction(workspace.id, kind as DataFileTabKind);
  const tabMenu = useTabMenu({
    ids: tabs.map((t) => t.id),
    close: (ids) => ids.forEach(closeTab),
    // The Data tab is the workspace; the strip can never be emptied to nothing.
    canClose: () => tabs.length > 1,
  });

  const reopen = (next: DataFileRef) => {
    setSheetOpen(false);
    void replaceFile(workspace.id, workspace.handleId, next).then((name) => {
      if (name) toast("Opened “" + name + "”", "ok");
    });
  };

  // --- saving staged edits ------------------------------------------------
  const [saving, setSaving] = useState(false);
  const runSave = (target: SaveTarget, note: string) => {
    setSaving(true);
    void saveFile(workspace.id, workspace.handleId, file, edits, target)
      .then((name) => {
        if (name) toast(note.replace("{name}", name), "ok");
      })
      .finally(() => setSaving(false));
  };
  // Overwriting is only possible for a file that came from disk; a generated
  // sample has nowhere to go, so it offers Save a copy alone.
  const saveInPlace = file.path
    ? () => runSave({ path: file.path!, backup: true, name: file.name }, "Saved “{name}”")
    : null;
  const saveCopy = () => {
    void pickCopyPath(file.name)
      .then((path) => {
        if (!path) return;
        // The copy becomes the file this workspace is editing — otherwise the
        // staged edits would vanish while the file still open on disk lacks
        // them, which is a trap.
        const name = path.split(/[\\/]/).pop() ?? file.name;
        runSave({ path, backup: false, name }, "Saved a copy as “{name}” — now editing it");
      })
      .catch(() => toast("Saving a copy requires the desktop app", "info"));
  };

  const dirty = !isEmptyBatch(edits);
  // Anything that would throw the staged batch away asks first — closing the
  // workspace, or re-opening it on another file. The engines warn the same way
  // before discarding staged grid edits; unsaved work must not vanish silently.
  const [confirm, setConfirm] = useState<null | { verb: string; run: () => void }>(null);
  const guard = (verb: string, run: () => void) => (dirty ? setConfirm({ verb, run }) : run());

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0]!;

  return (
    <div className="workspace" data-screen-label={"Data file workspace: " + doc.name}>
      <DataFileSidebar
        workspaceName={workspace.name}
        workspaceColor={workspace.color}
        doc={doc}
        activeKind={activeTab.kind}
        hidden={hiddenSet}
        onOpen={(kind) => openTab(workspace.id, kind)}
        onToggleColumn={(name) => toggleColumn(workspace.id, name)}
        onFocusColumn={(name) => focusColumnAction(workspace.id, name)}
        onReopen={() => guard("Open another file", () => setSheetOpen(true))}
        onCloseWorkspace={() => guard("Close the workspace", () => closeWorkspace(workspace.id))}
      />
      <SidebarResizer />

      <div className="main-col">
        <div className="tabbar" data-screen-label="Data file tab bar">
          <div className="tabbar-tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={"tab" + (t.id === activeId ? " active" : "")}
                onClick={() => patch(workspace.id, { activeId: t.kind })}
                onMouseDown={(e) => {
                  if (e.button === 1 && tabs.length > 1) {
                    e.preventDefault();
                    closeTab(t.kind);
                  }
                }}
                onContextMenu={(e) => tabMenu.onContextMenu(e, t.id)}
                title={t.title}
              >
                <Icon
                  name={DATA_FILE_TABS[t.kind].icon}
                  size={14}
                  style={{ color: t.id === activeId ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="tab-title">{t.title}</span>
                {tabs.length > 1 ? (
                  <button
                    type="button"
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.kind);
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <div className="tabbar-tools">
            <button
              type="button"
              className="tabbar-tool"
              onClick={() => openTab(workspace.id, "sql")}
              title="Query this file with SQL (⌘↩ runs)"
            >
              <Icon name="code" size={15} />
              <span>SQL</span>
            </button>
          </div>
          {tabMenu.element}
        </div>

        <div className="tab-content">
          {/* Every open tab stays mounted so its own state (search text, page,
              query buffer) survives a switch — `display: contents` keeps the
              inactive ones out of the layout entirely. */}
          {tabs.map((t) => (
            <div key={t.id} style={{ display: t.id === activeId ? "contents" : "none" }}>
              {t.kind === "data" ? (
                <DataFileDataTab
                  doc={doc}
                  handleId={workspace.handleId}
                  active={t.id === activeId}
                  hidden={hiddenSet}
                  rowFilter={rowFilter}
                  onRowFilter={(f) => patch(workspace.id, { rowFilter: f })}
                  filter={filter}
                  filterOpen={filterOpen}
                  filterError={filterError}
                  sort={sort}
                  pendingSort={pendingSort}
                  onPatch={(p) => patch(workspace.id, p)}
                  onOpenSql={(sql) => openSqlWith(workspace.id, sql)}
                  edits={edits}
                  onEditCell={(row, col, value, original) =>
                    editCell(workspace.id, row, col, value, original)
                  }
                  onAddRow={() => addRow(workspace.id)}
                  onToggleDeleted={(rows) => toggleDeleted(workspace.id, rows)}
                  onDiscard={() => discardEdits(workspace.id)}
                  onSave={saveInPlace}
                  onSaveCopy={saveCopy}
                  saving={saving}
                />
              ) : t.kind === "profile" ? (
                <DataFileProfileTab doc={doc} focus={focusCol} />
              ) : t.kind === "issues" ? (
                <DataFileIssuesTab
                  doc={doc}
                  onShowRows={(iss) =>
                    showRowsAction(workspace.id, {
                      label: iss.title.length > 42 ? iss.title.slice(0, 42) + "…" : iss.title,
                      rows: iss.rows ?? [],
                    })
                  }
                  onFocusColumn={(name) => focusColumnAction(workspace.id, name)}
                />
              ) : (
                // Keyed by the handle: re-opening the workspace on another
                // file loads a new scratch database, and the tab's buffer and
                // result belong to the old one.
                <DataFileSqlTab
                  key={workspace.handleId}
                  doc={doc}
                  handleId={workspace.handleId}
                  active={t.id === activeId}
                  seedSql={seedSql}
                  onSeedConsumed={() => consumeSeedSql(workspace.id)}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="statusbar" data-screen-label="Data file status bar">
        <span className="ws-chip" style={{ background: workspace.color }} />
        <span className="status-strong">{doc.name}</span>
        {/* The tag reports the file's true state: `unsaved` the moment anything
            is staged, `file` otherwise. It never says "read-only" — it is not. */}
        <span
          className="env-tag"
          style={
            dirty
              ? { color: "var(--accent)", borderColor: "var(--accent)" }
              : { color: "var(--text-faint)", borderColor: "var(--border)" }
          }
        >
          {dirty ? "unsaved" : "file"}
        </span>
        <span className="status-dim">
          {delimLabel(doc.parsed.opts.delimiter)}-delimited · {doc.sniffed.encoding}
        </span>
        <span className="status-dim">
          <Icon name="table_rows" size={11} /> {doc.parsed.rows.length.toLocaleString()} ×{" "}
          {doc.analysis.cols.length}
        </span>
        <div style={{ flex: 1 }} />
        {doc.errors ? (
          <span className="status-dim" style={{ color: "var(--warn)" }}>
            <Icon name="report" size={11} /> {doc.errors} issue{doc.errors === 1 ? "" : "s"}
          </span>
        ) : null}
        <span className="status-dim">
          {fmtBytes(doc.size)} · parsed in {doc.parsed.ms} ms
        </span>
        <span className="status-dim">local file</span>
        <ResourceMeter />
        <BuiltByCredit className="status-dim" />
      </div>

      {sheetOpen ? <OpenDataFileSheet onClose={() => setSheetOpen(false)} onOpen={reopen} /> : null}

      {confirm ? (
        <Modal width={420} label="Discard unsaved changes" onClose={() => setConfirm(null)}>
          <ModalTitle>Discard unsaved changes?</ModalTitle>
          <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.6 }}>
            {doc.name} has changes that have not been written to disk. {confirm.verb} and they are
            lost.
          </div>
          <ModalActions>
            <div style={{ flex: 1 }} />
            <Btn variant="text" small onClick={() => setConfirm(null)}>
              Keep editing
            </Btn>
            <button
              type="button"
              className="btn btn-danger btn-small"
              onClick={() => {
                const run = confirm.run;
                setConfirm(null);
                discardEdits(workspace.id);
                run();
              }}
            >
              <Icon name="delete" size={15} />
              <span>Discard</span>
            </button>
          </ModalActions>
        </Modal>
      ) : null}
    </div>
  );
}
