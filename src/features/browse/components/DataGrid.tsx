// Virtualized data grid (spec §3.5, MILESTONES M4) — ported behavior from the
// prototype's grid.jsx, with the real backend's LIMIT/OFFSET paging behind it.
//
// VIRTUALIZATION + EXPLICIT PAGING (Bug 2 — the prototype's `.table-footer`
// pager):
//   - The table tab owns `offset`/`pageSize` and drives them from the footer
//     pager. The grid fetches EXACTLY the current page —
//     `rowsFetch(..., { offset, limit: pageSize })` — and virtualizes WITHIN
//     that page with @tanstack/react-virtual. The scroll container is sized to
//     `pageRowCount × rowHeight` (the page's rows, not the whole table), so the
//     scrollbar reflects the page; the footer's prev/next move the window.
//   - The page's rows live in a cache keyed by ABSOLUTE row index
//     (`offset + i`) so the inline-edit pk logic + row-number gutter stay
//     correct across pages. A page in flight renders a shimmer skeleton.
//   - `totalRows` (the fetch's COUNT, filtered when a filter is applied) is
//     reported to the tabMeta seam; the footer reads it for the range readout
//     and next-enabled, and the toolbar's "N rows" stays consistent with it.
//   - Sort / filter / refresh / page change all reset the cache and re-fetch.
//
// STAGED DATA EDITING (Prompts 1–4, prototype `workspace.jsx` `TableDataTab`):
//   - Editing a cell on an EXISTING row does NOT write to the database. The
//     edit is staged in `pendingEdits` keyed by the row's primary key; the cell
//     gets the `cell-edited` highlight (accent tint + left accent bar). Editing
//     a value back to its original clears it from the pending set.
//   - New rows (⌘I / ⌘N add-row) are staged in `newRows` and ride at the TOP of
//     page 0 (`row-staged` highlight + a ✱ in the gutter). Auto-incremented int
//     pk for display; column defaults applied; everything else NULL.
//   - A "save bar" pinned below the grid appears whenever anything is staged.
//     ⌘S / Cmd+S (or the Save button) commits the whole batch in one
//     transaction (`execute_script_text`: one UPDATE per edited row + one INSERT
//     per new row), then clears staging and re-fetches. Discard reverts all.
//   - Production safety: on a `production` connection Save first shows a confirm
//     dialog with the exact batch SQL — staging means nothing hits the DB until
//     that explicit, reviewed save.
//
// EXTENSIBILITY SEAMS (commented inline, NOT built this milestone):
//   - M10 FK hop + column insights → the header hosts an insights icon on
//          hover; FK cells become accent links opening a peek popover.

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  CellValue,
  ColumnMeta,
  FilterSpec,
  FkRef,
  PkPredicate,
  SortSpec,
} from "../../../shared/api/engine";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

import { executeScriptText, exportSave, rowsDelete, rowsFetch } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { BulkDeleteModal } from "../../../shared/ui/BulkDeleteModal";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import { useSettingsStore } from "../../settings/state";
import { useTabMetaStore } from "../../workspaces/tabMeta";
import { BinaryEditorModal } from "./BinaryEditorModal";
import { isBinaryType, looksUuid, uuidToHex } from "./binaryCell";
import { ColumnInsights, type InsightsAnchor } from "./ColumnInsights";
import { FkPeek, type FkPeekAnchor } from "./FkPeek";
import { CellContent } from "./GridCell";
import { JsonEditorModal } from "./JsonEditorModal";
import { isJsonType } from "./jsonCell";
import type { Engine } from "../../../shared/types";
import "./DataGrid.css";

/** Per-column metadata the grid keeps from tableMeta: pk/fk drive icons + FK
 *  hop (M10); dataType/nullable drive inline-edit type coercion + the
 *  pk-predicate / editability gate; `default` seeds staged new rows. */
interface ColCellMeta {
  pk: boolean;
  fk: FkRef | null;
  /** Declared DDL type (may be empty); used for edit-commit type coercion. */
  dataType: string;
  /** True when the column has no NOT NULL constraint (empty input → NULL). */
  nullable: boolean;
  /** The column's DEFAULT expression verbatim, or null. Seeds new staged rows. */
  default: string | null;
}

/** What an active edit / cell-modal targets: an existing (real) row keyed by
 *  absolute cache index, or a staged new row keyed by its stable id (staged
 *  rows reorder as more are prepended, so an index would drift). */
type EditTarget = { kind: "real"; rowIndex: number } | { kind: "staged"; stagedKey: number };

/** A stable primitive identity for an edit target (used as a render key and as
 *  the focus-effect dependency so it runs once per edit, not per keystroke). */
function targetKey(t: EditTarget): string {
  return t.kind === "real" ? "r" + t.rowIndex : "s" + t.stagedKey;
}

/** The in-flight inline edit: which cell, and the draft text in the input. */
interface EditState {
  target: EditTarget;
  /** Column index into `columns`. */
  col: number;
  /** The text the borderless input currently holds. */
  draft: string;
}

/** A staged, unsaved new row. `values` is aligned to `columns` order; `key` is
 *  a stable identity that survives prepending more rows. */
interface NewRow {
  key: number;
  values: CellValue[];
}

/** A staged set of edits to one existing row, self-contained so it can be saved
 *  even after the row has scrolled off the cached page. */
interface PendingRow {
  /** The full primary key of the target row (for the UPDATE … WHERE). */
  pk: PkPredicate[];
  /** Column index → new value (only the changed cells). */
  cells: Map<number, CellValue>;
}

/** SQLite type-affinity buckets we coerce edit input into. Keyword-based, the
 *  same heuristic the engine's affinity rules use — declared type is a free
 *  string, so we match substrings (case-insensitive). */
function affinityOf(dataType: string): "integer" | "real" | "boolean" | "text" {
  const t = dataType.toUpperCase();
  if (t.includes("BOOL")) return "boolean";
  if (t.includes("INT")) return "integer";
  if (
    t.includes("REAL") ||
    t.includes("FLOA") ||
    t.includes("DOUB") ||
    t.includes("DEC") ||
    t.includes("NUM")
  )
    return "real";
  return "text";
}

/**
 * Coerce the input string to the JSON value the backend binds by type.
 * - empty input → null when the column is nullable (else fall through to text,
 *   so a NOT NULL column surfaces the engine's rejection on commit).
 * - integer/real columns → a Number when the trimmed text parses; otherwise
 *   the raw string (the engine validates / rejects).
 * - boolean columns → 1/0 (SQLite stores booleans as integers; the grid shows
 *   true/false) for "true"/"false"/"1"/"0"; otherwise the raw string.
 * - everything else → the string verbatim.
 */
function coerceForColumn(draft: string, meta: ColCellMeta | undefined): CellValue {
  const affinity = meta ? affinityOf(meta.dataType) : "text";
  const trimmed = draft.trim();
  if (trimmed === "" && (meta?.nullable ?? true)) return null;
  if (affinity === "integer" || affinity === "real") {
    if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
    return draft;
  }
  if (affinity === "boolean") {
    const low = trimmed.toLowerCase();
    if (low === "true" || low === "1") return 1;
    if (low === "false" || low === "0") return 0;
    return draft;
  }
  return draft;
}

/**
 * Parse a column's DEFAULT expression into a display value for a staged new row
 * (prototype `addRow`). Simple literals (numbers, quoted strings, true/false)
 * are shown; anything we can't safely evaluate (e.g. `CURRENT_TIMESTAMP`,
 * `nextval(...)`) stays NULL so the database fills it on INSERT.
 */
function parseDefault(def: string | null, affinity: ReturnType<typeof affinityOf>): CellValue {
  if (def === null) return null;
  const t = def.trim();
  if (t === "" || /^null$/i.test(t)) return null;
  if (affinity === "boolean") {
    if (/^(true|1)$/i.test(t)) return 1;
    if (/^(false|0)$/i.test(t)) return 0;
  }
  if (affinity === "integer" || affinity === "real") {
    if (!Number.isNaN(Number(t))) return Number(t);
  }
  const quoted = t.match(/^'([\s\S]*)'$/);
  if (quoted) return quoted[1]!.replace(/''/g, "'");
  // Unparseable expression — let the DB apply it on INSERT.
  return null;
}

/** Single-quote-escape a value for a SQL literal — engine-aware. Used for the
 *  confirm-dialog SQL and the batch script run via execute_script_text. MySQL
 *  treats backslash as an escape character inside string literals (unlike
 *  standard SQL / Postgres / SQLite), so it must be doubled there too. */
function sqlLiteral(value: CellValue, engine: Engine | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  let s = String(value).replace(/'/g, "''");
  if (engine === "mysql") s = s.replace(/\\/g, "\\\\");
  return "'" + s + "'";
}

/** Quote an identifier for the batch SQL — engine-aware. MySQL uses backticks
 *  (double quotes are string literals unless ANSI_QUOTES is set); Postgres and
 *  SQLite use double quotes. */
function quoteIdent(name: string, engine: Engine | undefined): string {
  if (engine === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

/** A binary value (UUID or `0x`-hex string) as an engine-specific binary
 *  literal — so it binds as RAW BYTES, not a text string. A `BINARY(16)` /
 *  `bytea` / `BLOB` column rejects the 36-char string form ("Data too long").
 *  Falls back to a quoted string when the value isn't valid hex. */
function binaryLiteral(value: CellValue, engine: Engine | undefined): string {
  const s = String(value);
  let hex = looksUuid(s) ? uuidToHex(s) : s.replace(/^0x/i, "").replace(/-/g, "");
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return sqlLiteral(value, engine);
  hex = hex.toUpperCase();
  if (engine === "postgres") return "decode('" + hex + "', 'hex')";
  return "X'" + hex + "'"; // MySQL + SQLite hex/blob literal
}

/** Row overscan handed to the virtualizer (DOM rows beyond the viewport). */
const ROW_OVERSCAN = 12;
/** Fallback row height before the CSS var is measured (compact default). */
const FALLBACK_ROW_H = 26;

// --- Bug 1: explicit per-column pixel widths (shared by header + all rows) ---
/** Min/max column track width (px). */
const COL_MIN_PX = 90;
const COL_MAX_PX = 400;
/** Row-number gutter width (px) — matches `.dg-rownum` min-width. */
const ROWNUM_PX = 30;
/** Multi-select checkbox gutter width (px) — matches `.dg-check-c`. */
const CHECK_PX = 34;
/** Horizontal cell/header padding (px) — `.dg-td`/`.dg-th` are `0 12px`. */
const CELL_PAD_PX = 24;
const CELL_CHAR_PX = 7.3;
const HEAD_NAME_CHAR_PX = 7;
const HEAD_TYPE_CHAR_PX = 5.7;
/** Allowance for header icons (pk/fk badge, sort arrow) + the inter-item gap. */
const HEAD_ICON_PX = 40;
/** Rows sampled when measuring cell widths. */
const WIDTH_SAMPLE_ROWS = 200;

/** Render width of one cell value, mirroring GridCell's text output. */
function cellTextLength(value: CellValue): number {
  if (value === null) return 4; // "null"
  if (typeof value === "number")
    return (Number.isInteger(value) ? String(value) : value.toFixed(2)).length;
  return String(value).length;
}

/** Sort state cycles asc → desc → none (null) on repeated header clicks. */
function cycleSort(current: SortSpec | null, column: string): SortSpec | null {
  if (!current || current.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

/** Imperative actions the table-tab toolbar + keyboard shortcuts trigger. */
export interface DataGridHandle {
  /** Stage a new empty row at the top (⌘I / toolbar +). */
  addRow: () => void;
  /** Commit all staged changes (⌘S / Save button). */
  save: () => void;
  /** Revert all staged changes (Discard button). */
  discard: () => void;
}

interface DataGridProps {
  /** Live backend handle from the active workspace. */
  handleId: string;
  /** Tab identity — drives meta reporting, scroll + refetch seams. */
  tabId: string;
  schema: string;
  table: string;
  /** The applied row filter (M5), or `null` for the whole table. */
  filter: FilterSpec | null;
  /** A stable identity for `filter`, so the reset effect can depend on it. */
  filterKey: string;
  /** Called with the §5 message when the first page of a filtered fetch fails. */
  onFilterError?: (message: string) => void;
  /** Called when a filtered fetch's first page succeeds (clears panel error). */
  onFilterOk?: () => void;
  /** Columns hidden by the table tab's Columns popover (display-only). */
  hiddenColumns?: ReadonlySet<string>;
  /** Explicit paging — the table tab owns `offset`/`pageSize`. */
  offset: number;
  pageSize: number;
  /** Called when the user changes the sort (resets paging to page 1). */
  onSortChange?: () => void;
  /**
   * Called by `addRow` BEFORE prepending the staged row: the table tab clears
   * any applied filter and jumps to the first page so the new row (which rides
   * at the top of page 0) is visible. Sort is the grid's own state, cleared here.
   */
  onAddRowReset?: () => void;
}

export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(function DataGrid(
  {
    handleId,
    tabId,
    schema,
    table,
    filter,
    filterKey,
    onFilterError,
    onFilterOk,
    hiddenColumns,
    offset,
    pageSize,
    onSortChange,
    onAddRowReset,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- column header meta (pk/fk/type/default) -------------------------
  const loadColumns = useIntrospectionStore((s) => s.loadColumns);
  const [colMeta, setColMeta] = useState<Map<string, ColCellMeta>>(new Map());

  // --- result state ----------------------------------------------------
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [selected, setSelected] = useState<{ rowKey: string; col: number } | null>(null);
  // Multi-select for bulk delete / export. Keyed by real-row key ("r"+absIndex);
  // staged rows are never selectable. Cleared on any (re)fetch / page change.
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);

  // --- inline edit -----------------------------------------------------
  const toast = useToast();
  const [editing, setEditing] = useState<EditState | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  // Enter then blur must not double-commit one edit session.
  const committingRef = useRef(false);

  // --- staged data editing (Prompts 1–3) -------------------------------
  // Pending edits to existing rows, keyed by primary-key string. Self-contained
  // (carries the pk predicate + new values) so a save works even after the row
  // scrolled off the cached page.
  const [pendingEdits, setPendingEdits] = useState<Map<string, PendingRow>>(new Map());
  // Staged new rows (ride at the top of page 0).
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  // Monotonic id source for new-row keys (a ref — not render state).
  const stagedKeySeq = useRef(0);
  // Save-time production confirm: the batch SQL parked for review, or null.
  const [saveConfirmSql, setSaveConfirmSql] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Production gate: a `production` connection requires a confirm before Save
  // touches the database.
  const isProduction = useWorkspacesStore(
    (s) => s.workspaces.find((ws) => ws.handleId === handleId)?.saved.env === "production",
  );
  // M20: the typed production confirm is opt-out via Settings → Behavior
  // ("Confirm writes on production"). When off, prod saves skip the gate.
  const confirmProd = useSettingsStore((s) => s.settings.confirmProd);
  // The connection's engine — drives engine-aware identifier quoting + literal
  // escaping in the batch SQL (MySQL backticks vs. Postgres/SQLite double quotes).
  const engine = useWorkspacesStore(
    (s) => s.workspaces.find((ws) => ws.handleId === handleId)?.info.engine,
  );

  // --- JSON / binary cell editor modals --------------------------------
  const [cellModal, setCellModal] = useState<{
    kind: "json" | "binary";
    target: EditTarget;
    col: number;
    column: string;
    type: string;
    value: CellValue;
  } | null>(null);

  // --- M10 popovers (FK peek + column insights) ------------------------
  const [fkPeek, setFkPeek] = useState<FkPeekAnchor | null>(null);
  const [insights, setInsights] = useState<InsightsAnchor | null>(null);
  const closeFkPeek = useCallback(() => setFkPeek(null), []);
  const closeInsights = useCallback(() => setInsights(null), []);

  // Copy a cell's raw value to the clipboard — handy for read-only cells
  // (primary keys can't be selected/edited) when pasting an id into a query.
  const copyCell = useCallback(
    (value: CellValue) => {
      if (value === null) return;
      void navigator.clipboard.writeText(String(value)).then(
        () => toast("Copied", "ok"),
        () => toast("Couldn't copy to clipboard", "err"),
      );
    },
    [toast],
  );

  // The current page's rows, keyed by ABSOLUTE row index (`offset + i`).
  const rowCacheRef = useRef<Map<number, CellValue[]>>(new Map());
  const [pageRowCount, setPageRowCount] = useState(0);
  const [cacheVersion, setCacheVersion] = useState(0);
  const generationRef = useRef(0);

  // Refresh nonce from the tabMeta seam.
  const refetchNonce = useTabMetaStore((s) => s.refetchNonce[tabId] ?? 0);

  const filterCbRef = useRef({ onFilterError, onFilterOk });
  filterCbRef.current = { onFilterError, onFilterOk };
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const resetForLoad = useCallback(() => {
    generationRef.current += 1;
    rowCacheRef.current = new Map();
    setPageRowCount(0);
    setCacheVersion((v) => v + 1);
    setLoadingInitial(true);
    setInitialError(null);
    setSelected(null);
  }, []);

  // --- page fetcher ----------------------------------------------------
  const fetchCurrentPage = useCallback(() => {
    const generation = generationRef.current;
    void rowsFetch(handleId, {
      schema,
      table,
      sort,
      filter: filterRef.current,
      offset,
      limit: pageSize,
    })
      .then((page) => {
        if (generation !== generationRef.current) return; // stale
        setColumns(page.columns);
        setTotalRows(page.totalRows);
        rowCacheRef.current = new Map();
        for (let i = 0; i < page.rows.length; i++) {
          rowCacheRef.current.set(page.offset + i, page.rows[i]!);
        }
        setPageRowCount(page.rows.length);
        setCacheVersion((v) => v + 1);
        setLoadingInitial(false);
        filterCbRef.current.onFilterOk?.();
        useTabMetaStore.getState().setTabMeta(tabId, {
          totalRows: page.totalRows,
          elapsedMs: page.elapsedMs,
          shownRows: undefined,
        });
      })
      .catch((err: unknown) => {
        if (generation !== generationRef.current) return;
        const message = appErrorMessage(err, "Could not load rows.");
        if (filterRef.current !== null && filterCbRef.current.onFilterError) {
          filterCbRef.current.onFilterError(message);
          setLoadingInitial(false);
        } else {
          setInitialError(message);
          setLoadingInitial(false);
        }
      });
  }, [handleId, schema, table, sort, tabId, offset, pageSize]);

  // Initial load + reload on identity / sort / filter / page / refresh changes.
  useEffect(() => {
    resetForLoad();
    committingRef.current = false;
    setEditing(null);
    fetchCurrentPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, schema, table, sort, filterKey, refetchNonce, offset, pageSize]);

  // Staging clears ONLY on table/schema identity change (NOT on sort/filter/
  // page/refresh — edits are keyed by pk and re-applied; new rows persist and
  // re-show on page 0). Mirrors the prototype's reset-on-table-change.
  useEffect(() => {
    setPendingEdits(new Map());
    setNewRows([]);
    setSaveConfirmSql(null);
  }, [handleId, schema, table]);

  // Load the column header meta (pk/fk/default) once per identity.
  useEffect(() => {
    let alive = true;
    void loadColumns(handleId, schema, table).then((cols) => {
      if (!alive || !cols) return;
      const map = new Map<string, ColCellMeta>();
      for (const c of cols)
        map.set(c.name, {
          pk: c.pk,
          fk: c.fk,
          dataType: c.dataType,
          nullable: c.nullable,
          default: c.default ?? null,
        });
      setColMeta(map);
    });
    return () => {
      alive = false;
    };
  }, [handleId, schema, table, loadColumns]);

  // --- virtualizer -----------------------------------------------------
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_H);
  useLayoutEffect(() => {
    const read = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue("--grid-row-h").trim();
      const px = parseFloat(v);
      if (!Number.isNaN(px) && px > 0) setRowHeight((prev) => (prev === px ? prev : px));
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    return () => obs.disconnect();
  }, []);

  // Staged new rows ride at the top of page 0 only.
  const stagedShown = offset === 0 ? newRows.length : 0;
  // Virtual row count: staged rows (page 0) + the current backend page's rows.
  const rowCount = stagedShown + pageRowCount;
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: ROW_OVERSCAN,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  const virtualRows = rowVirtualizer.getVirtualItems();

  // --- scroll persistence (per-tab, across workspace switches) ---------
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    if (restoredRef.current || loadingInitial) return;
    const el = scrollRef.current;
    if (!el) return;
    restoredRef.current = true;
    const saved = useTabMetaStore.getState().scrollTop[tabId];
    if (saved && saved > 0) el.scrollTop = saved;
  }, [loadingInitial, totalRows, tabId]);

  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const el = scrollRef.current;
      if (el) useTabMetaStore.getState().setTabScrollTop(tabId, el.scrollTop);
    };
  }, [tabId]);

  // --- render ----------------------------------------------------------
  const onSortChangeRef = useRef(onSortChange);
  onSortChangeRef.current = onSortChange;
  const onHeaderClick = useCallback((column: string) => {
    onSortChangeRef.current?.();
    setSort((prev) => cycleSort(prev, column));
  }, []);

  const onFkClick = useCallback(
    (fk: FkRef, value: CellValue, binary: boolean, event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      if (fkHopTimer.current !== null) window.clearTimeout(fkHopTimer.current);
      fkHopTimer.current = window.setTimeout(() => {
        fkHopTimer.current = null;
        setInsights(null);
        setFkPeek({
          rect,
          refSchema: schema,
          refTable: fk.table,
          refColumn: fk.column,
          value,
          binary,
        });
      }, 250);
    },
    [schema],
  );

  const onOpenInTable = useCallback((anchor: FkPeekAnchor) => {
    useWorkspacesStore
      .getState()
      .openTableTabWithFilter(anchor.refSchema, anchor.refTable, anchor.refColumn, anchor.value);
    setFkPeek(null);
  }, []);

  const onInsightClick = useCallback(
    (column: string, event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setFkPeek(null);
      setInsights({ rect, column });
    },
    [],
  );

  // --- inline edit: editability gating + staging -----------------------
  const pkColumns = useMemo(
    () => columns.filter((c) => colMeta.get(c.name)?.pk).map((c) => c.name),
    [columns, colMeta],
  );
  const hasPk = pkColumns.length > 0;

  const buildPk = useCallback(
    (row: CellValue[]): PkPredicate[] | null => {
      const preds: PkPredicate[] = [];
      for (const pkName of pkColumns) {
        const ci = columns.findIndex((c) => c.name === pkName);
        if (ci < 0) return null;
        preds.push({
          column: pkName,
          value: row[ci] ?? null,
          binary: isBinaryType(colMeta.get(pkName)?.dataType),
        });
      }
      return preds.length > 0 ? preds : null;
    },
    [columns, pkColumns, colMeta],
  );

  /** Stable string key for an existing row from its pk values. */
  const pkKeyOf = useCallback(
    (row: CellValue[]): string | null => {
      const pk = buildPk(row);
      if (pk === null) return null;
      return JSON.stringify(pk.map((p) => p.value));
    },
    [buildPk],
  );

  // A real cell is editable when the table has a pk, the cell's own column is
  // NOT a pk column, and the row's pk values are all present. Staged-row cells
  // are always editable (no commit until save).
  const readOnlyReason = useCallback(
    (rowIndex: number, ci: number): string | null => {
      if (!hasPk) return "Read-only: table has no primary key";
      const colName = columns[ci]?.name;
      if (colName && colMeta.get(colName)?.pk) return "Read-only: primary key column";
      const row = rowCacheRef.current.get(rowIndex);
      if (!row || buildPk(row) === null) return "Read-only: row key unavailable";
      return null;
    },
    [hasPk, columns, colMeta, buildPk],
  );

  // The displayed value for a real cell = pending override (if any) else cache.
  const realCellValue = useCallback(
    (rowIndex: number, ci: number): CellValue => {
      const row = rowCacheRef.current.get(rowIndex);
      if (!row) return null;
      const key = pkKeyOf(row);
      if (key) {
        const pend = pendingEdits.get(key);
        if (pend && pend.cells.has(ci)) return pend.cells.get(ci) ?? null;
      }
      return row[ci] ?? null;
    },
    [pendingEdits, pkKeyOf],
  );

  const isRealCellEdited = useCallback(
    (rowIndex: number, ci: number): boolean => {
      const row = rowCacheRef.current.get(rowIndex);
      if (!row) return false;
      const key = pkKeyOf(row);
      return key ? (pendingEdits.get(key)?.cells.has(ci) ?? false) : false;
    },
    [pendingEdits, pkKeyOf],
  );

  // Begin editing a cell. Prefills with the currently DISPLAYED value (so a
  // staged override round-trips). No-op on a read-only real cell.
  const startEdit = useCallback(
    (target: EditTarget, ci: number) => {
      let cur: CellValue = null;
      if (target.kind === "real") {
        if (readOnlyReason(target.rowIndex, ci) !== null) return;
        cur = realCellValue(target.rowIndex, ci);
      } else {
        const nr = newRows.find((r) => r.key === target.stagedKey);
        if (!nr) return;
        cur = nr.values[ci] ?? null;
      }
      committingRef.current = false;
      setEditing({ target, col: ci, draft: cur === null ? "" : String(cur) });
    },
    [readOnlyReason, realCellValue, newRows],
  );

  const cancelEdit = useCallback(() => {
    committingRef.current = false;
    setEditing(null);
  }, []);

  // P4 fix: focus + select ONCE when an edit STARTS. Depends on the target's
  // primitive identity (+ column), NOT the whole editing object — so it does
  // not re-run on every keystroke (which re-selected the text mid-type).
  const editFocusKey = editing ? targetKey(editing.target) + ":" + editing.col : null;
  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editFocusKey]);

  // Stage a value for a real-row cell: record under the row's pk, or clear it
  // if the value returns to the original cached value.
  const stageRealValue = useCallback(
    (rowIndex: number, ci: number, value: CellValue) => {
      const row = rowCacheRef.current.get(rowIndex);
      if (!row) return;
      const pk = buildPk(row);
      const key = pkKeyOf(row);
      if (!pk || !key) return;
      const original = row[ci] ?? null;
      const isRevert =
        value === original ||
        (value !== null && original !== null && String(value) === String(original));
      setPendingEdits((prev) => {
        const next = new Map(prev);
        const existing = next.get(key);
        const cells = new Map(existing?.cells ?? []);
        if (isRevert) cells.delete(ci);
        else cells.set(ci, value);
        if (cells.size === 0) next.delete(key);
        else next.set(key, { pk, cells });
        return next;
      });
    },
    [buildPk, pkKeyOf],
  );

  // Stage a value for a staged new-row cell (always recorded; the whole row is
  // unsaved).
  const stageNewValue = useCallback((stagedKey: number, ci: number, value: CellValue) => {
    setNewRows((prev) =>
      prev.map((r) => {
        if (r.key !== stagedKey) return r;
        const values = r.values.slice();
        values[ci] = value;
        return { ...r, values };
      }),
    );
  }, []);

  // Commit the active inline edit into the staging set (no DB write).
  const commitEdit = useCallback(() => {
    if (!editing || committingRef.current) return;
    const { target, col: ci, draft } = editing;
    const colName = columns[ci]?.name;
    if (!colName) {
      cancelEdit();
      return;
    }
    const value = coerceForColumn(draft, colMeta.get(colName));
    committingRef.current = true;
    setEditing(null);
    if (target.kind === "real") stageRealValue(target.rowIndex, ci, value);
    else stageNewValue(target.stagedKey, ci, value);
  }, [editing, columns, colMeta, stageRealValue, stageNewValue, cancelEdit]);

  // Open the JSON / binary editor for a cell (caller gates on editability).
  const openCellModal = useCallback(
    (kind: "json" | "binary", target: EditTarget, ci: number, col: ColumnMeta) => {
      let value: CellValue = null;
      if (target.kind === "real") value = realCellValue(target.rowIndex, ci);
      else value = newRows.find((r) => r.key === target.stagedKey)?.values[ci] ?? null;
      setCellModal({ kind, target, col: ci, column: col.name, type: col.typeHint, value });
    },
    [realCellValue, newRows],
  );

  // Apply a final value chosen in a cell modal — stages it like an inline edit.
  const commitCellValue = useCallback(
    (target: EditTarget, ci: number, value: CellValue) => {
      if (target.kind === "real") stageRealValue(target.rowIndex, ci, value);
      else stageNewValue(target.stagedKey, ci, value);
    },
    [stageRealValue, stageNewValue],
  );

  // --- staged-row counts -----------------------------------------------
  const editedRowCount = pendingEdits.size;
  const newRowCount = newRows.length;
  const dirtyCount = editedRowCount + newRowCount;

  // Build the batch SQL for a save: one UPDATE per edited row, one INSERT per
  // new row. Returns "" when nothing is staged. Takes the effective staging
  // sets so `save` can fold in an open (un-blurred) inline edit.
  const buildBatchSql = useCallback(
    (edits: Map<string, PendingRow>, rows: NewRow[]): string => {
      const qi = (n: string) => quoteIdent(n, engine);
      // Column-aware literal: binary columns bind as raw bytes (hex/blob
      // literal), everything else as a normal SQL literal.
      const litCol = (v: CellValue, colName: string) =>
        v !== null && isBinaryType(colMeta.get(colName)?.dataType)
          ? binaryLiteral(v, engine)
          : sqlLiteral(v, engine);
      const qtable = qi(schema) + "." + qi(table);
      const stmts: string[] = [];
      for (const { pk, cells } of edits.values()) {
        if (cells.size === 0) continue;
        const sets = [...cells.entries()].map(
          ([ci, val]) => qi(columns[ci]!.name) + " = " + litCol(val, columns[ci]!.name),
        );
        const where = pk.map((p) => qi(p.column) + " = " + litCol(p.value, p.column)).join(" AND ");
        stmts.push("UPDATE " + qtable + " SET " + sets.join(", ") + " WHERE " + where + ";");
      }
      for (const nr of rows) {
        const cols: string[] = [];
        const vals: string[] = [];
        columns.forEach((c, ci) => {
          const v = nr.values[ci] ?? null;
          if (v === null) return; // let the DB apply NULL / its default
          const m = colMeta.get(c.name);
          // Skip an integer primary key so SERIAL / AUTOINCREMENT assigns it
          // (the displayed value is a hint only); a non-int / user-typed pk is
          // kept (it is non-null here).
          if (m?.pk && affinityOf(m.dataType) === "integer") return;
          cols.push(qi(c.name));
          vals.push(litCol(v, c.name));
        });
        if (cols.length === 0)
          // MySQL has no `DEFAULT VALUES`; `() VALUES ()` is its empty-row form.
          stmts.push(
            engine === "mysql"
              ? "INSERT INTO " + qtable + " () VALUES ();"
              : "INSERT INTO " + qtable + " DEFAULT VALUES;",
          );
        else
          stmts.push(
            "INSERT INTO " +
              qtable +
              " (" +
              cols.join(", ") +
              ") VALUES (" +
              vals.join(", ") +
              ");",
          );
      }
      return stmts.join("\n");
    },
    [schema, table, columns, colMeta, engine],
  );

  // Run the batch against the DB (after the production confirm, if any).
  const runSave = useCallback(
    (sql: string, nNew: number, nUpdated: number) => {
      setSaving(true);
      void executeScriptText(handleId, schema, sql)
        .then(() => {
          setPendingEdits(new Map());
          setNewRows([]);
          const parts: string[] = [];
          if (nNew) parts.push(nNew + " inserted");
          if (nUpdated) parts.push(nUpdated + " updated");
          toast("Committed to " + table + " — " + parts.join(", "), "ok");
          // Re-fetch so the committed rows replace the staged ones.
          useTabMetaStore.getState().requestRefetch(tabId);
        })
        .catch((err: unknown) => {
          toast(appErrorMessage(err, "Could not save changes."), "err");
        })
        .finally(() => setSaving(false));
    },
    [handleId, schema, table, tabId, toast],
  );

  // Save (⌘S / Save button). Folds in an open (un-blurred) inline edit, then
  // either runs the batch or parks it on the production confirm.
  const save = useCallback(() => {
    // Effective staging = current state + any open inline edit, applied without
    // waiting for the async setState the blur/Enter path would do.
    let edits = pendingEdits;
    let rows = newRows;
    if (editing) {
      const { target, col: ci, draft } = editing;
      const colName = columns[ci]?.name;
      if (colName) {
        const value = coerceForColumn(draft, colMeta.get(colName));
        if (target.kind === "staged") {
          rows = rows.map((r) => {
            if (r.key !== target.stagedKey) return r;
            const values = r.values.slice();
            values[ci] = value;
            return { ...r, values };
          });
        } else {
          const row = rowCacheRef.current.get(target.rowIndex);
          const pk = row ? buildPk(row) : null;
          const key = row ? pkKeyOf(row) : null;
          if (row && pk && key) {
            const original = row[ci] ?? null;
            const revert =
              value === original ||
              (value !== null && original !== null && String(value) === String(original));
            edits = new Map(edits);
            const cells = new Map(edits.get(key)?.cells ?? []);
            if (revert) cells.delete(ci);
            else cells.set(ci, value);
            if (cells.size === 0) edits.delete(key);
            else edits.set(key, { pk, cells });
          }
        }
      }
      committingRef.current = true;
      setEditing(null);
    }
    const sql = buildBatchSql(edits, rows);
    if (!sql) return;
    const nUpdated = [...edits.values()].filter((e) => e.cells.size > 0).length;
    const nNew = rows.length;
    if (isProduction && confirmProd) {
      setSaveConfirmSql(sql);
      // Stash the counts for the confirm path.
      saveCountsRef.current = { nNew, nUpdated };
      return;
    }
    runSave(sql, nNew, nUpdated);
  }, [
    editing,
    columns,
    colMeta,
    buildPk,
    pkKeyOf,
    pendingEdits,
    newRows,
    buildBatchSql,
    isProduction,
    confirmProd,
    runSave,
  ]);

  // Counts parked alongside `saveConfirmSql` for the production-confirm path.
  const saveCountsRef = useRef<{ nNew: number; nUpdated: number }>({ nNew: 0, nUpdated: 0 });

  const discard = useCallback(() => {
    setEditing(null);
    committingRef.current = false;
    setPendingEdits(new Map());
    setNewRows([]);
  }, []);

  // Add a staged new row at the top of page 0 (prototype `addRow`).
  const addRow = useCallback(() => {
    if (columns.length === 0) return;
    // Clear filter + jump to page 0 (table tab) and sort (ours) so the new row
    // is visible at the top.
    onAddRowReset?.();
    setSort(null);
    const values: CellValue[] = columns.map((c) => {
      const m = colMeta.get(c.name);
      const affinity = affinityOf(m?.dataType ?? "");
      if (m?.pk && affinity === "integer") {
        // Auto-increment: max over the cached page + the staged rows, + 1.
        let max = 0;
        for (const row of rowCacheRef.current.values()) {
          const ci = columns.indexOf(c);
          const v = Number(row[ci]);
          if (!Number.isNaN(v) && v > max) max = v;
        }
        for (const nr of newRows) {
          const ci = columns.indexOf(c);
          const v = Number(nr.values[ci]);
          if (!Number.isNaN(v) && v > max) max = v;
        }
        return max + 1;
      }
      return parseDefault(m?.default ?? null, affinity);
    });
    stagedKeySeq.current += 1;
    setNewRows((prev) => [{ key: stagedKeySeq.current, values }, ...prev]);
  }, [columns, colMeta, newRows, onAddRowReset]);

  useImperativeHandle(ref, () => ({ addRow, save, discard }), [addRow, save, discard]);

  // ⌘I / Ctrl+I → add row; ⌘S / Ctrl+S → save. The grid is mounted only for the
  // active table tab in data mode, so a window listener is correctly scoped.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "i") {
        e.preventDefault();
        addRow();
      } else if (k === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addRow, save]);

  // --- M11 FK coexistence: defer the single-click hop ------------------
  const fkHopTimer = useRef<number | null>(null);
  const clearPendingHop = useCallback(() => {
    if (fkHopTimer.current !== null) {
      window.clearTimeout(fkHopTimer.current);
      fkHopTimer.current = null;
    }
  }, []);
  useEffect(() => () => clearPendingHop(), [clearPendingHop]);

  const isHidden = useCallback(
    (name: string) => hiddenColumns?.has(name) ?? false,
    [hiddenColumns],
  );

  // Grid column template (Bug 1).
  const gridCols = useMemo(() => {
    const widths: string[] = [];
    for (const c of columns) {
      if (isHidden(c.name)) continue;
      const typeLen = c.typeHint ? c.typeHint.length : 0;
      const headerPx =
        c.name.length * HEAD_NAME_CHAR_PX +
        typeLen * HEAD_TYPE_CHAR_PX +
        HEAD_ICON_PX +
        CELL_PAD_PX;
      let maxCellLen = 0;
      let sampled = 0;
      const ci = columns.indexOf(c);
      for (const row of rowCacheRef.current.values()) {
        const len = cellTextLength(row[ci] ?? null);
        if (len > maxCellLen) maxCellLen = len;
        if (++sampled >= WIDTH_SAMPLE_ROWS) break;
      }
      const cellPx = maxCellLen * CELL_CHAR_PX + CELL_PAD_PX;
      const w = Math.round(Math.min(COL_MAX_PX, Math.max(COL_MIN_PX, headerPx, cellPx)));
      widths.push(w + "px");
    }
    const check = hasPk ? CHECK_PX + "px " : "";
    return check + ROWNUM_PX + "px " + widths.join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, isHidden, cacheVersion, pageRowCount, offset, hasPk]);

  // --- multi-select bulk delete / export -------------------------------
  // Selection drops on any (re)fetch or page change (the row cache is rebuilt).
  useEffect(() => {
    setSelectedRows(new Set());
  }, [schema, table, filterKey, refetchNonce, offset]);

  const toggleRowSel = useCallback((rowKey: string) => {
    setSelectedRows((s) => {
      const n = new Set(s);
      if (n.has(rowKey)) n.delete(rowKey);
      else n.add(rowKey);
      return n;
    });
  }, []);
  // Select-all toggles over the rows currently loaded in the cache.
  const toggleSelectAllRows = useCallback(() => {
    setSelectedRows((s) => {
      const keys = [...rowCacheRef.current.keys()].map((i) => "r" + i);
      return s.size >= keys.length && keys.length > 0 ? new Set() : new Set(keys);
    });
  }, []);

  const deleteSelectedRows = useCallback(async () => {
    const rows: PkPredicate[][] = [];
    for (const key of selectedRows) {
      const idx = Number(key.slice(1));
      const row = rowCacheRef.current.get(idx);
      const pk = row ? buildPk(row) : null;
      if (pk) rows.push(pk);
    }
    if (!rows.length) return;
    const res = await rowsDelete(handleId, { schema, table, rows });
    toast(`Deleted ${res.deleted} row${res.deleted === 1 ? "" : "s"} from ${table}`, "ok");
    useTabMetaStore.getState().requestRefetch(tabId);
  }, [selectedRows, buildPk, handleId, schema, table, tabId, toast]);

  const exportSelectedCsv = useCallback(async () => {
    const idxs = [...selectedRows].map((k) => Number(k.slice(1))).sort((a, b) => a - b);
    if (!idxs.length) return;
    const visCols = columns.filter((c) => !isHidden(c.name));
    const esc = (v: CellValue) => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [visCols.map((c) => c.name).join(",")]
      .concat(
        idxs.map((idx) => {
          const row = rowCacheRef.current.get(idx);
          return visCols.map((c) => esc(row ? (row[columns.indexOf(c)] ?? null) : null)).join(",");
        }),
      )
      .join("\n");
    try {
      const path = await saveDialog({
        defaultPath: `${table}-selection.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await exportSave(path, csv);
      toast(`Exported ${idxs.length} row${idxs.length === 1 ? "" : "s"} to CSV`, "ok");
    } catch (e) {
      toast(appErrorMessage(e, "Could not export CSV"), "err");
    }
  }, [selectedRows, columns, isHidden, table, toast]);

  // The save bar + production-confirm modal, shared by the populated and the
  // (staged-rows-only) empty render branches.
  const saveBar =
    dirtyCount > 0 ? (
      <div className="save-bar">
        <Icon name="edit_note" size={16} style={{ color: "var(--accent)" }} />
        <span className="save-bar-count">
          {newRowCount ? newRowCount + " new" : ""}
          {newRowCount && editedRowCount ? " · " : ""}
          {editedRowCount ? editedRowCount + " edited" : ""} {dirtyCount === 1 ? "row" : "rows"}{" "}
          unsaved
        </span>
        <span className="save-bar-hint">nothing is written to the database until you save</span>
        <div style={{ flex: 1 }} />
        <Btn variant="text" small onClick={discard} disabled={saving}>
          Discard
        </Btn>
        <Btn variant="filled" small icon="save" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save · ⌘S"}
        </Btn>
      </div>
    ) : null;

  const popovers = (
    <>
      {fkPeek ? (
        <FkPeek
          handleId={handleId}
          anchor={fkPeek}
          onClose={closeFkPeek}
          onOpenInTable={onOpenInTable}
        />
      ) : null}
      {insights ? (
        <ColumnInsights
          handleId={handleId}
          schema={schema}
          table={table}
          filter={filter}
          anchor={insights}
          onClose={closeInsights}
        />
      ) : null}
      {/* Save confirm (production): the exact batch SQL the save will run. */}
      {saveConfirmSql ? (
        <Modal onClose={() => setSaveConfirmSql(null)} label="Confirm save" width={520}>
          <ModalTitle>
            <Icon name="warning" size={18} style={{ color: "#e06c75" }} /> Save changes to a
            production connection?
          </ModalTitle>
          <p className="dg-confirm-body">
            This connection points at <b>production</b>. The following batch will run in one
            transaction:
          </p>
          <code className="dg-confirm-sql">{saveConfirmSql}</code>
          <ModalActions>
            <Btn variant="text" onClick={() => setSaveConfirmSql(null)}>
              Cancel
            </Btn>
            <Btn
              variant="filled"
              onClick={() => {
                const sql = saveConfirmSql;
                const { nNew, nUpdated } = saveCountsRef.current;
                setSaveConfirmSql(null);
                runSave(sql, nNew, nUpdated);
              }}
            >
              Confirm save
            </Btn>
          </ModalActions>
        </Modal>
      ) : null}
      {cellModal?.kind === "json" ? (
        <JsonEditorModal
          schemaName={schema}
          table={table}
          column={cellModal.column}
          type={cellModal.type}
          value={cellModal.value}
          onClose={() => setCellModal(null)}
          onSave={(next) => {
            commitCellValue(cellModal.target, cellModal.col, next);
            setCellModal(null);
          }}
        />
      ) : null}
      {cellModal?.kind === "binary" ? (
        <BinaryEditorModal
          schemaName={schema}
          table={table}
          column={cellModal.column}
          type={cellModal.type}
          value={cellModal.value}
          onClose={() => setCellModal(null)}
          onSave={(next) => {
            commitCellValue(cellModal.target, cellModal.col, next);
            setCellModal(null);
          }}
        />
      ) : null}
    </>
  );

  if (initialError) {
    return (
      <div className="dg-state">
        <Icon name="error" size={28} style={{ color: "#e06c75" }} />
        <div className="dg-error">
          Could not load rows.
          <code>{initialError}</code>
        </div>
        <button
          type="button"
          className="dg-retry"
          onClick={() => useTabMetaStore.getState().requestRefetch(tabId)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (loadingInitial) {
    return (
      <div className="dg-state">
        <Icon name="table" size={28} style={{ opacity: 0.5 }} />
        <span>Loading {schema + "." + table}…</span>
      </div>
    );
  }

  // The sticky column header.
  const loadedCount = rowCacheRef.current.size;
  const allRowsSelected = hasPk && loadedCount > 0 && selectedRows.size >= loadedCount;
  const someRowsSelected = selectedRows.size > 0 && !allRowsSelected;

  const headerRow = (
    <div className="dg-header dg-row">
      {hasPk ? (
        <div className="dg-check-c dg-check-h">
          <input
            type="checkbox"
            className="dg-check"
            checked={allRowsSelected}
            ref={(el) => {
              if (el) el.indeterminate = someRowsSelected;
            }}
            onChange={toggleSelectAllRows}
            aria-label="Select all loaded rows"
          />
        </div>
      ) : null}
      <div className="dg-rownum-h">#</div>
      {columns.map((c) => {
        if (isHidden(c.name)) return null;
        const m = colMeta.get(c.name);
        const active = sort?.column === c.name;
        return (
          <div
            key={c.name}
            className="dg-th sortable"
            onClick={() => onHeaderClick(c.name)}
            title={c.typeHint ? c.name + " · " + c.typeHint : c.name}
          >
            <span className="dg-head">
              {m?.pk ? (
                <Icon
                  name="key"
                  size={12}
                  style={{ color: "var(--accent)", transform: "rotate(45deg)" }}
                />
              ) : null}
              {m?.fk ? <Icon name="link" size={12} style={{ color: "var(--text-faint)" }} /> : null}
              <span className="dg-colname">{c.name}</span>
              {c.typeHint ? <span className="dg-coltype">{c.typeHint.toLowerCase()}</span> : null}
              {active ? (
                <Icon
                  name={sort!.direction === "asc" ? "arrow_upward" : "arrow_downward"}
                  size={13}
                  style={{ color: "var(--accent)" }}
                />
              ) : null}
              <button
                type="button"
                className="insight-btn"
                title={"Insights: " + c.name}
                onClick={(e) => onInsightClick(c.name, e)}
              >
                <Icon name="monitoring" size={13} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );

  // Empty state — only when there are NO rows AND no staged new rows to show.
  if ((totalRows === 0 || rowCount === 0) && stagedShown === 0) {
    const message = filter
      ? "No rows match the filter in " + schema + "." + table
      : "Empty table — no rows in " + schema + "." + table;
    if (columns.length === 0) {
      return (
        <>
          <div className="dg-state">
            <Icon name="table_rows" size={28} style={{ opacity: 0.5 }} />
            <span>{message}</span>
          </div>
          {popovers}
        </>
      );
    }
    return (
      <>
        <div className="datagrid-wrap" ref={scrollRef}>
          <div className="dg-canvas" style={{ "--grid-cols": gridCols } as React.CSSProperties}>
            {headerRow}
          </div>
          {/* Sibling of the (wide) canvas, not a child — so it spans the
              viewport width and centers in it, not across all the columns. */}
          <div className="dg-empty-body">
            <Icon name="table_rows" size={28} style={{ opacity: 0.5 }} />
            <span>{message}</span>
          </div>
        </div>
        {saveBar}
        {popovers}
      </>
    );
  }

  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <>
      {selectedRows.size > 0 ? (
        <div className="dg-selbar">
          <span className="dg-selbar-count">{selectedRows.size} selected</span>
          <div style={{ flex: 1 }} />
          <Btn icon="download" variant="tonal" small onClick={() => void exportSelectedCsv()}>
            Export CSV
          </Btn>
          <Btn
            icon="delete"
            variant="tonal"
            small
            className="dg-selbar-del"
            onClick={() => setBulkDeleteOpen(true)}
          >
            Delete selected
          </Btn>
        </div>
      ) : null}
      <div className="datagrid-wrap" ref={scrollRef}>
        <div className="dg-canvas" style={{ "--grid-cols": gridCols } as React.CSSProperties}>
          {headerRow}

          <div
            style={{ height: totalHeight, position: "relative" }}
            data-cache-version={cacheVersion}
          >
            {virtualRows.map((vr) => {
              const isStaged = vr.index < stagedShown;
              const nr = isStaged ? newRows[vr.index] : undefined;
              const rowIndex = isStaged ? -1 : offset + (vr.index - stagedShown);
              const rowKey = isStaged ? "s" + nr!.key : "r" + rowIndex;
              const target: EditTarget = isStaged
                ? { kind: "staged", stagedKey: nr!.key }
                : { kind: "real", rowIndex };
              const row = isStaged ? nr!.values : rowCacheRef.current.get(rowIndex);
              const isSelectedRow = selected?.rowKey === rowKey;
              return (
                <div
                  key={rowKey}
                  className={
                    "dg-tr dg-row" +
                    (isSelectedRow ? " row-selected" : "") +
                    (isStaged ? " row-staged" : "")
                  }
                  style={{ height: vr.size, transform: `translateY(${vr.start}px)` }}
                >
                  {hasPk ? (
                    <div className="dg-check-c" onClick={(e) => e.stopPropagation()}>
                      {isStaged ? null : (
                        <input
                          type="checkbox"
                          className="dg-check"
                          checked={selectedRows.has(rowKey)}
                          onChange={() => toggleRowSel(rowKey)}
                          aria-label={"Select row " + (rowIndex + 1)}
                        />
                      )}
                    </div>
                  ) : null}
                  <div className="dg-rownum">{isStaged ? "✱" : rowIndex + 1}</div>
                  {columns.map((c, ci) => {
                    if (isHidden(c.name)) return null;
                    if (!row) {
                      return (
                        <div key={c.name} className="dg-td cell-loading">
                          <span className="dg-cell-skeleton" />
                        </div>
                      );
                    }
                    const isSel = isSelectedRow && selected?.col === ci;
                    const fkMeta = colMeta.get(c.name)?.fk ?? null;
                    const fk = fkMeta && fkMeta.column ? fkMeta : null;
                    const isEditing =
                      editing !== null &&
                      targetKey(editing.target) === targetKey(target) &&
                      editing.col === ci;
                    const roReason = isStaged ? null : readOnlyReason(rowIndex, ci);
                    const editable = roReason === null;
                    const edited = isStaged ? false : isRealCellEdited(rowIndex, ci);
                    const cellVal = isStaged ? (row[ci] ?? null) : realCellValue(rowIndex, ci);
                    const json = isJsonType(c.typeHint);
                    const bin = isBinaryType(c.typeHint);
                    return (
                      <div
                        key={c.name}
                        className={
                          "dg-td" +
                          (isSel ? " cell-selected" : "") +
                          (isEditing ? " cell-editing" : "") +
                          (edited ? " cell-edited" : "")
                        }
                        title={roReason ?? undefined}
                        onClick={() => setSelected({ rowKey, col: ci })}
                        onDoubleClick={() => {
                          clearPendingHop();
                          if (editable && json) openCellModal("json", target, ci, c);
                          else if (editable && bin) openCellModal("binary", target, ci, c);
                          else if (editable) startEdit(target, ci);
                        }}
                      >
                        {isEditing ? (
                          <input
                            ref={editInputRef}
                            className="cell-input"
                            aria-label={"Edit " + c.name}
                            value={editing.draft}
                            onChange={(e) =>
                              setEditing((prev) =>
                                prev ? { ...prev, draft: e.target.value } : prev,
                              )
                            }
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitEdit();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                          />
                        ) : (
                          <CellContent
                            value={cellVal}
                            column={c.name}
                            type={c.typeHint}
                            fk={fk}
                            onFkClick={fk ? (value, e) => onFkClick(fk, value, bin, e) : undefined}
                            onJsonClick={
                              editable && json
                                ? () => openCellModal("json", target, ci, c)
                                : undefined
                            }
                            onBinClick={
                              editable && bin
                                ? () => openCellModal("binary", target, ci, c)
                                : undefined
                            }
                          />
                        )}
                        {/* Hover copy button — copies the raw value. Especially
                            useful for read-only cells (primary keys) that can't
                            be selected/edited to grab the value for a query. */}
                        {!isEditing && cellVal !== null ? (
                          <button
                            type="button"
                            className="dg-copy"
                            title="Copy value"
                            aria-label={"Copy " + c.name + " value"}
                            onClick={(e) => {
                              e.stopPropagation();
                              copyCell(cellVal);
                            }}
                          >
                            <Icon name="content_copy" size={12} />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {saveBar}
      {popovers}
      {bulkDeleteOpen && selectedRows.size > 0 ? (
        <BulkDeleteModal
          count={selectedRows.size}
          target={table}
          noun="row"
          isProduction={isProduction}
          onConfirm={deleteSelectedRows}
          onClose={() => setBulkDeleteOpen(false)}
          onDone={() => setSelectedRows(new Set())}
        />
      ) : null}
    </>
  );
});
