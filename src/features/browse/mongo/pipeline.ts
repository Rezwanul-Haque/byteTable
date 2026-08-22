// MongoDB aggregation-pipeline constants + pure helpers (M18 §18.4), kept out of
// the component file so fast-refresh stays component-only. Shared by the
// collection-tab Aggregate mode, the standalone MongoPipelineTab, and the stage
// rail. Constants mirror the prototype's PIPELINE_STAGES / FIND_LIMITS /
// STAGE_TEMPLATES — the last of which is now placeholder text rather than a
// seeded body.

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

/** Example bodies, shown as the stage textarea's placeholder — grey text that
 *  says what the operator expects and never becomes part of the pipeline. They
 *  used to be seeded as the real body, which meant a stage arrived naming fields
 *  ($status, $total, a `users` collection) the collection at hand may not have. */
export const STAGE_PLACEHOLDERS: Record<string, string> = {
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

/** The example body for a stage op (falls back to an empty object literal). */
export const stagePlaceholder = (op: string): string => STAGE_PLACEHOLDERS[op] ?? "{ }";

/** A fresh rail: one empty `$match`. What the Aggregate mode and a new
 *  aggregation tab open with, and what Clear pipeline resets to — a function so
 *  each caller gets its own array to mutate through `onChange`.
 *
 *  The prototype's three seeded stages ($match status/$group revenue/$sort) went
 *  with it: they name fields only the demo collection has, so every other
 *  collection opened on a pipeline that could not run. */
export const emptyPipeline = (): Stage[] => [{ op: "$match", body: "" }];

/** The rail a tab reopens with. A body that is nothing but an empty object
 *  literal is blanked so the operator's placeholder shows through: it compiles
 *  to the same `{}` either way, and tabs saved before the bodies became
 *  placeholders carry a literal `{ }` that would otherwise hide the hint. */
export function restoreStages(saved: Stage[] | undefined): Stage[] {
  if (!saved?.length) return emptyPipeline();
  return saved.map((s) => (s.body.replace(/\s/g, "") === "{}" ? { ...s, body: "" } : s));
}

/** Compile a stage list to a pipeline array; throws with a message naming the
 *  first stage whose JSON body is invalid. A body left blank compiles to `{}`,
 *  so a fresh `$match` runs and matches everything; the operators that need a
 *  value ($unwind, $limit, …) are rejected by the server, naming themselves. */
export function compilePipeline(stages: Stage[]): unknown[] {
  return stages.map((s, i) => {
    try {
      return { [s.op]: s.body.trim() === "" ? {} : JSON.parse(s.body) };
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
