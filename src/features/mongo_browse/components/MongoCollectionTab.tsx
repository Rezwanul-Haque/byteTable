// MongoDB collection tab (M18 §18.2/§18.4/§18.5): Find / Aggregate / Structure
// segmented modes, the Find bar (Filter / Projection / Sort / Limit), the
// Tree ⇄ Table view toggle, the Explain panel, and Insert. Ported from the
// prototype's MongoCollectionTab; every query runs against the backend.

import { useCallback, useEffect, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import {
  mongoAggregate,
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
  DEFAULT_STAGES,
  FIND_LIMITS,
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
  const [stages, setStages] = useState<Stage[]>(tab.stages ?? DEFAULT_STAGES);
  const [result, setResult] = useState<FindState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docView, setDocView] = useState<MongoDoc | null>(null);
  const [newDoc, setNewDoc] = useState(false);
  const [showExplain, setShowExplain] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
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
      setResult({ kind: "agg", ...r });
      setError(null);
    } catch (e) {
      setError(appErrorMessage(e, "Aggregation failed"));
      setResult(null);
    }
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

  const deleteDoc = async (d: MongoDoc) => {
    if (isProduction && !window.confirm("Delete this document from production " + coll + "?"))
      return;
    try {
      await mongoDeleteOne(handleId, db, coll, d._id);
      toast("Document deleted · " + db + "." + coll, "ok");
      void runFind();
      onDataChanged();
    } catch (e) {
      toast(appErrorMessage(e, "Could not delete document"), "err");
    }
  };

  const docs = result ? result.docs : [];
  const limitOptions = FIND_LIMITS.includes(Number(limit) as never)
    ? [...FIND_LIMITS]
    : ([Number(limit), ...FIND_LIMITS].filter((n) => n > 0).sort((a, b) => a - b) as number[]);

  return (
    <div className="table-tab">
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
        {mode === "find" ? (
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
          <Btn icon="add" variant="tonal" small onClick={() => setNewDoc(true)}>
            Insert
          </Btn>
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
                <Icon name="download" size={15} /> Export collection…
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setActionsOpen(false);
                  onImport(coll);
                }}
              >
                <Icon name="upload" size={15} /> Import documents…
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
          <label className="mg-find-field mg-find-limit">
            <span className="mg-find-label">Limit</span>
            <select
              className="filter-select"
              value={Number(limit) || 0}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {limitOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value={0}>All</option>
            </select>
          </label>
          <Btn icon="play_arrow" variant="filled" small onClick={() => void runFind()}>
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
        />
      ) : null}

      {showExplain && mode === "find" && result ? (
        <MongoExplainPanel
          handleId={handleId}
          db={db}
          coll={coll}
          filter={result.filterObj}
          sort={result.sortObj}
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
          {view === "tree" ? (
            <MongoDocTree
              docs={docs}
              onOpenDoc={setDocView}
              onDeleteDoc={mode === "find" ? (d) => void deleteDoc(d) : undefined}
            />
          ) : (
            <MongoDocGrid docs={docs} onOpenDoc={setDocView} />
          )}
          <div className="table-hint">
            {mode === "aggregate"
              ? "Aggregation result"
              : view === "tree"
                ? "Tree view · click ✎ to edit a document"
                : "Table view · click a row to edit"}{" "}
            · {db}.{coll}
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
    </div>
  );
}
