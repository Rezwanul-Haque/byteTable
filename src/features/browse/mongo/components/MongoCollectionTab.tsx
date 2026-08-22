// MongoDB collection tab (M18 §18.2/§18.4/§18.5): Find / Aggregate / Structure
// segmented modes, the Find bar (Filter / Projection / Sort / Limit), the
// Tree ⇄ Table view toggle, the Explain panel, and Insert. Ported from the
// prototype's MongoCollectionTab; every query runs against the backend.

import { useCallback, useEffect, useRef, useState } from "react";

import { save } from "@tauri-apps/plugin-dialog";

import { exportSave } from "../../../../shared/api/engine";
import { appErrorMessage } from "../../../../shared/api/error";
import { BulkDeleteModal } from "../../../../shared/ui/BulkDeleteModal";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import {
  mongoAggregate,
  mongoDeleteMany,
  mongoDeleteOne,
  mongoFind,
  type CollectionDescriptor,
  type MongoDoc,
} from "../api";
import { freshOid } from "../helpers";
import { MongoDocGrid, MongoDocTree } from "./MongoValue";
import { MongoDocModal } from "./MongoDocModal";
import { MongoExplainPanel } from "./MongoExplainPanel";
import { MongoStructure } from "./MongoStructure";
import { MongoStageRail } from "./MongoStageRail";
import {
  compilePipeline,
  copyToClipboard,
  emptyPipeline,
  FIND_LIMITS,
  restoreStages,
  type Stage,
} from "../pipeline";

export interface MongoTab {
  id: string;
  kind: "collection";
  coll: string;
  title: string;
  mode?: "find" | "aggregate" | "structure";
  view?: "tree" | "grid";
  filter?: string;
  proj?: string;
  sort?: string;
  limit?: number;
  stages?: Stage[];
}

interface FindState {
  kind: "find" | "agg";
  docs: MongoDoc[];
  matched?: number;
  returned: number;
  ms: number;
  usedIndex?: string;
  filterObj?: unknown;
  sortObj?: unknown;
  /** The compiled pipeline of an `agg` run — what Explain explains. */
  pipelineObj?: unknown[];
}

export function MongoCollectionTab({
  tab,
  db,
  handleId,
  descriptor,
  isProduction,
  version,
  onUpdateTab,
  onExport,
  onImport,
  onTruncate,
  onDrop,
  onDataChanged,
}: {
  tab: MongoTab;
  db: string;
  handleId: string;
  descriptor?: CollectionDescriptor;
  isProduction: boolean;
  version: number;
  onUpdateTab: (patch: Partial<MongoTab>) => void;
  onExport: (coll: string) => void;
  onImport: (coll: string) => void;
  /** Remove every document, keeping the collection (confirmed by the host). */
  onTruncate: (coll: string) => void;
  /** Drop the collection outright (confirmed by the host). */
  onDrop: (coll: string) => void;
  onDataChanged: () => void;
}) {
  const toast = useToast();
  const coll = tab.coll;
  const mode = tab.mode ?? "find";
  const view = tab.view ?? "tree";

  const [filter, setFilter] = useState(tab.filter ?? "{ }");
  const [proj, setProj] = useState(tab.proj ?? "");
  const [sort, setSort] = useState(tab.sort ?? "");
  const [limit, setLimit] = useState(tab.limit ?? 50);
  // A fresh Aggregate mode opens on one empty $match: the seeded three-stage
  // pipeline named fields ($status, $total) that most collections do not have.
  const [stages, setStages] = useState<Stage[]>(() => restoreStages(tab.stages));
  const [result, setResult] = useState<FindState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docView, setDocView] = useState<MongoDoc | null>(null);
  const [newDoc, setNewDoc] = useState(false);
  const [showExplain, setShowExplain] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Grid multi-select (by row index into the current result); cleared on re-run.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** The single document the row's trash icon is asking to delete. */
  const [delDoc, setDelDoc] = useState<MongoDoc | null>(null);
  const persisted = useRef({ filter, proj, sort, limit, stages, view, mode });

  const runFind = useCallback(async () => {
    let f: unknown;
    let projObj: unknown;
    let sortObj: unknown;
    try {
      f = JSON.parse(filter || "{}");
      if (proj.trim()) projObj = JSON.parse(proj);
      if (sort.trim()) sortObj = JSON.parse(sort);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
      return;
    }
    try {
      const r = await mongoFind(handleId, db, coll, {
        filter: f,
        projection: projObj,
        sort: sortObj,
        limit: Number(limit) === 0 ? null : Number(limit),
      });
      setResult({ kind: "find", ...r, filterObj: f, sortObj });
      setError(null);
    } catch (e) {
      setError(appErrorMessage(e, "Query failed"));
      setResult(null);
    }
  }, [filter, proj, sort, limit, db, coll, handleId]);

  // Re-run find on collection/db/version change (mirrors the prototype).
  useEffect(() => {
    if (mode === "find") void runFind();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, coll, version]);

  // Persist editable tab state up to the workspace (debounced via effect).
  useEffect(() => {
    persisted.current = { filter, proj, sort, limit, stages, view, mode };
    onUpdateTab({ filter, proj, sort, limit, stages, view, mode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, proj, sort, limit, stages, view, mode]);

  const runAggregate = async () => {
    let pipeline: unknown[];
    try {
      pipeline = compilePipeline(stages);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
      return;
    }
    try {
      const r = await mongoAggregate(handleId, db, coll, pipeline);
      setResult({ kind: "agg", pipelineObj: pipeline, ...r });
      setError(null);
    } catch (e) {
      setError(appErrorMessage(e, "Aggregation failed"));
      setResult(null);
    }
  };

  /** Back to a fresh rail: one empty $match, no result, no explain panel — so a
   *  finished aggregation can be dropped without retyping every stage away. */
  const clearPipeline = () => {
    setStages(emptyPipeline());
    setResult(null);
    setError(null);
    setSelected(new Set());
    setShowExplain(false);
  };

  const copyPipeline = () => {
    let pipeline: unknown[];
    try {
      pipeline = compilePipeline(stages);
    } catch (e) {
      toast("Fix stage JSON before copying — " + (e instanceof Error ? e.message : ""), "err");
      return;
    }
    const snippet = "db." + coll + ".aggregate(" + JSON.stringify(pipeline, null, 2) + ")";
    copyToClipboard(
      snippet,
      () =>
        toast(
          "Pipeline copied · " + stages.length + " stage" + (stages.length === 1 ? "" : "s"),
          "ok",
        ),
      () => toast("Copy failed — select the text manually", "err"),
    );
  };

  // The confirm modal owns the production guard and reports failures inline, so
  // this only does the delete and lets it throw. The `window.confirm` that stood
  // here does not block in the app's webview — the row went without a prompt.
  const deleteDoc = async (d: MongoDoc) => {
    await mongoDeleteOne(handleId, db, coll, d._id);
    toast("Document deleted · " + db + "." + coll, "ok");
  };

  const docs = result ? result.docs : [];

  // Reset selection whenever a fresh result lands.
  useEffect(() => {
    setSelected(new Set());
  }, [result]);

  // ⌘/Ctrl+↵ runs whatever the current mode reads with — the find or the
  // pipeline. Read through a ref so the key listener is bound once instead of
  // being re-bound on every keystroke in the Find bar.
  const runRef = useRef<() => void>(() => {});
  runRef.current = () => void (mode === "aggregate" ? runAggregate() : runFind());

  // ⌘I / Ctrl+I opens the new-document editor — the binding the SQL, Cassandra
  // and DynamoDB grids use for "add row". Every tab stays mounted, so the
  // listener is gated on this one being the visible tab; a modal that is already
  // up owns the keyboard.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const modalOpen = newDoc || docView !== null || deleteOpen || delDoc !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      if (modalOpen || mode === "structure") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        runRef.current();
      } else if (e.key.toLowerCase() === "i") {
        e.preventDefault();
        setNewDoc(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen, mode]);

  const toggleRow = (i: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const toggleAll = () =>
    setSelected((s) => (s.size === docs.length ? new Set() : new Set(docs.map((_, i) => i))));
  const selectedDocs = (): MongoDoc[] =>
    [...selected].map((i) => docs[i]).filter((d): d is MongoDoc => Boolean(d));

  const deleteSelected = async () => {
    const ids = selectedDocs().map((d) => d._id);
    const res = await mongoDeleteMany(handleId, db, coll, ids);
    toast(`Deleted ${res.deleted} document${res.deleted === 1 ? "" : "s"} · ${db}.${coll}`, "ok");
    void runFind();
    onDataChanged();
  };

  // Export only the checked documents to CSV (field-union columns, _id first;
  // objects/arrays serialized as JSON).
  const exportSelectedCsv = async () => {
    const rows = selectedDocs();
    if (!rows.length) return;
    const colset = new Set<string>(["_id"]);
    for (const d of rows) for (const k of Object.keys(d)) colset.add(k);
    const cols = [...colset];
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [cols.join(",")]
      .concat(rows.map((d) => cols.map((c) => esc((d as MongoDoc)[c])).join(",")))
      .join("\n");
    try {
      const path = await save({
        defaultPath: `${coll}-selection.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await exportSave(path, csv);
      toast(`Exported ${rows.length} document${rows.length === 1 ? "" : "s"} to CSV`, "ok");
    } catch (e) {
      toast(appErrorMessage(e, "Could not export CSV"), "err");
    }
  };
  const limitOptions = FIND_LIMITS.includes(Number(limit) as never)
    ? [...FIND_LIMITS]
    : ([Number(limit), ...FIND_LIMITS].filter((n) => n > 0).sort((a, b) => a - b) as number[]);

  return (
    <div className="table-tab" ref={rootRef}>
      <div className="table-toolbar ddb-toolbar">
        <div className="seg">
          <button
            className={"seg-btn" + (mode === "find" ? " active" : "")}
            onClick={() => onUpdateTab({ mode: "find" })}
          >
            <Icon name="search" size={14} /> Find
          </button>
          <button
            className={"seg-btn" + (mode === "aggregate" ? " active" : "")}
            onClick={() => onUpdateTab({ mode: "aggregate" })}
          >
            <Icon name="account_tree" size={14} /> Aggregate
          </button>
          <button
            className={"seg-btn" + (mode === "structure" ? " active" : "")}
            onClick={() => onUpdateTab({ mode: "structure" })}
          >
            <Icon name="schema" size={14} /> Structure
          </button>
        </div>
        {mode !== "structure" ? (
          <div className="seg mg-view-seg" title="Document view">
            <button
              className={"seg-btn" + (view === "tree" ? " active" : "")}
              onClick={() => onUpdateTab({ view: "tree" })}
            >
              <Icon name="account_tree" size={13} /> Tree
            </button>
            <button
              className={"seg-btn" + (view === "grid" ? " active" : "")}
              onClick={() => onUpdateTab({ view: "grid" })}
            >
              <Icon name="grid_on" size={13} /> Table
            </button>
          </div>
        ) : null}
        <div style={{ flex: 1 }} />
        {result && mode === "find" ? (
          <span className="table-rowcount">
            {result.returned} of {result.matched} · {result.ms.toFixed(1)} ms
            {result.usedIndex ? " · " + result.usedIndex : " · COLLSCAN"}
          </span>
        ) : null}
        {result && mode === "aggregate" ? (
          <span className="table-rowcount">
            {result.returned} docs · {result.ms.toFixed(1)} ms
          </span>
        ) : null}
        {mode !== "structure" ? (
          <Btn
            icon="bolt"
            variant="text"
            small
            onClick={() => setShowExplain((s) => !s)}
            className={showExplain ? "active" : undefined}
          >
            Explain
          </Btn>
        ) : null}
        {mode !== "structure" ? (
          <IconBtn
            icon="add_box"
            title="Insert document (⌘I / Ctrl+I)"
            onClick={() => setNewDoc(true)}
          />
        ) : null}
        <div className="table-actions" style={{ position: "relative" }}>
          <IconBtn
            icon="more_vert"
            title="Collection actions"
            active={actionsOpen}
            onClick={() => setActionsOpen((o) => !o)}
          />
          {actionsOpen ? (
            <div className="ctx-menu table-actions-menu">
              <div
                className="ctx-item"
                onClick={() => {
                  setActionsOpen(false);
                  onExport(coll);
                }}
              >
                <Icon name="download" size={15} /> Export collection
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setActionsOpen(false);
                  onImport(coll);
                }}
              >
                <Icon name="upload" size={15} /> Import documents
              </div>
              {/* Destructive last, behind a separator — same order as the
                  sidebar's collection menu and the SQL table menu. */}
              <div className="ctx-sep" />
              <div
                className="ctx-item danger"
                onClick={() => {
                  setActionsOpen(false);
                  onTruncate(coll);
                }}
              >
                <Icon name="delete_sweep" size={15} /> Empty collection
              </div>
              <div
                className="ctx-item danger"
                onClick={() => {
                  setActionsOpen(false);
                  onDrop(coll);
                }}
              >
                <Icon name="delete_forever" size={15} /> Drop collection
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {mode === "find" ? (
        <div className="mg-find-bar">
          <label className="mg-find-field mg-find-filter">
            <span className="mg-find-label">
              <Icon name="filter_alt" size={12} /> Filter
            </span>
            <input
              className="where-input mg-mono"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runFind();
              }}
              placeholder="{ field: value }"
              spellCheck={false}
            />
          </label>
          <label className="mg-find-field">
            <span className="mg-find-label">Projection</span>
            <input
              className="where-input mg-mono"
              value={proj}
              onChange={(e) => setProj(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runFind();
              }}
              placeholder="{ name: 1 }"
              spellCheck={false}
            />
          </label>
          <label className="mg-find-field">
            <span className="mg-find-label">Sort</span>
            <input
              className="where-input mg-mono"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runFind();
              }}
              placeholder="{ createdAt: -1 }"
              spellCheck={false}
            />
          </label>
          <div className="mg-find-field mg-find-limit">
            <span className="mg-find-label">Limit</span>
            <Select
              className="mg-limit-sel"
              value={String(Number(limit) || 0)}
              options={[
                ...limitOptions.map((n) => ({ value: String(n), label: String(n) })),
                { value: "0", label: "All" },
              ]}
              onChange={(v) => setLimit(Number(v))}
              aria-label="Limit"
            />
          </div>
          <Btn
            icon="play_arrow"
            variant="filled"
            small
            title="Run this find (⌘↵ / Ctrl+↵)"
            onClick={() => void runFind()}
          >
            Find
          </Btn>
        </div>
      ) : null}

      {mode === "aggregate" ? (
        <MongoStageRail
          stages={stages}
          onChange={setStages}
          onRun={() => void runAggregate()}
          onCopy={copyPipeline}
          onClear={clearPipeline}
        />
      ) : null}

      {/* Explain describes the last run, so it needs a result: the find's
          filter/sort, or the pipeline the Aggregate mode actually ran. */}
      {showExplain && result ? (
        <MongoExplainPanel
          handleId={handleId}
          db={db}
          coll={coll}
          query={
            result.kind === "agg"
              ? { kind: "aggregate", pipeline: result.pipelineObj ?? [] }
              : { kind: "find", filter: result.filterObj, sort: result.sortObj }
          }
          onClose={() => setShowExplain(false)}
        />
      ) : null}

      {error ? (
        <div className="sql-results">
          <div className="sql-error">
            <Icon name="error" size={18} />
            <div>
              <div className="sql-error-title">
                {mode === "aggregate" ? "Aggregation error" : "Query error"}
              </div>
              <div className="sql-error-msg">{error}</div>
            </div>
          </div>
        </div>
      ) : mode === "structure" ? (
        <MongoStructure
          handleId={handleId}
          db={db}
          coll={coll}
          validator={descriptor?.validator}
          onChanged={onDataChanged}
        />
      ) : (
        <>
          {view === "grid" && selected.size > 0 ? (
            <div className="ddb-selbar">
              <span className="ddb-selbar-count">{selected.size} selected</span>
              <div style={{ flex: 1 }} />
              <Btn icon="download" variant="tonal" small onClick={() => void exportSelectedCsv()}>
                Export CSV
              </Btn>
              <Btn
                icon="delete"
                variant="tonal"
                small
                className="ddb-selbar-del"
                onClick={() => setDeleteOpen(true)}
              >
                Delete selected
              </Btn>
            </div>
          ) : null}
          {view === "tree" ? (
            <MongoDocTree
              docs={docs}
              onOpenDoc={setDocView}
              onDeleteDoc={mode === "find" ? (d) => setDelDoc(d) : undefined}
            />
          ) : (
            <MongoDocGrid
              docs={docs}
              onOpenDoc={setDocView}
              selected={selected}
              onToggleRow={toggleRow}
              onToggleAll={toggleAll}
            />
          )}
          <div className="table-hint">
            {mode === "aggregate"
              ? "Aggregation result"
              : view === "tree"
                ? "Tree view · click ✎ to edit a document"
                : "Table view · click a row to edit"}{" "}
            · ⌘I insert · {db}.{coll}
          </div>
        </>
      )}

      {docView ? (
        <MongoDocModal
          doc={docView}
          db={db}
          coll={coll}
          handleId={handleId}
          validator={descriptor?.validator}
          isProduction={isProduction}
          onClose={() => setDocView(null)}
          onSaved={() => {
            setDocView(null);
            void runFind();
            onDataChanged();
          }}
        />
      ) : null}
      {newDoc ? (
        <MongoDocModal
          doc={{ _id: { $oid: freshOid() } }}
          db={db}
          coll={coll}
          handleId={handleId}
          validator={descriptor?.validator}
          isProduction={isProduction}
          isNew
          onClose={() => setNewDoc(false)}
          onSaved={() => {
            setNewDoc(false);
            void runFind();
            onDataChanged();
          }}
        />
      ) : null}
      {delDoc ? (
        <BulkDeleteModal
          count={1}
          target={coll}
          noun="document"
          isProduction={isProduction}
          onConfirm={() => deleteDoc(delDoc)}
          onClose={() => setDelDoc(null)}
          onDone={() => {
            void runFind();
            onDataChanged();
          }}
        />
      ) : null}
      {deleteOpen && selected.size > 0 ? (
        <BulkDeleteModal
          count={selected.size}
          target={coll}
          noun="document"
          isProduction={isProduction}
          onConfirm={deleteSelected}
          onClose={() => setDeleteOpen(false)}
          onDone={() => setSelected(new Set())}
        />
      ) : null}
    </div>
  );
}
