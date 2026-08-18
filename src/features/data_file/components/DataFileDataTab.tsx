// Data tab (M35 Task 5) — ported from the prototype's `CsvDataTab`, with the
// engine's stackable filter builder over it.
//
// Four ways to narrow the file, which compose:
//   - the **filter builder** (`FilterPanel`, the very component the browse grid
//     uses) — stacked typed conditions, or a raw WHERE clause;
//   - the **problem-rows chip**, set here or by the Data quality tab;
//   - **full-text search** across every cell;
//   - **Mark empty cells**, which is presentation rather than filtering.
//
// Builder conditions evaluate in memory (instant, exact). A raw WHERE goes to
// the file's scratch SQLite database, which returns the matching `rowid`s — so
// the escape hatch is real SQL, not a re-implementation of it. Either way the
// result is a set of file-row indexes, and everything downstream is identical.
//
// Sorting is owned HERE, not by the grid: the file is sorted whole and then
// paged, so a header click orders the file rather than the visible page.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CellValue, QueryResult, SortSpec } from "../../../shared/api/engine";
import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Select } from "../../../shared/ui/Select";
import { useFilterShortcut } from "../../../shared/ui/useFilterShortcut";
import { useToast } from "../../../shared/ui/toastContext";
import { FilterPanel } from "../../browse/sql/components/FilterPanel";
import {
  RowInspector,
  type InspectorColumn,
  type RowCopyFormat,
} from "../../browse/sql/components/RowInspector";
import { appliedDisplaySql, emptyDraft } from "../../browse/sql/filter";
import { SqlResultGrid } from "../../workspaces/components/SqlResultGrid";
import { sortedOrder } from "../../workspaces/components/resultSort";
import type { TabFilterState } from "../../workspaces/types";
import { TYPES } from "../core";
import type { DataFileDoc } from "../doc";
import { batchSize, isEmptyBatch, quoteField, type EditBatch } from "../csvWrite";
import { evaluateDraft, filterColumns } from "../filterRows";
import { selectMatchingRows } from "../sqlSession";
import type { RowFilter } from "../state";

/** Page sizes, mirroring the browse grid's footer (`All` is the file itself). */
const PAGE_SIZES = ["50", "100", "300", "all"] as const;
const DEFAULT_PAGE_SIZE = "100";

interface DataFileDataTabProps {
  doc: DataFileDoc;
  /** The scratch database's handle — raw-WHERE mode queries it. */
  handleId: string;
  /**
   * True while this is the visible tab. The workspace keeps the other tabs
   * mounted, so ⌘F must be gated on it or it would open this panel from the
   * Profile / Quality / SQL tabs, where it cannot be seen.
   */
  active: boolean;
  hidden: Set<string>;
  rowFilter: RowFilter | null;
  /** Set (or clear, with null) the problem-rows chip. */
  onRowFilter: (filter: RowFilter | null) => void;
  /** Filter builder state, or null until the panel is first opened. */
  filter: TabFilterState | null;
  filterOpen: boolean;
  filterError: string | null;
  sort: SortSpec | null;
  pendingSort: SortSpec | null;
  /** Persist any of the above (the store owns them across workspace switches). */
  onPatch: (patch: {
    filter?: TabFilterState | null;
    filterOpen?: boolean;
    filterError?: string | null;
    sort?: SortSpec | null;
    pendingSort?: SortSpec | null;
  }) => void;
  /** Open the SQL tab loaded with the panel's generated query. */
  onOpenSql: (sql: string) => void;

  // --- staged editing ----------------------------------------------------
  /** The uncommitted batch. Nothing in it has touched the disk. */
  edits: EditBatch;
  /** Stage one cell. `row` is a file row index, or `-key` for a staged row. */
  onEditCell: (row: number, col: number, value: string, original: string) => void;
  /** Stage a new empty row at the end of the file. */
  onAddRow: () => void;
  /** Toggle deletion for the given file rows (or drop staged ones). */
  onToggleDeleted: (rows: number[]) => void;
  /** Throw the batch away. */
  onDiscard: () => void;
  /** Overwrite the open file. Absent when it has no path (a sample). */
  onSave: (() => void) | null;
  /** Write the edited result to a new file. */
  onSaveCopy: () => void;
  /** True while a save is in flight (buttons disable, nothing is lost). */
  saving: boolean;
}

export function DataFileDataTab({
  doc,
  handleId,
  active,
  hidden,
  rowFilter,
  onRowFilter,
  filter,
  filterOpen,
  filterError,
  sort,
  pendingSort,
  onPatch,
  onOpenSql,
  edits,
  onEditCell,
  onAddRow,
  onToggleDeleted,
  onDiscard,
  onSave,
  onSaveCopy,
  saving,
}: DataFileDataTabProps) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [pageSize, setPageSize] = useState<string>(DEFAULT_PAGE_SIZE);
  const [markEmpty, setMarkEmpty] = useState(true);
  // Row indexes matched by a RAW WHERE clause. Only raw mode is async, so this
  // is null whenever the builder is driving (which resolves synchronously).
  const [rawRows, setRawRows] = useState<number[] | null>(null);

  const columnInfos = useMemo(() => filterColumns(doc.analysis.cols), [doc]);
  const applied = filter?.applied ?? null;
  const appliedWhere = useMemo(
    () => appliedDisplaySql(applied, columnInfos),
    [applied, columnInfos],
  );
  const hasApplied = appliedWhere !== "";

  // Builder-mode matches, recomputed synchronously whenever the applied filter
  // or the file changes. null = no effective filter (show everything).
  const builderRows = useMemo(() => {
    if (!applied || applied.rawMode) return null;
    return evaluateDraft(applied, doc.analysis.cols, doc.objects);
  }, [applied, doc]);

  // Raw-mode matches come from the scratch database. The request is tagged so a
  // slow reply from a superseded clause cannot overwrite a newer result.
  const rawSeq = useRef(0);
  const rawClause = applied?.rawMode ? applied.rawSql.trim() : "";
  useEffect(() => {
    if (rawClause === "") {
      setRawRows(null);
      return;
    }
    const seq = ++rawSeq.current;
    selectMatchingRows(handleId, doc.table, rawClause, doc.parsed.rows.length)
      .then((rows) => {
        if (seq !== rawSeq.current) return;
        setRawRows(rows);
        onPatch({ filterError: null });
      })
      .catch((error: unknown) => {
        if (seq !== rawSeq.current) return;
        // Keep the previous rows on screen and say why the new clause failed —
        // silently showing the whole file would look like the filter worked.
        onPatch({ filterError: appErrorMessage(error, "That WHERE clause could not be run.") });
      });
    // `onPatch` is a fresh closure each render; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, doc, rawClause]);

  // Visible columns, in file order. A hidden column leaves the grid but stays
  // in the profile — hiding is about reading the table, not about the data.
  const columns = useMemo(
    () => doc.analysis.cols.filter((c) => !hidden.has(c.name)),
    [doc, hidden],
  );

  // Every row implicated in any finding: ragged, off-type, or duplicated.
  const problem = useMemo(() => {
    const s = new Set<number>();
    for (const r of doc.parsed.ragged) s.add(r.row);
    for (const c of doc.analysis.cols) for (const ri of c.bad) s.add(ri);
    for (const d of doc.analysis.dups) s.add(d.row);
    return s;
  }, [doc]);

  // Row indexes surviving every narrowing, in display order.
  const order = useMemo(() => {
    const matched = applied?.rawMode ? rawRows : builderRows;
    const matchedSet = matched === null ? null : new Set(matched);
    const chipSet = rowFilter ? new Set(rowFilter.rows) : null;
    const needle = q.trim().toLowerCase();
    let idx: number[] = [];
    for (let i = 0; i < doc.parsed.rows.length; i++) {
      if (matchedSet && !matchedSet.has(i)) continue;
      if (chipSet && !chipSet.has(i)) continue;
      if (needle) {
        const row = doc.parsed.rows[i]!;
        if (!row.some((v) => v !== null && v.toLowerCase().includes(needle))) continue;
      }
      idx.push(i);
    }
    if (sort) {
      const col = doc.analysis.cols.find((c) => c.name === sort.column);
      if (col) {
        // Sort the coerced values, so a numeric column orders numerically.
        const values = idx.map((i) => [doc.objects[i]?.[col.name] ?? null] as CellValue[]);
        idx = sortedOrder(values, 0, sort.direction).map((k) => idx[k]!);
      }
    }
    return idx;
  }, [doc, q, sort, rowFilter, applied, builderRows, rawRows]);

  // The pager window, tagged with everything that changes which rows exist.
  // Any of them implicitly rewinds to page 1 — derived at render rather than
  // reset from an effect, which would cost an extra render pass.
  const [window_, setWindow] = useState({ key: "", offset: 0 });
  const windowKey = q + " " + (rowFilter?.label ?? "") + " " + appliedWhere;
  const offset = window_.key === windowKey ? window_.offset : 0;
  const setOffset = (next: number) => setWindow({ key: windowKey, offset: next });

  const size = pageSize === "all" ? order.length : Number(pageSize);

  /**
   * One row's visible cells, in column order — shared by the page and export.
   *
   * A STAGED value wins over the file's: the grid must show what you typed, not
   * what is still on disk. `i < 0` addresses a staged new row by `-key`.
   */
  const cellsOf = useCallback(
    (i: number): CellValue[] => {
      if (i < 0) {
        const staged = edits.added.find((r) => r.key === -i);
        return columns.map((c) => staged?.cells[c.index] ?? "");
      }
      const rowEdits = edits.cells[i];
      return columns.map((c) => {
        const edited = rowEdits?.[c.index];
        if (edited !== undefined) return edited;
        const v = doc.objects[i]?.[c.name] ?? null;
        // "Mark empty cells" off replaces nulls with blanks, so a sparse file
        // reads as a table rather than as a wall of `null`.
        return v === null && !markEmpty ? "" : v;
      });
    },
    [columns, doc, markEmpty, edits],
  );

  // Every filtered row, in display order — what "Export all CSV" writes. The
  // grid itself only ever receives the current page, so without this the button
  // would quietly export one page and call it all.
  const exportRows = useMemo(() => order.map(cellsOf), [order, cellsOf]);

  /**
   * The rows the grid shows, as file-row indexes — staged NEW rows first (they
   * have no position in the file yet, and burying them on the last page would
   * hide the thing you just added), then the current page of the file.
   *
   * A grid row index is a position in THIS array, which is what maps a commit
   * back to a file row.
   */
  const pageRows = useMemo(() => {
    const page = pageSize === "all" ? order : order.slice(offset, offset + size);
    const stagedKeys = edits.added.map((r) => -r.key);
    // Only atop the first page, so paging back and forth does not repeat them.
    return offset === 0 ? [...stagedKeys, ...page] : page;
  }, [order, offset, size, pageSize, edits.added]);

  // The grid speaks QueryResult, exactly as it does for a real query.
  const result: QueryResult = useMemo(
    () => ({
      columns: columns.map((c) => ({ name: c.name, typeHint: TYPES[c.type].sql })),
      rows: pageRows.map(cellsOf),
      rowCount: pageRows.length,
      truncated: false,
      elapsedMs: doc.parsed.ms,
    }),
    [columns, cellsOf, doc, pageRows],
  );

  // Which grid rows/cells wear the staged highlights. Keyed by GRID position,
  // because that is the vocabulary the grid reports and renders in.
  const deletedSet = useMemo(() => new Set(edits.deleted), [edits.deleted]);
  const gridEditing = useMemo(() => {
    const dirty = new Set<string>();
    const stagedRows = new Set<number>();
    const deletedRows = new Set<number>();
    pageRows.forEach((fileRow, gridRow) => {
      if (fileRow < 0) {
        stagedRows.add(gridRow);
        return;
      }
      if (deletedSet.has(fileRow)) deletedRows.add(gridRow);
      const rowEdits = edits.cells[fileRow];
      if (!rowEdits) return;
      columns.forEach((c, gridCol) => {
        if (rowEdits[c.index] !== undefined) dirty.add(gridRow + ":" + gridCol);
      });
    });
    return {
      dirty,
      stagedRows,
      deletedRows,
      onCommit: (gridRow: number, gridCol: number, value: string) => {
        const fileRow = pageRows[gridRow];
        const col = columns[gridCol];
        if (fileRow === undefined || !col) return;
        // The ORIGINAL is the file's own cell text; typing it back clears the
        // edit, which also restores that field's exact bytes on save (the
        // writer copies untouched fields verbatim).
        const original = fileRow < 0 ? "" : (doc.parsed.rows[fileRow]?.[col.index] ?? "");
        onEditCell(fileRow, col.index, value, original);
      },
    };
  }, [pageRows, columns, edits.cells, deletedSet, doc, onEditCell]);

  const from = order.length === 0 ? 0 : offset + 1;
  const to = Math.min(offset + size, order.length);

  // The panel needs a state object from the first render it is shown on.
  const firstColumn = doc.analysis.cols[0]?.name ?? "";
  const filterState: TabFilterState = filter ?? {
    draft: emptyDraft(firstColumn),
    applied: null,
  };
  const openPanel = () => {
    onPatch({ filterOpen: !filterOpen, filter: filter ?? filterState });
  };
  // ⌘F / Ctrl+F toggles the panel, matching the SQL and Cassandra browsers.
  // The panel focuses its own value field when `open` flips.
  useFilterShortcut(active, openPanel);

  // --- row inspector -----------------------------------------------------
  // The browse grid's drawer, reused verbatim: it is entirely prop-driven, so a
  // file row inspects exactly like a table row. `inspect` is a position in
  // `pageRows` (the grid's own vocabulary); null when the drawer is closed.
  const [inspect, setInspect] = useState<{ row: number; col: number | null } | null>(null);
  // True while the drawer holds drafts the user has not staged yet. Clicking
  // another cell then only moves the selection, instead of re-targeting the
  // drawer and throwing that typing away — the browse grid's rule.
  const [inspectDirty, setInspectDirty] = useState(false);
  const openInspector = (row: number, col: number | null) => setInspect({ row, col });
  // No effect is needed to close it when a page or filter change moves the row
  // out of range: `inspectValues` goes null and `open` follows, so the drawer
  // hides itself and reappears if the row comes back.

  const inspectorColumns: InspectorColumn[] = useMemo(
    () =>
      columns.map((c) => ({
        name: c.name,
        type: TYPES[c.type].sql,
        // A delimited file has no key and no references, so neither flag is
        // ever set. `pk` is not cosmetic here: the drawer renders a pk field as
        // a locked, READ-ONLY value, so claiming one makes that column
        // uneditable.
        pk: false,
        fk: false,
      })),
    [columns],
  );
  const inspectFileRow = inspect ? pageRows[inspect.row] : undefined;
  const inspectValues = inspect && inspectFileRow !== undefined ? cellsOf(inspectFileRow) : null;

  // ⌘E toggles the drawer on the first visible row, matching the browse grid.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "e") return;
      e.preventDefault();
      setInspect((cur) => (cur ? null : pageRows.length ? { row: 0, col: null } : null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, pageRows.length]);

  /** One inspected row as text, in the shapes the drawer's copy menu offers. */
  const copyRow = (format: RowCopyFormat, values: CellValue[]) => {
    const names = columns.map((c) => c.name);
    const cell = (v: CellValue) => (v === null ? "" : String(v));
    const text =
      format === "json"
        ? JSON.stringify(Object.fromEntries(names.map((n, i) => [n, values[i] ?? null])), null, 2)
        : format === "sql"
          ? "INSERT INTO " +
            doc.table +
            " (" +
            names.join(", ") +
            ") VALUES (" +
            values
              .map((v) => (v === null ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'"))
              .join(", ") +
            ");"
          : format === "values"
            ? values.map(cell).join("\n")
            : names.join(",") +
              "\n" +
              values.map((v) => quoteField(cell(v), doc.parsed.opts)).join(",");
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(
        () => toast("Row copied", "ok"),
        () => toast("Couldn't copy to clipboard", "err"),
      );
    } else {
      toast("Couldn't copy to clipboard", "err");
    }
  };

  // What is staged, in words — the save bar's headline.
  const counts = batchSize(edits);
  const pending = !isEmptyBatch(edits);
  const pendingLabel = [
    counts.edited ? counts.edited + " edited row" + (counts.edited === 1 ? "" : "s") : "",
    counts.added ? counts.added + " new row" + (counts.added === 1 ? "" : "s") : "",
    counts.deleted ? counts.deleted + " deleted row" + (counts.deleted === 1 ? "" : "s") : "",
  ]
    .filter(Boolean)
    .join(", ");

  // Staged rows ride atop page 0, so adding one from a later page has to bring
  // the user back there — otherwise the row appears to have gone nowhere.
  const addRowHere = () => {
    setOffset(0);
    onAddRow();
  };

  // ⌘I adds a row and ⌘S saves, matching the browse grid's editing shortcuts.
  // Both only while this tab is on screen.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "i") {
        e.preventDefault();
        addRowHere();
      } else if (key === "s" && pending && onSave && !saving) {
        e.preventDefault();
        onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pending, onSave, onAddRow, saving]);
  const clearFilters = () => {
    setRawRows(null);
    onPatch({
      filter: { draft: emptyDraft(firstColumn), applied: null },
      filterError: null,
      sort: null,
      pendingSort: null,
    });
  };

  return (
    <div className="csvv-pane" data-screen-label={"Data file: " + doc.name}>
      <div className="csvv-bar">
        {/* Filters toggle — same affordance and accent dot as the browse grid. */}
        <button
          type="button"
          className={
            "filter-toggle" + (filterOpen ? " open" : "") + (hasApplied ? " has-applied" : "")
          }
          onClick={openPanel}
          aria-expanded={filterOpen}
        >
          <Icon name="filter_list" size={15} /> Filters
          {hasApplied ? <span className="filter-dot" /> : null}
          <Icon name="expand_more" size={14} style={{ color: "var(--text-faint)" }} />
        </button>

        {hasApplied ? (
          <IconBtn icon="filter_alt_off" title="Clear filters" onClick={clearFilters} />
        ) : null}

        <div className="csvv-search">
          <Icon name="search" size={14} style={{ color: "var(--text-faint)" }} />
          <input
            placeholder={"Search all " + doc.parsed.rows.length.toLocaleString() + " rows…"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
          />
          {q ? <IconBtn icon="close" title="Clear" onClick={() => setQ("")} size={14} /> : null}
        </div>

        {rowFilter ? (
          <button
            type="button"
            className="csvv-chip active"
            onClick={() => onRowFilter(null)}
            title="Clear this filter"
          >
            <Icon name="filter_alt" size={12} />
            <span>{rowFilter.label}</span>
            <Icon name="close" size={12} />
          </button>
        ) : problem.size ? (
          <button
            type="button"
            className="csvv-chip"
            onClick={() =>
              onRowFilter({
                label: problem.size + " problem row" + (problem.size === 1 ? "" : "s"),
                rows: [...problem],
              })
            }
          >
            <Icon name="report" size={12} />
            <span>
              {problem.size} problem row{problem.size === 1 ? "" : "s"}
            </span>
          </button>
        ) : null}

        <div style={{ flex: 1 }} />
        <Btn
          icon="add"
          variant="text"
          small
          onClick={addRowHere}
          title="Add a row to the end of the file (⌘I)"
        >
          Add row
        </Btn>
        <label className="csvv-toggle">
          <input
            type="checkbox"
            checked={markEmpty}
            onChange={(e) => setMarkEmpty(e.target.checked)}
          />
          Mark empty cells
        </label>
        <span className="csvv-bar-dim">
          {hidden.size ? hidden.size + " hidden" : columns.length + " columns"}
        </span>
      </div>

      {/* The engine's own builder. Its generated-query preview is truthful
          here: the same table really is queryable from the SQL tab. */}
      <FilterPanel
        open={filterOpen}
        columns={columnInfos}
        state={filterState}
        error={filterError}
        onChange={(next) => onPatch({ filter: next })}
        onClose={() => onPatch({ filterOpen: false })}
        tableName={doc.table}
        schemaName=""
        sort={sort}
        onSetSort={(next) => onPatch({ sort: next })}
        pendingSort={pendingSort}
        onSetPendingSort={(next) => onPatch({ pendingSort: next })}
        pageSize={pageSize === "all" ? 0 : Number(pageSize)}
        onOpenSql={onOpenSql}
        selectCols={columns.map((c) => c.name)}
      />

      <SqlResultGrid
        result={result}
        sort={sort}
        onSort={(next) => onPatch({ sort: next, pendingSort: next })}
        exportName={doc.table + ".csv"}
        allRows={exportRows}
        editing={gridEditing}
        inspecting={{
          onOpen: openInspector,
          openRow: inspect?.row ?? null,
          dirty: inspectDirty,
        }}
        selectionActions={(sel) =>
          sel.length === 0 ? null : (
            <Btn
              icon="delete"
              variant="text"
              small
              onClick={() =>
                onToggleDeleted(sel.map((g) => pageRows[g]!).filter((r) => r !== undefined))
              }
            >
              {sel.some((g) => deletedSet.has(pageRows[g] ?? -1))
                ? "Restore " + sel.length
                : "Delete " + sel.length}
            </Btn>
          )
        }
      />

      {/* Staged-changes bar — the engines' `.save-bar`, pinned above the footer.
          Nothing has been written while this is on screen. */}
      {pending ? (
        <div className="save-bar">
          <Icon name="edit_note" size={15} style={{ color: "var(--accent)" }} />
          <span className="save-bar-count">{pendingLabel}</span>
          <span className="save-bar-hint">not saved yet — the file on disk is unchanged</span>
          <div style={{ flex: 1 }} />
          <Btn variant="text" small disabled={saving} onClick={onDiscard}>
            Discard
          </Btn>
          <Btn icon="file_copy" variant="tonal" small disabled={saving} onClick={onSaveCopy}>
            Save a copy
          </Btn>
          <Btn
            icon="save"
            variant="filled"
            small
            disabled={saving || !onSave}
            title={
              onSave
                ? "Overwrite " + doc.name + " (⌘S)"
                : "This sample has no file on disk — use Save a copy"
            }
            onClick={() => onSave?.()}
          >
            {saving ? "Saving…" : "Save"}
          </Btn>
        </div>
      ) : null}

      <div className="table-footer">
        <span className="table-hint">
          {doc.name} · double-click a cell to edit · click a header to sort the whole file · stack
          under Filters
        </span>
        <div className="pager">
          <span className="pager-label" id="csvv-pager-label">
            Rows per page
          </span>
          <Select
            className="pager-size"
            placement="up"
            aria-labelledby="csvv-pager-label"
            value={pageSize}
            options={PAGE_SIZES.map((n) => ({ value: n, label: n === "all" ? "All" : n }))}
            onChange={(v) => {
              setPageSize(v);
              setOffset(0);
            }}
          />
          <span className="pager-range">
            {from.toLocaleString()}–{to.toLocaleString()} of {order.length.toLocaleString()}
          </span>
          <IconBtn
            icon="chevron_left"
            title="Previous page"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - size))}
          />
          <IconBtn
            icon="chevron_right"
            title="Next page"
            disabled={offset + size >= order.length}
            onClick={() => setOffset(offset + size < order.length ? offset + size : offset)}
          />
        </div>
      </div>

      {/* The browse grid's row drawer, over a file. Edits made here are STAGED
          through the same path as an inline edit — `onStage` hands back the
          changed columns, which become entries in the pending batch. */}
      <RowInspector
        open={inspect !== null && inspectValues !== null}
        columns={inspectorColumns}
        values={inspectValues}
        rowId={String(inspectFileRow ?? "")}
        focusColumn={inspect?.col ?? null}
        isStagedNew={(inspectFileRow ?? 0) < 0}
        pkLabel={
          inspectFileRow !== undefined && inspectFileRow >= 0
            ? "row " + (inspectFileRow + 1)
            : "new row"
        }
        position={(inspect?.row ?? 0) + 1}
        total={pageRows.length}
        canPrev={(inspect?.row ?? 0) > 0}
        canNext={(inspect?.row ?? 0) < pageRows.length - 1}
        schemaName={doc.name}
        tableName={doc.table}
        onPrev={() => setInspect((c) => (c ? { ...c, row: c.row - 1 } : c))}
        onNext={() => setInspect((c) => (c ? { ...c, row: c.row + 1 } : c))}
        onClose={() => setInspect(null)}
        /* No onRefresh: a file's rows are already in memory, so there is
           nothing to re-read — the drawer omits the button entirely. */
        onCopyRow={copyRow}
        onStage={(changes) => {
          if (inspectFileRow === undefined) return;
          for (const [gridCol, value] of changes) {
            const col = columns[gridCol];
            if (!col) continue;
            const original =
              inspectFileRow < 0 ? "" : (doc.parsed.rows[inspectFileRow]?.[col.index] ?? "");
            onEditCell(inspectFileRow, col.index, value === null ? "" : String(value), original);
          }
        }}
        onDirtyChange={setInspectDirty}
      />
    </div>
  );
}
