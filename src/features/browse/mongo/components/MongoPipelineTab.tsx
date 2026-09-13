// MongoDB standalone aggregation tab (M18 §18.4): opened from the tab bar `+`
// or the database-actions menu; a collection picker + the shared stage rail +
// Tree/Table result. Ported from the prototype's MongoPipelineTab.

import { useEffect, useRef, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import { mongoAggregate, type AggregateResult, type MongoDoc } from "../api";
import { MongoDocGrid, MongoDocTree } from "./MongoValue";
import { MongoDocModal } from "./MongoDocModal";
import { MongoExplainPanel } from "./MongoExplainPanel";
import { MongoStageRail } from "./MongoStageRail";
import {
  compilePipeline,
  copyToClipboard,
  emptyPipeline,
  restoreStages,
  type Stage,
} from "../pipeline";

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
  const t = useT();
  const [coll, setColl] = useState(tab.coll ?? collNames[0] ?? "");
  const [stages, setStages] = useState<Stage[]>(() => restoreStages(tab.stages));
  const [view, setView] = useState<"tree" | "grid">(tab.view ?? "tree");
  const [result, setResult] = useState<AggregateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docView, setDocView] = useState<MongoDoc | null>(null);
  // The pipeline captured when Explain was opened (null = panel hidden), so the
  // stats stay pinned to what was explained while the rail is edited — the same
  // capture-on-open the SQL editor's Explain does with the statement at the caret.
  const [explainPipeline, setExplainPipeline] = useState<unknown[] | null>(null);

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
      setError(appErrorMessage(e, t("mongo.aggFailed")));
      setResult(null);
    }
  };

  // ⌘/Ctrl+↵ runs the pipeline from anywhere in the tab, like the Find bar's
  // and the other engines' run shortcut. Bound once and reading the current
  // runner through a ref; gated on this being the visible tab (every tab stays
  // mounted) and on no document modal owning the keyboard.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef<() => void>(() => {});
  runRef.current = () => void runAggregate();
  const modalOpen = docView !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      if (modalOpen || !(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
      e.preventDefault();
      runRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  const toggleExplain = () => {
    if (explainPipeline) {
      setExplainPipeline(null);
      return;
    }
    try {
      setExplainPipeline(compilePipeline(stages));
    } catch (e) {
      toast(t("mongo.explainFix", { err: e instanceof Error ? e.message : String(e) }), "err");
    }
  };

  /** Back to the rail this tab opened with — one empty $match, no result and no
   *  explain panel pinned to a pipeline that is gone. */
  const clearPipeline = () => {
    setStages(emptyPipeline());
    setResult(null);
    setError(null);
    setExplainPipeline(null);
  };

  const copyPipeline = () => {
    let pipeline: unknown[];
    try {
      pipeline = compilePipeline(stages);
    } catch (e) {
      toast(t("mongo.copyStageFix", { err: e instanceof Error ? e.message : String(e) }), "err");
      return;
    }
    const snippet = "db." + coll + ".aggregate(" + JSON.stringify(pipeline, null, 2) + ")";
    copyToClipboard(
      snippet,
      () => toast(t("mongo.pipelineCopied", { count: stages.length }), "ok"),
      () => toast(t("mongo.copyFail"), "err"),
    );
  };

  const docs = result ? result.docs : [];

  return (
    <div className="table-tab" ref={rootRef}>
      <div className="table-toolbar ddb-toolbar">
        <span className="mg-pipe-title">
          <Icon name="account_tree" size={15} style={{ color: "var(--accent)" }} />{" "}
          {t("mongo.aggTitle")}
        </span>
        <span className="mg-pipe-coll">
          <span>db.</span>
          <Select
            className="mg-pipe-coll-sel"
            value={coll}
            options={collNames.map((c) => ({ value: c, label: c }))}
            onChange={(c) => {
              setColl(c);
              setResult(null);
              setError(null);
            }}
            aria-label={t("mongo.aggCollAria")}
          />
          <span>.aggregate()</span>
        </span>
        <div className="seg mg-view-seg" title={t("mongo.viewSegTitle")}>
          <button
            className={"seg-btn" + (view === "tree" ? " active" : "")}
            onClick={() => setView("tree")}
          >
            <Icon name="account_tree" size={13} /> {t("mongo.viewTree")}
          </button>
          <button
            className={"seg-btn" + (view === "grid" ? " active" : "")}
            onClick={() => setView("grid")}
          >
            <Icon name="grid_on" size={13} /> {t("mongo.viewTable")}
          </button>
        </div>
        <div style={{ flex: 1 }} />
        {result ? (
          <span className="table-rowcount">
            {t("mongo.readoutAgg", { returned: result.returned, ms: result.ms.toFixed(1) })}
          </span>
        ) : null}
        <Btn
          icon="bolt"
          variant="text"
          small
          onClick={toggleExplain}
          className={explainPipeline ? "active" : undefined}
        >
          {t("mongo.explain")}
        </Btn>
      </div>

      <MongoStageRail
        stages={stages}
        onChange={setStages}
        onRun={() => void runAggregate()}
        onCopy={copyPipeline}
        onClear={clearPipeline}
      />

      {explainPipeline ? (
        <MongoExplainPanel
          handleId={handleId}
          db={db}
          coll={coll}
          query={{ kind: "aggregate", pipeline: explainPipeline }}
          onClose={() => setExplainPipeline(null)}
        />
      ) : null}

      {error ? (
        <div className="sql-results">
          <div className="sql-error">
            <Icon name="error" size={18} />
            <div>
              <div className="sql-error-title">{t("mongo.errTitleAgg")}</div>
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
          <div className="table-hint">{t("mongo.aggResultNs", { ns: db + "." + coll })}</div>
        </>
      ) : (
        <div className="grid-empty mg-pipe-empty">
          <Icon name="account_tree" size={26} style={{ color: "var(--text-faint)" }} />
          <div>
            {t("mongo.pipeEmptyPre")}
            <b>{t("mongo.runPipeline")}</b>
            {t("mongo.pipeEmptyPost")}
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
