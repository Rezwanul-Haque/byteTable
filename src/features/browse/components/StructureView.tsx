// Editable table structure view (spec §3.6) — the Structure mode of a table
// tab. Ported from the prototype's editable `StructureView` (structure.jsx):
// inline rename / type / nullable / default editing, add + drop column, and
// the pending-changes bar (N pending changes · Review SQL · Discard · Apply).
//
// EDITING-STATE MODEL (see ../../structure/ops.ts for the full write-up): the
// user's edits accumulate as an ordered `AlterOp[]` (pendingOps) persisted per
// table tab in the workspace `ui` (so a draft survives the Data↔Structure mode
// switch — which unmounts this view — and workspace switches). The rows shown
// are a *working column set* derived on render by replaying pendingOps over the
// introspected columns (`applyOpsToColumns`), mirroring the backend's
// `compute_target_columns`. The "snapshot for discard" is the introspected
// TableMeta in the cache, so Discard just clears pendingOps.
//
// Layout: a non-scrolling header (tree icon + schema.table + comment + count
// chips), then a two-pane body — the left columns pane (own scroll, sticky
// pane-head with a live filter + "+ Add column") and the right 348px rail
// (own scroll: Indexes / Foreign keys / Referenced by / DDL). The pending bar
// mounts under the body (accent-tinted) when there are edits.
//
// After a successful apply we re-introspect (invalidate + force loadTableMeta)
// so the rows show the new truth, refresh the sidebar's table list (counts),
// and bump this tab's grid refetch nonce so the data grid re-fetches with the
// new columns when the user returns to Data mode.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { highlightSql } from "../shared/highlightSql";
import { useIntrospectionStore, tableMetaKey, tablesKey } from "../../introspection/state";
import { useTabMetaStore } from "../../workspaces/tabMeta";
import { useWorkspacesStore } from "../../workspaces/state";
import { alterApply, alterPreview, type AlterOp, type ColumnInfo } from "../../structure/api";
import {
  applyOpsToColumns,
  applyOpsToForeignKeys,
  applyOpsToIndexes,
  generateForeignKeyName,
  generateIndexName,
  toWireBatch,
  stTypesFor,
  type WorkingColumn,
  type WorkingForeignKey,
  type WorkingIndex,
} from "../../structure/ops";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalTitle } from "../../../shared/ui/Modal";
import { Select } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import "../shared/StructureView.css";

interface StructureViewProps {
  handleId: string;
  /** This tab's id — used to read the warmed row count from tabMeta, persist
   *  the pending-edit batch, and trigger the data grid's refetch after apply. */
  tabId: string;
  schema: string;
  table: string;
  /** Connection's first schema; the prefix is dropped for it (tab-title rule). */
  defaultSchema: string;
}

/** Normalize a typed column name the way the prototype did: trim, collapse
 *  non-word runs to `_`, lowercase. Keeps identifiers safe + matches the
 *  prototype's rename behavior. */
function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/\W+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function StructureView({
  handleId,
  tabId,
  schema,
  table,
  defaultSchema,
}: StructureViewProps) {
  const toast = useToast();
  const [colQuery, setColQuery] = useState("");
  const [ddlOpen, setDdlOpen] = useState(false);
  // Rail accordion: which section is expanded, and whether its add-form is open.
  const [openSection, setOpenSection] = useState<"indexes" | "fks" | "refs" | "ddl" | null>(
    "indexes",
  );
  const [addingIndex, setAddingIndex] = useState(false);
  const [addingFk, setAddingFk] = useState(false);

  const loadTableMeta = useIntrospectionStore((state) => state.loadTableMeta);
  const invalidate = useIntrospectionStore((state) => state.invalidate);
  const loadTables = useIntrospectionStore((state) => state.loadTables);
  const key = tableMetaKey(handleId, schema, table);
  const entry = useIntrospectionStore((state) => state.tableMetas[key]);
  const loading = useIntrospectionStore((state) => state.loading[key] ?? false);
  const error = useIntrospectionStore((state) => state.errors[key]);

  // Rows count chip: reuse this tab's warmed total when the grid has fetched
  // it (Data mode visited); omit otherwise — no COUNT fired just for the chip.
  const totalRows = useTabMetaStore((state) => state.meta[tabId]?.totalRows);
  const requestRefetch = useTabMetaStore((state) => state.requestRefetch);

  // Pending edit batch (persisted per tab in workspace ui).
  const pendingOps = useWorkspacesStore(
    (state) =>
      state.workspaces.find((ws) => ws.id === state.activeWorkspaceId)?.ui.structureEdits?.[tabId],
  );
  const setTabStructureOps = useWorkspacesStore((state) => state.setTabStructureOps);
  const ops = useMemo(() => pendingOps ?? [], [pendingOps]);

  // The connection's engine drives the Structure type menu (SQL Server offers
  // its full 36-type family via `stTypesFor`; other engines keep their list).
  const engine = useWorkspacesStore(
    (state) => state.workspaces.find((ws) => ws.id === state.activeWorkspaceId)?.saved.engine,
  );
  const typeOptions = useMemo(() => [...stTypesFor(engine ?? "sqlite")], [engine]);

  // Local editing UI state (transient — not persisted).
  const [reviewOpen, setReviewOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [previewStatements, setPreviewStatements] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Which cell is being edited: `${origin}:${kind}` or null. Plus the column to
  // auto-focus into name-edit right after Add column.
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [autoEditName, setAutoEditName] = useState<string | null>(null);

  // Fetch on mount/table change, AND re-fetch if the cached meta gets evicted
  // out from under an open view. A force table-list refresh (the settings-driven
  // auto-refresh tick) drops the schema's tableMetas to pick up out-of-band DDL;
  // without repopulating here, `entry` goes undefined and the Structure view
  // would blank and never recover. The `!loading && !error` guard prevents a
  // refetch loop (loadTableMeta also de-dupes in-flight requests).
  useEffect(() => {
    if (!entry && !loading && !error) void loadTableMeta(handleId, schema, table);
  }, [entry, loading, error, loadTableMeta, handleId, schema, table]);

  const meta = entry?.meta ?? null;
  const columns = meta?.columns;

  const working: WorkingColumn[] = useMemo(
    () => (columns ? applyOpsToColumns(columns, ops) : []),
    [columns, ops],
  );

  // ---- op staging ------------------------------------------------------
  // All mutators go through `setOps`, which keeps the persisted batch.
  const setOps = useCallback(
    (next: AlterOp[]) => setTabStructureOps(tabId, next),
    [setTabStructureOps, tabId],
  );

  // A new pending batch invalidates the cached preview/error; recomputed lazily.
  useEffect(() => {
    setPreviewStatements(null);
    setPreviewError(null);
    setApplyError(null);
  }, [ops]);

  const addColumn = () => {
    const existing = new Set(working.map((c) => c.name));
    let name = "new_column";
    let i = 2;
    while (existing.has(name)) name = "new_column_" + i++;
    setOps([...ops, { op: "addColumn", name, dataType: "TEXT", nullable: true, default: null }]);
    setAutoEditName(name);
  };

  // Rename a working column. For a freshly added column (origin null) this
  // mutates the AddColumn op in place rather than emitting a renameColumn op
  // (the column does not exist on the server yet). For an introspected column
  // it folds a renameColumn keyed by the ORIGINAL name (last-wins; renaming
  // back to the original removes the op).
  const renameColumn = (col: WorkingColumn, raw: string) => {
    const newName = normalizeName(raw);
    if (!newName || newName === col.name) return;
    if (working.some((c) => c !== col && c.name === newName)) {
      toast(`Column "${newName}" already exists on ${table}`, "err");
      return;
    }
    if (col.origin === null) {
      // Edit the AddColumn op's name.
      setOps(
        ops.map((o) => (o.op === "addColumn" && o.name === col.name ? { ...o, name: newName } : o)),
      );
      return;
    }
    const origin = col.origin;
    const rest = ops.filter((o) => !(o.op === "renameColumn" && o.from === origin));
    if (newName === origin) {
      setOps(rest); // renamed back to truth → drop the rename
    } else {
      setOps([...rest, { op: "renameColumn", from: origin, to: newName }]);
    }
  };

  const changeType = (col: WorkingColumn, newType: string) => {
    if (newType === col.dataType) return;
    if (col.origin === null) {
      setOps(
        ops.map((o) =>
          o.op === "addColumn" && o.name === col.name ? { ...o, dataType: newType } : o,
        ),
      );
      return;
    }
    const origin = col.origin;
    const introspected = columns?.find((c) => c.name === origin);
    const rest = ops.filter((o) => !(o.op === "changeType" && o.column === origin));
    if (introspected && newType === introspected.dataType) {
      setOps(rest);
    } else {
      setOps([...rest, { op: "changeType", column: origin, newType }]);
    }
  };

  const toggleNullable = (col: WorkingColumn) => {
    if (col.pk) return; // pk is implicitly NOT NULL — locked
    const nextNullable = !col.nullable;
    if (col.origin === null) {
      setOps(
        ops.map((o) =>
          o.op === "addColumn" && o.name === col.name ? { ...o, nullable: nextNullable } : o,
        ),
      );
      return;
    }
    const origin = col.origin;
    const introspected = columns?.find((c) => c.name === origin);
    const rest = ops.filter((o) => !(o.op === "setNullable" && o.column === origin));
    if (introspected && nextNullable === introspected.nullable) {
      setOps(rest);
    } else {
      setOps([...rest, { op: "setNullable", column: origin, nullable: nextNullable }]);
    }
  };

  const changeDefault = (col: WorkingColumn, raw: string) => {
    const trimmed = raw.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === col.default) return;
    if (col.origin === null) {
      setOps(
        ops.map((o) => (o.op === "addColumn" && o.name === col.name ? { ...o, default: next } : o)),
      );
      return;
    }
    const origin = col.origin;
    const introspected = columns?.find((c) => c.name === origin);
    const rest = ops.filter((o) => !(o.op === "setDefault" && o.column === origin));
    if (introspected && next === (introspected.default ?? null)) {
      setOps(rest);
    } else {
      setOps([...rest, { op: "setDefault", column: origin, default: next }]);
    }
  };

  const dropColumn = (col: WorkingColumn) => {
    if (col.pk) return; // pk-protected
    if (col.origin === null) {
      // A just-added column: remove its AddColumn op (and any edits to it).
      setOps(ops.filter((o) => !(o.op === "addColumn" && o.name === col.name)));
      return;
    }
    const origin = col.origin;
    setOps([...ops, { op: "dropColumn", name: origin }]);
  };

  const undropColumn = (col: WorkingColumn) => {
    if (col.origin === null) return;
    const origin = col.origin;
    setOps(ops.filter((o) => !(o.op === "dropColumn" && o.name === origin)));
  };

  // ---- index + foreign-key working sets + staging ----------------------
  const workingIndexes: WorkingIndex[] = useMemo(
    () => (meta ? applyOpsToIndexes(meta.indexes, ops) : []),
    [meta, ops],
  );
  const workingForeignKeys: WorkingForeignKey[] = useMemo(
    () => (meta ? applyOpsToForeignKeys(meta.foreignKeys, ops, table) : []),
    [meta, ops, table],
  );

  const addIndex = (cols: string[], unique: boolean) => {
    if (cols.length === 0) return;
    const taken = workingIndexes.map((ix) => ix.name);
    const name = generateIndexName(table, cols, taken);
    setOps([...ops, { op: "addIndex", name, columns: cols, unique }]);
    setAddingIndex(false);
  };

  const dropIndex = (ix: WorkingIndex) => {
    if (ix.primary) return; // primary-key index is protected
    if (ix.isNew) {
      // A just-staged index: remove its addIndex op.
      setOps(ops.filter((o) => !(o.op === "addIndex" && o.name === ix.name)));
      return;
    }
    setOps([...ops, { op: "dropIndex", name: ix.name }]);
  };

  const undropIndex = (ix: WorkingIndex) => {
    setOps(ops.filter((o) => !(o.op === "dropIndex" && o.name === ix.name)));
  };

  const addForeignKey = (
    cols: string[],
    refTable: string,
    refCols: string[],
    onDelete: string | null,
  ) => {
    if (cols.length === 0 || !refTable || refCols.length === 0) return;
    const taken = workingForeignKeys.map((fk) => fk.name);
    const name = generateForeignKeyName(table, cols, taken);
    setOps([
      ...ops,
      { op: "addForeignKey", name, columns: cols, refTable, refColumns: refCols, onDelete },
    ]);
    setAddingFk(false);
  };

  const dropForeignKey = (fk: WorkingForeignKey) => {
    if (fk.isNew) {
      setOps(ops.filter((o) => !(o.op === "addForeignKey" && o.name === fk.name)));
      return;
    }
    setOps([...ops, { op: "dropForeignKey", name: fk.name, columns: fk.columns }]);
  };

  const undropForeignKey = (fk: WorkingForeignKey) => {
    setOps(
      ops.filter(
        (o) =>
          !(
            o.op === "dropForeignKey" &&
            (o.name === fk.name ||
              (o.columns.length === fk.columns.length &&
                o.columns.every((c, i) => c === fk.columns[i])))
          ),
      ),
    );
  };

  // ---- preview / apply / discard ---------------------------------------
  const wireBatch = useMemo(() => toWireBatch(ops), [ops]);

  // Fetch the Review SQL statements when the user expands the panel (or after
  // the batch changes while it is open). Pure on the backend (no DB write).
  useEffect(() => {
    if (!reviewOpen || wireBatch.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await alterPreview(handleId, schema, table, wireBatch);
        if (!cancelled) {
          setPreviewStatements(res.statements);
          setPreviewError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setPreviewStatements(null);
          setPreviewError(appErrorMessage(err, "Could not preview the changes."));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reviewOpen, wireBatch, handleId, schema, table]);

  const applyPending = async () => {
    if (wireBatch.length === 0 || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      await alterApply(handleId, schema, table, wireBatch);
      // Success: clear the batch, re-introspect (force) so the view shows the
      // new truth, refresh the sidebar table list (counts) and the data grid.
      setOps([]);
      setReviewOpen(false);
      invalidate(handleId, schema);
      await loadTableMeta(handleId, schema, table);
      void loadTables(handleId, schema, { force: true });
      requestRefetch(tabId);
      toast(`Applied ${wireBatch.length} change${wireBatch.length === 1 ? "" : "s"}`, "ok");
    } catch (err) {
      // Backend rolled back (DB unchanged). Keep pendingOps so the user can
      // adjust; show the engine error IN THE PENDING BAR (acceptance §5).
      setApplyError(appErrorMessage(err, "Could not apply the changes."));
    } finally {
      setApplying(false);
    }
  };

  const discardPending = () => {
    setOps([]);
    setReviewOpen(false);
    setApplyError(null);
    setPreviewStatements(null);
    setPreviewError(null);
    setEditingCell(null);
    setAutoEditName(null);
    toast("Pending changes discarded");
  };

  const qualified = schema === defaultSchema ? table : schema + "." + table;
  const inbound = meta?.referencedBy ?? [];

  const q = colQuery.trim().toLowerCase();
  const filteredCols = useMemo(() => {
    return q
      ? working.filter(
          (c) => c.name.toLowerCase().includes(q) || c.dataType.toLowerCase().includes(q),
        )
      : working;
  }, [working, q]);

  const ddl = meta?.ddl ?? "";
  const copyDdl = () => {
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(ddl);
    toast("DDL copied to clipboard", "ok");
  };

  // --- error / loading states (§5 inline red; no modal) ------------------
  if (error && !meta) {
    return (
      <div className="structure-view">
        <div className="dg-state">
          <Icon name="error" size={28} style={{ color: "#e06c75" }} />
          <div className="dg-error">
            Could not load table structure.
            <code>{error}</code>
          </div>
          <button
            type="button"
            className="dg-retry"
            onClick={() => void loadTableMeta(handleId, schema, table)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (loading && !meta) {
    return (
      <div className="structure-view">
        <div className="dg-state">
          <Icon name="account_tree" size={28} style={{ opacity: 0.5 }} />
          <span>Loading structure of {qualified}…</span>
        </div>
      </div>
    );
  }

  if (!meta) {
    return <div className="structure-view" />;
  }

  const colCount = working.filter((c) => !c.markedForDrop).length;

  return (
    <div className="structure-view">
      <div className="structure-head">
        <Icon name="account_tree" size={20} style={{ color: "var(--accent)" }} />
        <h2>{qualified}</h2>
        {meta.comment ? <span className="structure-sub">{meta.comment}</span> : null}
        <div style={{ flex: 1 }} />
        <div className="structure-chips">
          <span className="structure-chip">
            <b>{colCount}</b> columns
          </span>
          <span className="structure-chip">
            <b>{workingIndexes.filter((ix) => !ix.markedForDrop).length}</b> indexes
          </span>
          <span className="structure-chip">
            <b>{workingForeignKeys.filter((fk) => !fk.markedForDrop).length}</b> FKs
          </span>
          <span className="structure-chip">
            <b>{inbound.length}</b> referenced by
          </span>
          {typeof totalRows === "number" ? (
            <span className="structure-chip">
              <b>{totalRows.toLocaleString()}</b> rows
            </span>
          ) : null}
        </div>
      </div>

      <div className="structure-body">
        <section className="columns-pane">
          <div className="columns-pane-head">
            <h3>
              <Icon name="view_column" size={15} /> Columns
            </h3>
            <div className="columns-search">
              <Icon name="search" size={14} style={{ color: "var(--text-faint)" }} />
              <input
                aria-label={"Filter " + colCount + " columns"}
                placeholder={"Filter " + colCount + " columns…"}
                value={colQuery}
                onChange={(e) => setColQuery(e.target.value)}
                spellCheck={false}
              />
              {colQuery ? (
                <IconBtn icon="close" size={12} title="Clear" onClick={() => setColQuery("")} />
              ) : null}
            </div>
            <span className="columns-count">
              {q ? filteredCols.length + " of " + colCount : colCount}
            </span>
            <button type="button" className="add-col-btn" onClick={addColumn}>
              <Icon name="add" size={14} /> Add column
            </button>
          </div>
          <div className="columns-scroll">
            <table className="structure-table st-editable-table">
              <thead>
                <tr>
                  <th className="st-num-h">#</th>
                  <th />
                  <th>Name</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  <th>Default</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredCols.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="grid-empty-cell">
                      No columns match “{colQuery}”
                    </td>
                  </tr>
                ) : (
                  filteredCols.map((c, i) => (
                    <ColumnRow
                      key={c.origin ?? "new:" + c.name}
                      col={c}
                      num={i + 1}
                      typeOptions={typeOptions}
                      autoEditName={autoEditName}
                      onAutoEditConsumed={() => setAutoEditName(null)}
                      editingCell={editingCell}
                      setEditingCell={setEditingCell}
                      onRename={renameColumn}
                      onChangeType={changeType}
                      onToggleNullable={toggleNullable}
                      onChangeDefault={changeDefault}
                      onDrop={dropColumn}
                      onUndrop={undropColumn}
                    />
                  ))
                )}
              </tbody>
            </table>
            <div className="st-edit-hint">
              Double-click a name, type or default to edit · click nullable to toggle · changes
              stage below before applying
            </div>
          </div>
        </section>

        <aside className="structure-rail accordion">
          <AccSection
            open={openSection === "indexes"}
            onToggle={() => setOpenSection((s) => (s === "indexes" ? null : "indexes"))}
            icon="speed"
            label="Indexes"
            count={workingIndexes.filter((ix) => !ix.markedForDrop).length}
            add={{
              active: addingIndex,
              title: "Add index",
              onToggle: () => {
                setOpenSection("indexes");
                setAddingIndex((v) => !v);
                setAddingFk(false);
              },
            }}
          >
            {addingIndex ? (
              <AddIndexForm
                columns={working.filter((c) => !c.markedForDrop)}
                onCancel={() => setAddingIndex(false)}
                onAdd={addIndex}
              />
            ) : null}
            <div className="acc-scroll">
              {workingIndexes.length === 0 ? (
                <div className="structure-none">No indexes</div>
              ) : (
                workingIndexes.map((ix) => (
                  <div
                    key={ix.name}
                    className={
                      "structure-card" +
                      (ix.isNew ? " structure-card-new" : "") +
                      (ix.markedForDrop ? " structure-card-drop" : "")
                    }
                  >
                    <div className="structure-card-name">
                      {ix.name}
                      {ix.primary ? (
                        <span className="tag tag-accent">PRIMARY</span>
                      ) : ix.unique ? (
                        <span className="tag">UNIQUE</span>
                      ) : null}
                      <span style={{ flex: 1 }} />
                      {ix.primary ? null : ix.markedForDrop ? (
                        <button
                          type="button"
                          className="card-drop"
                          title={"Keep " + ix.name}
                          onClick={() => undropIndex(ix)}
                        >
                          <Icon name="undo" size={13} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="card-drop"
                          title={"Drop " + ix.name}
                          onClick={() => dropIndex(ix)}
                        >
                          <Icon name="delete" size={13} />
                        </button>
                      )}
                    </div>
                    <div className="structure-card-detail">({ix.columns.join(", ")})</div>
                  </div>
                ))
              )}
            </div>
          </AccSection>

          <AccSection
            open={openSection === "fks"}
            onToggle={() => setOpenSection((s) => (s === "fks" ? null : "fks"))}
            icon="link"
            label="Foreign keys"
            count={workingForeignKeys.filter((fk) => !fk.markedForDrop).length}
            add={{
              active: addingFk,
              title: "Add foreign key",
              onToggle: () => {
                setOpenSection("fks");
                setAddingFk((v) => !v);
                setAddingIndex(false);
              },
            }}
          >
            {addingFk ? (
              <AddFkForm
                handleId={handleId}
                schema={schema}
                table={table}
                columns={working.filter((c) => !c.markedForDrop)}
                onCancel={() => setAddingFk(false)}
                onAdd={addForeignKey}
              />
            ) : null}
            <div className="acc-scroll">
              {workingForeignKeys.length === 0 && !addingFk ? (
                <div className="structure-none">No foreign keys</div>
              ) : (
                workingForeignKeys.map((fk) => (
                  <div
                    key={fk.name}
                    className={
                      "structure-card" +
                      (fk.isNew ? " structure-card-new" : "") +
                      (fk.markedForDrop ? " structure-card-drop" : "")
                    }
                  >
                    <div className="structure-card-name">
                      {fk.name}
                      <span style={{ flex: 1 }} />
                      {fk.markedForDrop ? (
                        <button
                          type="button"
                          className="card-drop"
                          title={"Keep " + fk.name}
                          onClick={() => undropForeignKey(fk)}
                        >
                          <Icon name="undo" size={13} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="card-drop"
                          title={"Drop " + fk.name}
                          onClick={() => dropForeignKey(fk)}
                        >
                          <Icon name="delete" size={13} />
                        </button>
                      )}
                    </div>
                    <div className="structure-card-detail">
                      ({fk.columns.join(", ")}) → {fk.refTable}({fk.refColumns.join(", ")})
                      {fk.onDelete ? (
                        <span className="tag" style={{ marginLeft: 8 }}>
                          ON DELETE {fk.onDelete}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          </AccSection>

          <AccSection
            open={openSection === "refs"}
            onToggle={() => setOpenSection((s) => (s === "refs" ? null : "refs"))}
            icon="call_received"
            label="Referenced by"
            count={inbound.length}
          >
            <div className="acc-scroll">
              {inbound.length === 0 ? (
                <div className="structure-none">No tables reference {table}</div>
              ) : (
                inbound.map((fk, i) => (
                  <div key={fk.table + "-" + i} className="structure-card">
                    <div className="structure-card-name">{fk.table}</div>
                    <div className="structure-card-detail">
                      {fk.table}({fk.columns.join(", ")}) → {table}({fk.refColumns.join(", ")})
                      {fk.onDelete ? (
                        <span className="tag" style={{ marginLeft: 8 }}>
                          ON DELETE {fk.onDelete}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="rail-readonly-note">Edit these on the referencing table</div>
          </AccSection>

          <AccSection
            open={openSection === "ddl"}
            onToggle={() => setOpenSection((s) => (s === "ddl" ? null : "ddl"))}
            icon="code"
            label="DDL"
            actions={
              ddl ? (
                <>
                  <span
                    className="ddl-copy"
                    role="button"
                    tabIndex={0}
                    title="Copy DDL"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyDdl();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        copyDdl();
                      }
                    }}
                  >
                    <Icon name="content_copy" size={13} /> copy
                  </span>
                  <span
                    className="ddl-copy"
                    role="button"
                    tabIndex={0}
                    title="View full DDL"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDdlOpen(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        setDdlOpen(true);
                      }
                    }}
                  >
                    <Icon name="open_in_full" size={13} /> expand
                  </span>
                </>
              ) : null
            }
          >
            {ddl ? (
              <pre
                className="ddl-block acc-ddl-block"
                dangerouslySetInnerHTML={{ __html: highlightSql(ddl) }}
              />
            ) : (
              <div className="structure-none">No DDL available</div>
            )}
          </AccSection>
        </aside>
      </div>

      {ops.length > 0 ? (
        <div className="pending-bar">
          {reviewOpen ? (
            <div className="pending-list">
              <div className="pending-list-title">Pending statements</div>
              {previewError ? (
                <div className="pending-error" role="alert">
                  {previewError}
                </div>
              ) : previewStatements ? (
                previewStatements.map((sql, i) => (
                  <pre
                    key={i}
                    className="pending-sql"
                    dangerouslySetInnerHTML={{ __html: highlightSql(sql) }}
                  />
                ))
              ) : (
                <div className="structure-none">Loading SQL…</div>
              )}
            </div>
          ) : null}
          {applyError ? (
            <div className="pending-error pending-error-row" role="alert">
              <Icon name="error" size={15} style={{ color: "#e06c75" }} />
              {applyError}
            </div>
          ) : null}
          <div className="pending-bar-row">
            <Icon name="pending_actions" size={16} style={{ color: "var(--accent)" }} />
            <span className="pending-count">
              {ops.length} pending change{ops.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="pending-review"
              onClick={() => setReviewOpen((v) => !v)}
              aria-expanded={reviewOpen}
            >
              <Icon name={reviewOpen ? "expand_more" : "expand_less"} size={14} />
              {reviewOpen ? "Hide SQL" : "Review SQL"}
            </button>
            <div style={{ flex: 1 }} />
            <Btn variant="text" small onClick={discardPending} disabled={applying}>
              Discard
            </Btn>
            <Btn variant="filled" icon="check" small onClick={applyPending} disabled={applying}>
              {applying ? "Applying…" : "Apply changes"}
            </Btn>
          </div>
        </div>
      ) : null}

      {ddlOpen ? (
        <Modal
          onClose={() => setDdlOpen(false)}
          className="ddl-modal"
          label={"DDL for " + qualified}
        >
          <ModalTitle>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Icon name="code" size={17} style={{ color: "var(--accent)" }} /> DDL · {qualified}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn icon="content_copy" variant="tonal" small onClick={copyDdl}>
                Copy
              </Btn>
              <IconBtn icon="close" onClick={() => setDdlOpen(false)} title="Close" />
            </div>
          </ModalTitle>
          <pre
            className="ddl-block ddl-modal-block"
            dangerouslySetInnerHTML={{ __html: highlightSql(ddl) }}
          />
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column row + inline editors
// ---------------------------------------------------------------------------

interface ColumnRowProps {
  col: WorkingColumn;
  /** 1-based position shown in the leading `#` gutter. */
  num: number;
  /** Engine-specific type-menu options (`stTypesFor`). */
  typeOptions: string[];
  autoEditName: string | null;
  onAutoEditConsumed: () => void;
  editingCell: string | null;
  setEditingCell: (cell: string | null) => void;
  onRename: (col: WorkingColumn, raw: string) => void;
  onChangeType: (col: WorkingColumn, type: string) => void;
  onToggleNullable: (col: WorkingColumn) => void;
  onChangeDefault: (col: WorkingColumn, raw: string) => void;
  onDrop: (col: WorkingColumn) => void;
  onUndrop: (col: WorkingColumn) => void;
}

function ColumnRow({
  col,
  num,
  typeOptions,
  autoEditName,
  onAutoEditConsumed,
  editingCell,
  setEditingCell,
  onRename,
  onChangeType,
  onToggleNullable,
  onChangeDefault,
  onDrop,
  onUndrop,
}: ColumnRowProps) {
  const cellId = (kind: string) => (col.origin ?? "new:" + col.name) + ":" + kind;
  const rowClass = (col.isNew ? "st-row-new" : "") + (col.markedForDrop ? " st-row-drop" : "");

  // Auto-focus into name editing right after Add column.
  const startNameEdit = autoEditName === col.name && col.origin === null;

  return (
    <tr className={rowClass.trim() || undefined}>
      <td className="st-num">{num}</td>
      <td className="st-icon">
        {col.pk ? (
          <Icon
            name="key"
            size={14}
            style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
          />
        ) : col.fk ? (
          <Icon name="link" size={14} style={{ color: "var(--text-faint)" }} />
        ) : null}
      </td>
      <td className="st-name">
        <EditableText
          value={col.name}
          startEditing={startNameEdit}
          onStarted={onAutoEditConsumed}
          editing={editingCell === cellId("name")}
          onEdit={() => setEditingCell(cellId("name"))}
          onDone={() => setEditingCell(null)}
          onCommit={(v) => onRename(col, v)}
          title="Double-click to rename"
          render={() => (
            <>
              {col.name}
              {col.fk ? (
                <span className="st-fk-ref">
                  → {col.fk.table}
                  {col.fk.column ? "." + col.fk.column : ""}
                </span>
              ) : null}
            </>
          )}
        />
      </td>
      <td>
        <TypeCell
          value={col.dataType}
          typeOptions={typeOptions}
          pk={col.pk}
          editing={editingCell === cellId("type")}
          onEdit={() => setEditingCell(cellId("type"))}
          onDone={() => setEditingCell(null)}
          onCommit={(t) => onChangeType(col, t)}
        />
      </td>
      <td className="st-null">
        <button
          type="button"
          className={"st-null-toggle" + (col.pk ? " locked" : "")}
          onClick={() => onToggleNullable(col)}
          disabled={col.pk}
          title={col.pk ? "Primary key — always NOT NULL" : "Click to toggle nullability"}
        >
          {col.nullable ? (
            <span className="cell-dim">NULL</span>
          ) : (
            <span className="cell-true">NOT NULL</span>
          )}
        </button>
      </td>
      <td className="st-default">
        <EditableText
          value={col.default ?? ""}
          placeholder="NULL"
          editing={editingCell === cellId("default")}
          onEdit={() => setEditingCell(cellId("default"))}
          onDone={() => setEditingCell(null)}
          onCommit={(v) => onChangeDefault(col, v)}
          title="Double-click to edit default"
          render={() =>
            col.default === null || col.default === "" ? (
              <span className="cell-null">NULL</span>
            ) : (
              <code>{col.default}</code>
            )
          }
        />
      </td>
      <td className="st-actions">
        {col.pk ? null : col.markedForDrop ? (
          <button
            type="button"
            className="st-drop st-undrop"
            title={"Keep column " + col.name}
            onClick={() => onUndrop(col)}
          >
            <Icon name="undo" size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="st-drop"
            title={"Drop column " + col.name}
            onClick={() => onDrop(col)}
          >
            <Icon name="delete" size={14} />
          </button>
        )}
      </td>
    </tr>
  );
}

interface EditableTextProps {
  value: string;
  placeholder?: string;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onCommit: (value: string) => void;
  render: () => ReactNode;
  title: string;
  /** When true, enter edit mode automatically (the Add column flow). */
  startEditing?: boolean;
  onStarted?: () => void;
}

function EditableText({
  value,
  placeholder,
  editing,
  onEdit,
  onDone,
  onCommit,
  render,
  title,
  startEditing,
  onStarted,
}: EditableTextProps) {
  const [draft, setDraft] = useState("");

  // Auto-enter edit mode for a freshly added column's name.
  useEffect(() => {
    if (startEditing) {
      setDraft(value);
      onEdit();
      onStarted?.();
    }
    // Only react to the startEditing flag flipping on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEditing]);

  const commit = () => {
    onDone();
    onCommit(draft);
  };

  if (editing) {
    return (
      <input
        className="st-edit-input"
        autoFocus
        value={draft}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={title}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onDone();
        }}
      />
    );
  }
  return (
    <span
      className="st-editable"
      title={title}
      role="button"
      tabIndex={0}
      onDoubleClick={() => {
        setDraft(value);
        onEdit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setDraft(value);
          onEdit();
        }
      }}
    >
      {render()}
    </span>
  );
}

interface TypeCellProps {
  value: string;
  /** Engine-specific type-menu options (`stTypesFor`). */
  typeOptions: string[];
  pk: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onCommit: (type: string) => void;
}

function TypeCell({ value, typeOptions, pk, editing, onEdit, onDone, onCommit }: TypeCellProps) {
  const options = useMemo(() => {
    const base: string[] = [...typeOptions];
    // Always include the column's current declared type so the select shows it
    // even when it isn't one of the offered common types.
    return base.includes(value) ? base : [value, ...base];
  }, [value, typeOptions]);

  if (pk) {
    // PK columns can't be retyped (backend rejects; disable the affordance).
    return (
      <span className="st-type" title="Primary key column — type is locked">
        {value.toLowerCase() || "—"}
      </span>
    );
  }

  if (editing) {
    // Inline editor: open immediately; picking a type commits, and any close
    // (Escape / outside-click) exits edit mode.
    return (
      <Select
        className="st-type-select"
        autoOpen
        aria-label="Column type"
        value={value}
        options={options.map((t) => ({ value: t, label: t }))}
        onChange={onCommit}
        onClose={onDone}
      />
    );
  }
  return (
    <span
      className="st-editable st-type"
      title="Double-click to change type"
      role="button"
      tabIndex={0}
      onDoubleClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEdit();
        }
      }}
    >
      {value.toLowerCase() || "—"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rail accordion section + index/FK add-forms
// ---------------------------------------------------------------------------

interface AccSectionProps {
  open: boolean;
  onToggle: () => void;
  icon: string;
  label: string;
  count?: number;
  /** Optional "+" add toggle in the head (Indexes / Foreign keys). */
  add?: { active: boolean; title: string; onToggle: () => void };
  /** Optional head-trailing actions (DDL copy/expand). */
  actions?: ReactNode;
  children: ReactNode;
}

/** One collapsible rail section (ported from the prototype's `.acc-section`).
 *  The head is a `role="button"` div so the optional "+" / action controls
 *  inside it stay valid interactive children. */
function AccSection({
  open,
  onToggle,
  icon,
  label,
  count,
  add,
  actions,
  children,
}: AccSectionProps) {
  return (
    <div className={"acc-section" + (open ? " open" : "")}>
      <div
        className="acc-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Icon
          name={open ? "expand_more" : "chevron_right"}
          size={16}
          style={{ color: "var(--text-faint)" }}
        />
        <Icon name={icon} size={15} /> {label}
        {typeof count === "number" ? <span className="rail-count">{count}</span> : null}
        <span style={{ flex: 1 }} />
        {actions}
        {add ? (
          <button
            type="button"
            className="rail-add"
            title={add.title}
            aria-pressed={add.active}
            onClick={(e) => {
              e.stopPropagation();
              add.onToggle();
            }}
          >
            <Icon name={add.active && open ? "close" : "add"} size={15} />
          </button>
        ) : null}
      </div>
      {open ? <div className="acc-body">{children}</div> : null}
    </div>
  );
}

interface AddIndexFormProps {
  columns: WorkingColumn[];
  onAdd: (columns: string[], unique: boolean) => void;
  onCancel: () => void;
}

/** Inline "add index" form: toggle column chips + a unique flag. */
function AddIndexForm({ columns, onAdd, onCancel }: AddIndexFormProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const toggle = (n: string) =>
    setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
  return (
    <div className="st-addform">
      <div className="st-addform-cols">
        {columns.map((c) => (
          <button
            key={c.name}
            type="button"
            className={"st-chip" + (picked.includes(c.name) ? " on" : "")}
            onClick={() => toggle(c.name)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <label className="st-addform-row">
        <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />{" "}
        Unique index
      </label>
      <div className="st-addform-actions">
        <Btn variant="text" small onClick={onCancel}>
          Cancel
        </Btn>
        <Btn
          variant="filled"
          small
          icon="add"
          disabled={picked.length === 0}
          onClick={() => onAdd(picked, unique)}
        >
          Add index
        </Btn>
      </div>
    </div>
  );
}

interface AddFkFormProps {
  handleId: string;
  schema: string;
  table: string;
  columns: WorkingColumn[];
  onAdd: (
    columns: string[],
    refTable: string,
    refColumns: string[],
    onDelete: string | null,
  ) => void;
  onCancel: () => void;
}

const ON_DELETE_ACTIONS = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"] as const;

/** Inline "add foreign key" form: a local column → referenced table.column, plus
 *  an ON DELETE action. The referenced table's columns are introspected lazily
 *  via the store (other tables in the same schema). */
function AddFkForm({ handleId, schema, table, columns, onAdd, onCancel }: AddFkFormProps) {
  const loadTables = useIntrospectionStore((s) => s.loadTables);
  const loadTableMeta = useIntrospectionStore((s) => s.loadTableMeta);
  const tablesEntry = useIntrospectionStore((s) => s.tables[tablesKey(handleId, schema)]);

  useEffect(() => {
    void loadTables(handleId, schema);
  }, [loadTables, handleId, schema]);

  const otherTables = useMemo(
    () => (tablesEntry?.tables ?? []).map((t) => t.name).filter((n) => n !== table),
    [tablesEntry, table],
  );

  const [col, setCol] = useState(columns[0]?.name ?? "");
  // Selections start empty and fall back to a derived default (first other
  // table / referenced pk) — derived rather than set via effects to avoid
  // cascading-render set-state-in-effect.
  const [refTableSel, setRefTable] = useState("");
  const [refColSel, setRefCol] = useState("");
  const [onDelete, setOnDelete] = useState<string>("RESTRICT");

  const refTable = refTableSel || otherTables[0] || "";

  // Introspect the referenced table's columns (cache-first).
  const refMetaEntry = useIntrospectionStore((s) =>
    refTable ? s.tableMetas[tableMetaKey(handleId, schema, refTable)] : undefined,
  );
  useEffect(() => {
    if (refTable) void loadTableMeta(handleId, schema, refTable);
  }, [loadTableMeta, handleId, schema, refTable]);

  const refCols: ColumnInfo[] = refMetaEntry?.meta?.columns ?? [];
  const defaultRefCol = (refCols.find((c) => c.pk) ?? refCols[0])?.name ?? "";
  const refCol = refColSel || defaultRefCol;

  if (otherTables.length === 0) {
    return (
      <div className="st-addform">
        <div className="structure-none">No other tables in this schema to reference.</div>
        <div className="st-addform-actions">
          <Btn variant="text" small onClick={onCancel}>
            Cancel
          </Btn>
        </div>
      </div>
    );
  }

  const canAdd = col !== "" && refTable !== "" && refCol !== "";

  return (
    <div className="st-addform">
      <div className="st-fk-grid">
        <Select
          aria-label="Local column"
          value={col}
          options={columns.map((c) => ({ value: c.name, label: c.name }))}
          onChange={setCol}
        />
        <span className="st-fk-arrow">→</span>
        <Select
          aria-label="Referenced table"
          value={refTable}
          options={otherTables.map((t) => ({ value: t, label: t }))}
          onChange={(t) => {
            setRefTable(t);
            setRefCol(""); // re-default to the new table's pk
          }}
        />
        <Select
          aria-label="Referenced column"
          value={refCol}
          options={refCols.map((c) => ({ value: c.name, label: c.name }))}
          onChange={setRefCol}
        />
      </div>
      <label className="st-addform-row">
        ON DELETE
        <Select
          aria-label="ON DELETE action"
          mono={false}
          value={onDelete}
          options={ON_DELETE_ACTIONS.map((a) => ({ value: a, label: a }))}
          onChange={setOnDelete}
        />
      </label>
      <div className="st-addform-actions">
        <Btn variant="text" small onClick={onCancel}>
          Cancel
        </Btn>
        <Btn
          variant="filled"
          small
          icon="add"
          disabled={!canAdd}
          onClick={() => onAdd([col], refTable, [refCol], onDelete)}
        >
          Add FK
        </Btn>
      </div>
    </div>
  );
}
