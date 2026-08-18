// Per-workspace view state for the data-file viewer (M35), keyed by workspace
// id — the same pattern the Typesense/Cassandra workspaces use.
//
// The App renders only the ACTIVE workspace, so the viewer unmounts on every
// workspace switch; local `useState` here would lose the open tabs, the hidden
// columns and the row filter. Everything below is per workspace and drops when
// the workspace is closed (or re-opened on another file, which resets it — the
// column names it holds may not exist in the new file).

import { create } from "zustand";

import type { SortSpec } from "../../shared/api/engine";
import type { TabFilterState } from "../workspaces/types";
import { emptyBatch, type EditBatch } from "./csvWrite";

/** The four views, each of which opens at most one tab. */
export type DataFileTabKind = "data" | "profile" | "issues" | "sql";

/** One open tab. Deduplicated by kind, so the id is the kind. */
export interface DataFileTab {
  id: DataFileTabKind;
  kind: DataFileTabKind;
  title: string;
}

/** Icon + title per view — the tab strip and the sidebar read the same table. */
export const DATA_FILE_TABS: Record<DataFileTabKind, { icon: string; title: string }> = {
  data: { icon: "table_rows", title: "Data" },
  profile: { icon: "insights", title: "Column profile" },
  issues: { icon: "rule", title: "Data quality" },
  sql: { icon: "code", title: "SQL" },
};

/** The Data tab's row filter: a named subset of row indexes to show. */
export interface RowFilter {
  /** Shown on the chip, e.g. "3 rows have the wrong number of fields". */
  label: string;
  /** Row indexes into `doc.parsed.rows`. */
  rows: number[];
}

export interface DataFileViewState {
  tabs: DataFileTab[];
  activeId: DataFileTabKind;
  /** Columns hidden from the Data grid (still profiled — that is the point). */
  hidden: string[];
  /** The profile card to scroll to and ring. */
  focusCol: string | null;
  /** Rows the Data tab is narrowed to, or null for the whole file. */
  rowFilter: RowFilter | null;

  // --- filter builder ----------------------------------------------------
  // Same draft-vs-applied split as the browse grid's per-tab filter state: the
  // panel edits `draft`, the grid shows `applied`, Apply commits one into the
  // other. Lives here (not in the tab component) for the same reason as
  // everything else in this store — the viewer unmounts on a workspace switch.
  /** Editable + committed filter, or null until the panel is first opened. */
  filter: TabFilterState | null;
  /** Whether the filter panel is expanded. */
  filterOpen: boolean;
  /** The last raw-WHERE failure, shown inline in the panel. */
  filterError: string | null;
  /** Applied sort — owned here so the panel's ORDER BY control can commit it. */
  sort: SortSpec | null;
  /** Staged ORDER BY: reaches the grid only when Apply commits it. */
  pendingSort: SortSpec | null;

  /** A query the SQL tab should load next (the panel's "open in SQL tab"). */
  seedSql: string | null;

  // --- staged editing ----------------------------------------------------
  /**
   * Uncommitted changes to the file: edited cells, appended rows, deleted rows.
   * NOTHING here has touched the disk — the file is rewritten only when the save
   * bar's Save runs, exactly like the engines' staged grid edits.
   */
  edits: EditBatch;
  /** Monotonic key source for staged rows (never written to the file). */
  nextRowKey: number;
}

/** A freshly opened file lands on Data, with nothing hidden or filtered. */
export function initialViewState(): DataFileViewState {
  return {
    tabs: [{ id: "data", kind: "data", title: DATA_FILE_TABS.data.title }],
    activeId: "data",
    hidden: [],
    focusCol: null,
    rowFilter: null,
    filter: null,
    filterOpen: false,
    filterError: null,
    sort: null,
    pendingSort: null,
    seedSql: null,
    edits: emptyBatch(),
    nextRowKey: 1,
  };
}

interface Store {
  byWorkspace: Record<string, DataFileViewState>;
  patch: (workspaceId: string, patch: Partial<DataFileViewState>) => void;
  /** Open (or focus) a view's tab. */
  openTab: (workspaceId: string, kind: DataFileTabKind) => void;
  /** Close a tab; the Data tab can never be closed to zero. */
  closeTab: (workspaceId: string, kind: DataFileTabKind) => void;
  /** Flip one column's visibility in the Data grid. */
  toggleColumn: (workspaceId: string, name: string) => void;
  /** Focus a column's profile card, opening the Profile tab. */
  focusColumn: (workspaceId: string, name: string) => void;
  /** Narrow the Data tab to `filter` (null clears) and go there. */
  showRows: (workspaceId: string, filter: RowFilter | null) => void;
  /** Open the SQL tab loaded with `sql` — the filter panel's "open in SQL". */
  openSqlWith: (workspaceId: string, sql: string) => void;
  /** Clear the pending seed once the SQL tab has taken it. */
  consumeSeedSql: (workspaceId: string) => void;

  // --- staged editing ----------------------------------------------------
  /**
   * Stage one cell. `row` indexes `parsed.rows`, or is negative to address a
   * staged NEW row as `-(key)` — new rows have no file position yet.
   * Setting a cell back to its original value clears the entry, so the pending
   * count only ever reflects real differences.
   */
  editCell: (
    workspaceId: string,
    row: number,
    col: number,
    value: string,
    original: string,
  ) => void;
  /** Stage a new, empty row at the end. */
  addRow: (workspaceId: string) => void;
  /** Stage / unstage a deletion for existing rows, or drop staged new ones. */
  toggleDeleted: (workspaceId: string, rows: number[]) => void;
  /** Throw the whole batch away (Discard). */
  discardEdits: (workspaceId: string) => void;
  /** Clear the batch after a successful save. */
  commitEdits: (workspaceId: string) => void;
  /** Drop a workspace's view state (closed, or re-opened on another file). */
  reset: (workspaceId: string) => void;
}

export const useDataFileStore = create<Store>((set) => ({
  byWorkspace: {},

  patch: (id, patch) =>
    set((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        [id]: { ...(s.byWorkspace[id] ?? initialViewState()), ...patch },
      },
    })),

  openTab: (id, kind) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialViewState();
      const tabs = cur.tabs.some((t) => t.kind === kind)
        ? cur.tabs
        : [...cur.tabs, { id: kind, kind, title: DATA_FILE_TABS[kind].title }];
      return { byWorkspace: { ...s.byWorkspace, [id]: { ...cur, tabs, activeId: kind } } };
    }),

  closeTab: (id, kind) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialViewState();
      if (cur.tabs.length === 1) return s;
      const idx = cur.tabs.findIndex((t) => t.kind === kind);
      if (idx === -1) return s;
      const tabs = cur.tabs.filter((t) => t.kind !== kind);
      // Left neighbour, else the first remaining tab — only when the closed
      // tab was the active one.
      const activeId =
        cur.activeId === kind ? (tabs[Math.max(0, idx - 1)]?.kind ?? tabs[0]!.kind) : cur.activeId;
      return { byWorkspace: { ...s.byWorkspace, [id]: { ...cur, tabs, activeId } } };
    }),

  toggleColumn: (id, name) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialViewState();
      const hidden = cur.hidden.includes(name)
        ? cur.hidden.filter((n) => n !== name)
        : [...cur.hidden, name];
      return { byWorkspace: { ...s.byWorkspace, [id]: { ...cur, hidden } } };
    }),

  focusColumn: (id, name) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialViewState();
      const tabs = cur.tabs.some((t) => t.kind === "profile")
        ? cur.tabs
        : [
            ...cur.tabs,
            {
              id: "profile" as const,
              kind: "profile" as const,
              title: DATA_FILE_TABS.profile.title,
            },
          ];
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [id]: { ...cur, tabs, activeId: "profile", focusCol: name },
        },
      };
    }),

  showRows: (id, filter) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialViewState();
      const tabs = cur.tabs.some((t) => t.kind === "data")
        ? cur.tabs
        : [
            ...cur.tabs,
            { id: "data" as const, kind: "data" as const, title: DATA_FILE_TABS.data.title },
          ];
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [id]: { ...cur, tabs, activeId: "data", rowFilter: filter },
        },
      };
    }),

  openSqlWith: (id, sql) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialViewState();
      const tabs = cur.tabs.some((t) => t.kind === "sql")
        ? cur.tabs
        : [
            ...cur.tabs,
            { id: "sql" as const, kind: "sql" as const, title: DATA_FILE_TABS.sql.title },
          ];
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [id]: { ...cur, tabs, activeId: "sql", seedSql: sql },
        },
      };
    }),

  consumeSeedSql: (id) =>
    set((s) => {
      const cur = s.byWorkspace[id];
      if (!cur || cur.seedSql === null) return s;
      return { byWorkspace: { ...s.byWorkspace, [id]: { ...cur, seedSql: null } } };
    }),

  editCell: (id, row, col, value, original) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialViewState();
      // A staged NEW row keeps its cells on the row itself.
      if (row < 0) {
        const key = -row;
        const added = cur.edits.added.map((r) =>
          r.key === key ? { ...r, cells: { ...r.cells, [col]: value } } : r,
        );
        return {
          byWorkspace: { ...s.byWorkspace, [id]: { ...cur, edits: { ...cur.edits, added } } },
        };
      }
      const rowEdits = { ...(cur.edits.cells[row] ?? {}) };
      if (value === original) delete rowEdits[col];
      else rowEdits[col] = value;
      const cells = { ...cur.edits.cells };
      if (Object.keys(rowEdits).length === 0) delete cells[row];
      else cells[row] = rowEdits;
      return {
        byWorkspace: { ...s.byWorkspace, [id]: { ...cur, edits: { ...cur.edits, cells } } },
      };
    }),

  addRow: (id) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialViewState();
      const added = [...cur.edits.added, { key: cur.nextRowKey, cells: {} }];
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [id]: { ...cur, edits: { ...cur.edits, added }, nextRowKey: cur.nextRowKey + 1 },
        },
      };
    }),

  toggleDeleted: (id, rows) =>
    set((s) => {
      const cur = s.byWorkspace[id] ?? initialViewState();
      const existing = new Set(cur.edits.deleted);
      let added = cur.edits.added;
      for (const row of rows) {
        if (row < 0) {
          // A staged row that was never in the file: drop it outright rather
          // than marking it deleted — there is nothing to delete.
          added = added.filter((r) => r.key !== -row);
          continue;
        }
        if (existing.has(row)) existing.delete(row);
        else existing.add(row);
      }
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [id]: { ...cur, edits: { ...cur.edits, deleted: [...existing], added } },
        },
      };
    }),

  discardEdits: (id) =>
    set((s) => {
      const cur = s.byWorkspace[id];
      if (!cur) return s;
      return { byWorkspace: { ...s.byWorkspace, [id]: { ...cur, edits: emptyBatch() } } };
    }),

  commitEdits: (id) =>
    set((s) => {
      const cur = s.byWorkspace[id];
      if (!cur) return s;
      return { byWorkspace: { ...s.byWorkspace, [id]: { ...cur, edits: emptyBatch() } } };
    }),

  reset: (id) =>
    set((s) => {
      if (!s.byWorkspace[id]) return s;
      const next = { ...s.byWorkspace };
      delete next[id];
      return { byWorkspace: next };
    }),
}));
