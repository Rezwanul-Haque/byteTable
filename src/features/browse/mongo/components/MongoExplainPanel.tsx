// MongoDB explain panel (M18 §18.5): real explain("executionStats") for the
// current find OR aggregation pipeline — IXSCAN vs COLLSCAN,
// returned/examined/selectivity, the chosen index, and the COLLSCAN→index tip.
// Ported from the prototype's MongoExplainPanel; calls the backend
// `mongo_explain` / `mongo_explain_aggregate`.

import { useEffect, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { useT } from "../../../../shared/i18n/useT";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { mongoExplain, mongoExplainAggregate, type ExplainResult } from "../api";

/** What to explain: the Find bar's filter/sort, or a compiled pipeline. */
export type MongoExplainQuery =
  | { kind: "find"; filter: unknown; sort: unknown }
  | { kind: "aggregate"; pipeline: unknown[] };

export function MongoExplainPanel({
  handleId,
  db,
  coll,
  query,
  onClose,
}: {
  handleId: string;
  db: string;
  coll: string;
  query: MongoExplainQuery;
  onClose: () => void;
}) {
  const [ex, setEx] = useState<ExplainResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = useT();
  // Re-explain when the query itself changes — callers pass a fresh object
  // literal every render, so the serialized form is the real dependency.
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    let live = true;
    const run =
      query.kind === "aggregate"
        ? mongoExplainAggregate(handleId, db, coll, query.pipeline)
        : mongoExplain(handleId, db, coll, query.filter ?? {}, query.sort ?? undefined);
    run
      .then((r) => {
        if (live) {
          setEx(r);
          setErr(null);
        }
      })
      .catch((e) => live && setErr(appErrorMessage(e, t("mongo.explainFail"))));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, db, coll, queryKey]);

  if (err) {
    return (
      <div className="mg-explain">
        <div className="sql-error-msg">{err}</div>
      </div>
    );
  }
  if (!ex) {
    return (
      <div className="mg-explain">
        <div className="mg-explain-head">
          <Icon name="insights" size={15} style={{ color: "var(--accent)" }} />
          <b>{t("mongo.explainPlan")}</b>
          <span className="mg-ns">{t("mongo.explainRunning")}</span>
        </div>
      </div>
    );
  }
  const winning = ex.stage === "IXSCAN" || !!ex.indexName;
  return (
    <div className="mg-explain">
      <div className="mg-explain-head">
        <Icon name="insights" size={15} style={{ color: "var(--accent)" }} />
        <b>{t("mongo.explainPlan")}</b>
        <span className="mg-ns">
          {ex.namespace}
          {/* An aggregation's stats describe the cursor stage — how the pipeline
              reaches the documents it then transforms. */}
          {query.kind === "aggregate" ? t("mongo.explainAggCursor") : ""}
        </span>
        <div style={{ flex: 1 }} />
        <IconBtn icon="close" size={15} onClick={onClose} title={t("mongo.hideExplain")} />
      </div>
      <div className="mg-explain-grid">
        <div className={"mg-plan-stage " + (winning ? "ix" : "coll")}>
          <Icon name={winning ? "bolt" : "warning"} size={16} />
          <div>
            <div className="mg-plan-stage-name">{ex.stage}</div>
            <div className="mg-plan-stage-sub">
              {winning ? t("mongo.indexUsed", { name: ex.indexName ?? "" }) : t("mongo.noIndex")}
            </div>
          </div>
        </div>
        <div className="mg-explain-stats">
          <div className="mg-estat">
            <span>{t("mongo.statReturned")}</span>
            <b>{ex.nReturned}</b>
          </div>
          <div className="mg-estat">
            <span>{t("mongo.statDocsExamined")}</span>
            <b>{ex.docsExamined}</b>
          </div>
          <div className="mg-estat">
            <span>{t("mongo.statKeysExamined")}</span>
            <b>{ex.keysExamined}</b>
          </div>
          <div className="mg-estat">
            <span>{t("mongo.statSelectivity")}</span>
            <b>{Math.round(ex.ratio * 100)}%</b>
          </div>
          <div className="mg-estat">
            <span>{t("mongo.statTime")}</span>
            <b>{ex.ms} ms</b>
          </div>
        </div>
      </div>
      {!winning ? (
        <div className="mg-explain-tip">
          <Icon name="lightbulb" size={13} />{" "}
          {query.kind === "aggregate" ? t("mongo.tipAgg") : t("mongo.tipFind")}
        </div>
      ) : null}
    </div>
  );
}
