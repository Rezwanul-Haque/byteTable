// Tab strip labels — the one place a tab's display name is derived.
//
// Lives outside `TabBar.tsx` because the close confirm needs the same strings
// (it has to name the exact tab it is about to discard, ordinal included) and a
// component module may only export components (react-refresh rule).

import { t } from "../../shared/i18n";
import type { Tab } from "./types";

// Labels are built by module-level functions (the close confirm needs them
// outside React), so they read `t` directly at call time; components calling
// these re-render on locale change through `useT()`.

/** One tab's strip label + hover text. */
export interface TabLabel {
  title: string;
  tooltip: string;
}

/** The visible label: just the table/object name while its schema is the one the
 *  workspace is on (the caller passes `currentSchema` — what the sidebar's schema
 *  switcher shows), `schema.name` for anything from another schema, the SQL
 *  "Query N" title, "schema · map", or a fixed name. */
function tabTitle(tab: Tab, currentSchema: string): string {
  switch (tab.kind) {
    case "table":
      return tab.schema === currentSchema ? tab.table : tab.schema + "." + tab.table;
    case "sql":
      return tab.title;
    case "map":
      return t("ws.tabTitle.map", { schema: tab.schema });
    case "board":
      // The board's own name once it has reported one; its schema until then.
      return t("ws.tabTitle.board", { name: tab.name ?? tab.schema });
    case "processes":
      return t("ws.tabTitle.processes");
    case "diff":
      return t("ws.tabTitle.diff");
    case "object":
      return tab.schema === currentSchema ? tab.name : tab.schema + "." + tab.name;
    case "objexplorer":
      return t("ws.tabTitle.objects");
    case "tableoverview":
      return t("ws.tabTitle.overview", { schema: tab.schema });
  }
}

/** Hover/`aria` text — always fully qualified for a schema-scoped tab, so the
 *  schema the shortened label drops is still one hover away. */
function tabTooltip(tab: Tab, currentSchema: string): string {
  switch (tab.kind) {
    case "table":
      return tab.schema + "." + tab.table;
    case "object":
      return tab.schema + "." + tab.name;
    default:
      return tabTitle(tab, currentSchema);
  }
}

/**
 * Labels for the whole strip, in tab order. "Open in new tab" puts the same
 * table on the strip twice, which would render two identical labels; repeats are
 * numbered (`benefits`, `benefits (2)`) — untouched when nothing repeats.
 */
export function tabLabels(tabs: Tab[], currentSchema: string): TabLabel[] {
  const seen = new Map<string, number>();
  return tabs.map((tab) => {
    const base = tabTitle(tab, currentSchema);
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    const ordinal = nth > 1 ? " (" + nth + ")" : "";
    return { title: base + ordinal, tooltip: tabTooltip(tab, currentSchema) + ordinal };
  });
}
