// MongoDB aggregation stage rail (M18 §18.4): add/remove/reorder stages, each
// an op <select> + a JSON body seeded from STAGE_TEMPLATES, bodies auto-sized to
// a shared height. Plus Run / Copy pipeline. Shared by the collection-tab
// Aggregate mode and the standalone MongoPipelineTab. Ported from the prototype.

import { useEffect, useRef } from "react";

import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { PIPELINE_STAGES, stageTemplate, type Stage } from "../pipeline";

export function MongoStageRail({
  stages,
  onChange,
  onRun,
  onCopy,
}: {
  stages: Stage[];
  onChange: (stages: Stage[]) => void;
  onRun: () => void;
  onCopy: () => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);

  // Keep every pipeline stage editor the same height (tallest content, capped).
  useEffect(() => {
    if (!railRef.current) return;
    const tas = railRef.current.querySelectorAll<HTMLTextAreaElement>(".mg-stage-body");
    let max = 44;
    tas.forEach((t) => {
      t.style.height = "auto";
      max = Math.max(max, t.scrollHeight);
    });
    max = Math.min(180, max);
    tas.forEach((t) => {
      t.style.height = max + "px";
    });
  }, [stages]);

  const setStage = (i: number, patch: Partial<Stage>) =>
    onChange(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addStage = () => onChange([...stages, { op: "$match", body: stageTemplate("$match") }]);
  const removeStage = (i: number) => onChange(stages.filter((_, j) => j !== i));
  const moveStage = (i: number, dir: number) => {
    const n = stages.slice();
    const j = i + dir;
    const a = n[i];
    const b = n[j];
    if (j < 0 || j >= n.length || !a || !b) return;
    n[i] = b;
    n[j] = a;
    onChange(n);
  };

  return (
    <div className="mg-pipeline">
      <div className="mg-pipeline-rail" ref={railRef}>
        {stages.map((s, i) => (
          <div key={i} className="mg-stage">
            <div className="mg-stage-head">
              <span className="mg-stage-num">{i + 1}</span>
              <select
                className="mg-stage-op"
                value={s.op}
                onChange={(e) =>
                  setStage(i, { op: e.target.value, body: stageTemplate(e.target.value) })
                }
              >
                {PIPELINE_STAGES.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <div style={{ flex: 1 }} />
              <button
                className="mg-stage-btn"
                onClick={() => moveStage(i, -1)}
                disabled={i === 0}
                title="Move up"
              >
                <Icon name="arrow_upward" size={13} />
              </button>
              <button
                className="mg-stage-btn"
                onClick={() => moveStage(i, 1)}
                disabled={i === stages.length - 1}
                title="Move down"
              >
                <Icon name="arrow_downward" size={13} />
              </button>
              <button
                className="mg-stage-btn mg-stage-del"
                onClick={() => removeStage(i)}
                title="Remove stage"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
            <textarea
              className="mg-stage-body mg-mono"
              value={s.body}
              onChange={(e) => setStage(i, { body: e.target.value })}
              spellCheck={false}
            />
          </div>
        ))}
        <button className="mg-add-stage" onClick={addStage}>
          <Icon name="add" size={15} /> Add stage
        </button>
      </div>
      <div className="mg-pipeline-run">
        <Btn icon="play_arrow" variant="filled" small onClick={onRun}>
          Run pipeline
        </Btn>
        <Btn icon="content_copy" variant="tonal" small onClick={onCopy}>
          Copy pipeline
        </Btn>
        <span className="sql-hint">
          {stages.length} stage{stages.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
