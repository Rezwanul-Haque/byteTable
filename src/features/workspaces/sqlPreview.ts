// SQL preview strings for the compact places that quote a query back at the
// user: the drawer rows (saved queries / history) and the failed-statement card
// in the SQL tab. Full multi-line, syntax-highlighted, but bounded — a 4000-line
// buffer must not blow up a 76px-tall list row.

import { highlightSql } from "../browse/shared/highlightSql";

/** Cap on the SQL shown in a preview (full multi-line, but bounded). */
const PREVIEW_MAX = 240;

/** Truncate (with ellipsis) then syntax-highlight SQL for a preview. */
export function previewHtml(sql: string): string {
  const clipped = sql.length > PREVIEW_MAX ? sql.slice(0, PREVIEW_MAX) + "…" : sql;
  return highlightSql(clipped);
}
