// MongoDB aggregation-pipeline constants + pure helpers (M18 §18.4), kept out of
// the component file so fast-refresh stays component-only. Shared by the
// collection-tab Aggregate mode, the standalone MongoPipelineTab, and the stage
// rail. Constants mirror the prototype's PIPELINE_STAGES / FIND_LIMITS /
// STAGE_TEMPLATES.

export interface Stage {
  op: string;
  body: string;
}

export const PIPELINE_STAGES = [
  "$match",
  "$group",
  "$sort",
  "$project",
  "$unwind",
  "$limit",
  "$skip",
  "$lookup",
  "$count",
] as const;

export const FIND_LIMITS = [10, 25, 50, 100, 200, 500] as const;

export const STAGE_TEMPLATES: Record<string, string> = {
  $match: '{ "status": "paid" }',
  $group: '{ "_id": "$status", "count": { "$sum": 1 }, "revenue": { "$sum": "$total" } }',
  $sort: '{ "count": -1 }',
  $project: '{ "status": 1, "total": 1 }',
  $unwind: '"$items"',
  $limit: "10",
  $skip: "0",
  $lookup: '{ "from": "users", "localField": "userId", "foreignField": "_id", "as": "user" }',
  $count: '"docCount"',
};

/** The seed body for a stage op (falls back to an empty object literal). */
export const stageTemplate = (op: string): string => STAGE_TEMPLATES[op] ?? "{ }";

export const DEFAULT_STAGES: Stage[] = [
  { op: "$match", body: '{ "status": "paid" }' },
  { op: "$group", body: stageTemplate("$group") },
  { op: "$sort", body: '{ "revenue": -1 }' },
];

/** Compile a stage list to a pipeline array; throws with a message naming the
 *  first stage whose JSON body is invalid. */
export function compilePipeline(stages: Stage[]): unknown[] {
  return stages.map((s, i) => {
    try {
      return { [s.op]: JSON.parse(s.body) };
    } catch (e) {
      throw new Error(
        "Stage " + (i + 1) + " (" + s.op + "): " + (e instanceof Error ? e.message : String(e)),
      );
    }
  });
}

/** Copy text to the clipboard, falling back to execCommand for sandboxed
 *  contexts (don't report failure when navigator.clipboard merely rejects). */
export function copyToClipboard(text: string, onOk: () => void, onFail: () => void) {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    if (ok) onOk();
    else onFail();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(onOk, fallback);
  } else {
    fallback();
  }
}
