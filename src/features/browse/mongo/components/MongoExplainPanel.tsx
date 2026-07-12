// MongoDB explain panel (M18 §18.5): real explain("executionStats") for the
// current find — IXSCAN vs COLLSCAN, returned/examined/selectivity, the chosen
// index, and the COLLSCAN→index tip. Ported from the prototype's
// MongoExplainPanel; calls the backend `mongo_explain`.

import { useEffect, useState } from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { mongoExplain, type ExplainResult } from "../api";

export function MongoExplainPanel({
  handleId,
  db,
  coll,
  filter,
  sort,
  onClose,
}: {
  handleId: string;
  db: string;
  coll: string;
  filter: unknown;
  sort: unknown;
  onClose: () => void;
}) {
  const [ex, setEx] = useState<ExplainResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const filterKey = JSON.stringify(filter ?? {});
  const sortKey = JSON.stringify(sort ?? null);

  useEffect(() => {
    let live = true;
    mongoExplain(handleId, db, coll, filter ?? {}, sort ?? undefined)
      .then((r) => {
        if (live) {
          setEx(r);
          setErr(null);
        }
      })
      .catch((e) => live && setErr(appErrorMessage(e, "Could not explain query")));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, db, coll, filterKey, sortKey]);

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
          <b>Explain plan</b>
          <span className="mg-ns">running…</span>
        </div>
      </div>
    );
  }
  const winning = ex.stage === "IXSCAN" || !!ex.indexName;
  return (
    <div className="mg-explain">
      <div className="mg-explain-head">
        <Icon name="insights" size={15} style={{ color: "var(--accent)" }} />
        <b>Explain plan</b>
        <span className="mg-ns">{ex.namespace}</span>
        <div style={{ flex: 1 }} />
        <IconBtn icon="close" size={15} onClick={onClose} title="Hide explain" />
      </div>
      <div className="mg-explain-grid">
        <div className={"mg-plan-stage " + (winning ? "ix" : "coll")}>
          <Icon name={winning ? "bolt" : "warning"} size={16} />
          <div>
            <div className="mg-plan-stage-name">{ex.stage}</div>
            <div className="mg-plan-stage-sub">
              {winning ? "index: " + ex.indexName : "no index used — full collection scan"}
            </div>
          </div>
        </div>
        <div className="mg-explain-stats">
          <div className="mg-estat">
            <span>Returned</span>
            <b>{ex.nReturned}</b>
          </div>
          <div className="mg-estat">
            <span>Docs examined</span>
            <b>{ex.docsExamined}</b>
          </div>
          <div className="mg-estat">
            <span>Keys examined</span>
            <b>{ex.keysExamined}</b>
          </div>
          <div className="mg-estat">
            <span>Selectivity</span>
            <b>{Math.round(ex.ratio * 100)}%</b>
          </div>
          <div className="mg-estat">
            <span>Time</span>
            <b>{ex.ms} ms</b>
          </div>
        </div>
      </div>
      {!winning ? (
        <div className="mg-explain-tip">
          <Icon name="lightbulb" size={13} /> Add an index on the filtered field to turn this
          COLLSCAN into an IXSCAN.
        </div>
      ) : null}
    </div>
  );
}
