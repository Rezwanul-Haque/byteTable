// The change history's wording and states (M48 §3–4), ported from the
// prototype's `BT_UNDO.statusOf` / `titleOf` and the detail view's verdict.
// Pure — tested in node — and every text goes through `t`, so it translates.

import { fmtDate, fmtNumber, t } from "../../shared/i18n";
import type { CheckView, Entry, Summary } from "./api";

export type Status = "done" | "partial" | "undone" | "cant";

/** done: nothing undone · partial: some rows · undone: every row · cant. */
export function statusOf(e: Pick<Summary, "cant" | "changes" | "undone">): Status {
  if (e.cant) return "cant";
  if (!e.undone) return "done";
  return e.undone >= e.changes ? "undone" : "partial";
}

/** Entries that can still be undone: the status bar's count and ⌥⌘Z's target. */
export const undoable = (e: Summary) => {
  const s = statusOf(e);
  return s === "done" || s === "partial";
};

const rowsText = (n: number) => t("history.rows", { count: n });

/** The list title (D3): "Updated 3 rows in orders", "Changed 4 rows in 2
 *  tables (1 added, 3 updated)", "Structure change (ALTER)". */
export function titleOf(e: Summary): string {
  const where =
    e.tables.length === 1 ? (e.tables[0] ?? "") : t("history.title.tables", { n: e.tables.length });
  if (e.cant === "structure") return t("history.title.structure", { verb: e.verb });
  if (e.cant === "large") {
    const verb = e.verb ? e.verb[0] + e.verb.slice(1).toLowerCase() : t("history.title.change");
    return e.rows != null
      ? t("history.title.large", { verb, rows: rowsText(e.rows), where })
      : t("history.title.largeMore", { verb, n: fmtNumber(e.limit ?? 0), where });
  }
  if (e.cant) {
    return e.tables.length
      ? t("history.title.cantIn", { verb: e.verb, where })
      : t("history.title.cant", { verb: e.verb });
  }
  const kinds = [
    ["added", e.inserted],
    ["updated", e.updated],
    ["deleted", e.deleted],
  ] as const;
  const present = kinds.filter(([, n]) => n > 0);
  if (present.length === 1) {
    const [kind] = present[0]!;
    return t(`history.title.${kind}`, { rows: rowsText(e.changes), where });
  }
  const parts = present
    .map(([kind, n]) => t(`history.title.part.${kind}`, { n: fmtNumber(n) }))
    .join(", ");
  return t("history.title.changed", { rows: rowsText(e.changes), where, parts });
}

const SOURCE_KEY = {
  grid: "history.source.grid",
  statement: "history.source.statement",
  transaction: "history.source.transaction",
  action: "history.source.action",
} as const;

export const sourceLabel = (s: Summary["source"]) => t(SOURCE_KEY[s]);

/** "Today", "Yesterday", else the weekday and date (D2 groups). */
export function dayOf(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  const days = Math.round(
    (new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 0) return t("history.day.today");
  if (days === 1) return t("history.day.yesterday");
  return fmtDate(d, { weekday: "long", day: "numeric", month: "short" });
}

export const timeOf = (at: number) => fmtDate(new Date(at), { hour: "2-digit", minute: "2-digit" });

export type Tone = "ok" | "warn" | "cant" | "info";

/** The verdict banner above the row list (E3, §3 "Verdict banner"). */
export function verdictOf(
  entry: Entry,
  view: CheckView | null,
): { tone: Tone; icon: string; text: string } {
  if (entry.cant === "large") {
    return {
      tone: "cant",
      icon: "block",
      text:
        entry.rows != null
          ? t("history.verdict.large", {
              rows: rowsText(entry.rows),
              limit: fmtNumber(entry.limit ?? 0),
            })
          : t("history.verdict.largeMore", { limit: fmtNumber(entry.limit ?? 0) }),
    };
  }
  if (entry.cant) return { tone: "cant", icon: "block", text: t(`history.verdict.${entry.cant}`) };
  const v = view?.verdicts ?? [];
  const ok = v.filter((x) => x.state === "ok").length;
  const conflicts = v.filter((x) => x.state === "conflict").length;
  const open = v.filter((x) => x.state !== "done").length;
  if (view?.redo) {
    const last = entry.history[entry.history.length - 1];
    return ok
      ? {
          tone: "info",
          icon: "undo",
          text: last
            ? t("history.verdict.undoneAt", {
                day: dayOf(last.at).toLowerCase(),
                time: timeOf(last.at),
              })
            : t("history.verdict.undone"),
        }
      : { tone: "cant", icon: "block", text: t("history.verdict.redoBlocked") };
  }
  if (!ok && !conflicts) {
    return { tone: "info", icon: "remove_done", text: t("history.verdict.nothing") };
  }
  if (!conflicts) {
    return {
      tone: "ok",
      icon: "check_circle",
      text:
        ok === 1 ? t("history.verdict.okOne") : t("history.verdict.okAll", { n: fmtNumber(ok) }),
    };
  }
  if (ok) {
    return {
      tone: "warn",
      icon: "warning",
      text: t("history.verdict.some", {
        ok: fmtNumber(ok),
        open: fmtNumber(open),
        conflicts: t("history.verdict.someChanged", { count: conflicts }),
      }),
    };
  }
  return { tone: "cant", icon: "block", text: t("history.verdict.none") };
}

/** The action button's label (E8): "Undo 3 rows", "Undo 2 of 3 rows". */
export function actionLabel(view: CheckView): string {
  const ok = view.verdicts.filter((v) => v.state === "ok").length;
  const open = view.verdicts.filter((v) => v.state !== "done").length;
  const verb = view.redo ? "history.action.redo" : "history.action.undo";
  return ok && ok < open
    ? t(`${verb}Some`, { ok: fmtNumber(ok), open: fmtNumber(open) })
    : t(verb, { rows: rowsText(ok || open) });
}

/** A value as the row list shows it. */
export function shown(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
