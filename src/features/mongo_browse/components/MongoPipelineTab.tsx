// MongoDB standalone aggregation tab (M18 §18.4): opened from the tab bar `+`
// or the database-actions menu; a collection picker + the shared stage rail +
// Tree/Table result. Ported from the prototype's MongoPipelineTab.

import { useEffect, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import { mongoAggregate, type AggregateResult, type MongoDoc } from "../api";
import { MongoDocGrid, MongoDocTree } from "./MongoValue";
import { MongoDocModal } from "./MongoDocModal";
import { MongoStageRail } from "./MongoStageRail";
import { compilePipeline, copyToClipboard, type Stage } from "../pipeline";

export interface MongoPipelineTabState {
  id: string;
  kind: "pipeline";
  title: string;
  coll?: string;
  stages?: Stage[];
  view?: "tree" | "grid";
}

export function MongoPipelineTab({
  tab,
  db,
  handleId,
  collNames,
  isProduction,
  onUpdateTab,
}: {
  tab: MongoPipelineTabState;
  db: string;
  handleId: string;
  collNames: string[];
  isProduction: boolean;
  onUpdateTab: (patch: Partial<MongoPipelineTabState>) => void;
}) {
  const toast = useToast();
  const [coll, setColl] = useState(tab.coll ?? collNames[0] ?? "");
  const [stages, setStages] = useState<Stage[]>(tab.stages ?? [{ op: "$match", body: "{ }" }]);
  const [view, setView] = useState<"tree" | "grid">(tab.view ?? "tree");
  const [result, setResult] = useState<AggregateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docView, setDocView] = useState<MongoDoc | null>(null);

  useEffect(() => {
    onUpdateTab({ coll, stages, view, title: "Aggregation · " + coll });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coll, stages, view]);

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
      setResult(r);
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

  const docs = result ? result.docs : [];

  return (
    <div className="table-tab">
      <div className="table-toolbar ddb-toolbar">
        <span className="mg-pipe-title">
          <Icon name="account_tree" size={15} style={{ color: "var(--accent)" }} /> Aggregation
        </span>
        <label className="mg-pipe-coll">
          <span>db.</span>
          <select
            value={coll}
            onChange={(e) => {
              setColl(e.target.value);
              setResult(null);
              setError(null);
            }}
          >
            {collNames.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <span>.aggregate()</span>
        </label>
        <div className="seg mg-view-seg" title="Document view">
          <button
            className={"seg-btn" + (view === "tree" ? " active" : "")}
            onClick={() => setView("tree")}
          >
            <Icon name="account_tree" size={13} /> Tree
          </button>
          <button
            className={"seg-btn" + (view === "grid" ? " active" : "")}
            onClick={() => setView("grid")}
          >
            <Icon name="grid_on" size={13} /> Table
          </button>
        </div>
        <div style={{ flex: 1 }} />
        {result ? (
          <span className="table-rowcount">
            {result.returned} docs · {result.ms.toFixed(1)} ms
          </span>
        ) : null}
      </div>

      <MongoStageRail
        stages={stages}
        onChange={setStages}
        onRun={() => void runAggregate()}
        onCopy={copyPipeline}
      />

      {error ? (
        <div className="sql-results">
          <div className="sql-error">
            <Icon name="error" size={18} />
            <div>
              <div className="sql-error-title">Aggregation error</div>
              <div className="sql-error-msg">{error}</div>
            </div>
          </div>
        </div>
      ) : result ? (
        <>
          {view === "tree" ? (
            <MongoDocTree docs={docs} onOpenDoc={setDocView} />
          ) : (
            <MongoDocGrid docs={docs} onOpenDoc={setDocView} />
          )}
          <div className="table-hint">
            Aggregation result · {db}.{coll}
          </div>
        </>
      ) : (
        <div className="grid-empty mg-pipe-empty">
          <Icon name="account_tree" size={26} style={{ color: "var(--text-faint)" }} />
          <div>
            Build a pipeline and press <b>Run pipeline</b> to see results.
          </div>
        </div>
      )}

      {docView ? (
        <MongoDocModal
          doc={docView}
          db={db}
          coll={coll}
          handleId={handleId}
          isProduction={isProduction}
          onClose={() => setDocView(null)}
          onSaved={() => setDocView(null)}
        />
      ) : null}
    </div>
  );
}
