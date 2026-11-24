// "When did this result run?" for the result bar (M47 G1): "just now" under a
// minute, "N min ago" under an hour, else the date and time in the app locale.

import { fmtDate, type t as T } from "../../shared/i18n";

export function ranWhen(t: typeof T, iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff >= 0 && diff < 60_000) return t("notebook.when.now");
  if (diff >= 0 && diff < 3_600_000)
    return t("notebook.when.min", { n: Math.round(diff / 60_000) });
  return fmtDate(d, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
