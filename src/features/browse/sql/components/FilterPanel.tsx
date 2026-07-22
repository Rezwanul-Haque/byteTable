// Stackable filter builder panel (spec §3.5, MILESTONES M5) — ported markup +
// behavior from the prototype's `filters.jsx` FilterBuilder, wired to the real
// backend filter (Task 1) and the per-tab filter store (workspace `ui`).
//
// DRAFT vs APPLIED (see types.ts TabFilterState): the panel edits a `draft`;
// the grid fetches with `applied`. Apply commits draft→applied. Enabling/
// disabling a row re-applies IMMEDIATELY (§3.5); column/operator/value edits
// only mutate the draft (a dirty state) until Apply or Enter. The committed
// draft is deep-cloned into `applied` so later draft edits don't leak in.

import { useState } from "react";

import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import type { ColumnInfo, FilterOp, SortSpec } from "../../../../shared/api/engine";
import type { FilterDraft, TabFilterState, UiCondition } from "../../../workspaces/types";
import { highlightSql } from "../../shared/highlightSql";
import {
  FILTER_OPS,
  activeConditionCount,
  draftToDisplaySql,
  emptyDraft,
  newCondition,
  opNeedsValue,
} from "../filter";
import "./FilterPanel.css";

/** Deep-clone a draft so applied and draft never share condition objects. */
function cloneDraft(d: FilterDraft): FilterDraft {
  return {
    conditions: d.conditions.map((c) => ({ ...c })),
    combinator: d.combinator,
    rawMode: d.rawMode,
    rawSql: d.rawSql,
  };
}

const NUMERIC_RE = /INT|NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT/;

interface FilterPanelProps {
  /** Whether the panel is shown (Filters toggle). */
  open: boolean;
  /** The tab's table columns (for the column select + value typing). */
  columns: ColumnInfo[];
  /** Current per-tab filter state (draft + applied). */
  state: TabFilterState;
  /** Inline error from the last apply (raw-mode §5 backend error). */
  error: string | null;
  /** Persist a new filter state (draft and/or applied) for the tab. */
  onChange: (next: TabFilterState) => void;
  /** Close the panel (removing the last condition closes rather than resets). */
  onClose?: () => void;
  /** Table + schema for the generated-query preview's FROM clause. */
  tableName: string;
  schemaName: string;
  /** Applied grid sort — drives the dirty state (staged vs applied). */
  sort: SortSpec | null;
  /** Commit a new sort to the grid (also resets paging). Called from Apply. */
  onSetSort: (sort: SortSpec | null) => void;
  /** Staged ORDER BY (persisted live so it survives a tab switch). */
  pendingSort: SortSpec | null;
  /** Persist a change to the staged ORDER BY (does not touch the grid). */
  onSetPendingSort: (sort: SortSpec | null) => void;
  /** Current page size — shown as `LIMIT n` in the preview only. */
  pageSize: number;
  /** Open the generated query in a new SQL tab. */
  onOpenSql: (sql: string) => void;
  /** Currently-visible column names (drives the preview's SELECT list). */
  selectCols: string[];
}

export function FilterPanel({
  open,
  columns,
  state,
  error,
  onChange,
  onClose,
  tableName,
  schemaName,
  sort,
  onSetSort,
  pendingSort,
  onSetPendingSort,
  pageSize,
  onOpenSql,
  selectCols,
}: FilterPanelProps) {
  const { draft } = state;
  const firstColumn = columns[0]?.name ?? "";
  const toast = useToast();

  // "Show query" preview toggle. The staged ORDER BY (`pendingSort`) is owned by
  // the tab and persisted, so it survives a tab switch; changing it does NOT
  // re-sort the grid until Apply commits it via onSetSort.
  const [showSql, setShowSql] = useState(false);

  // Commit the draft into applied (Apply / immediate re-apply on toggle) and
  // commit the staged sort to the grid in the same step.
  const apply = (nextDraft: FilterDraft, sortToCommit: SortSpec | null = pendingSort) => {
    onSetSort(sortToCommit);
    onChange({ draft: nextDraft, applied: cloneDraft(nextDraft) });
  };
  // Mutate the draft only (dirty until Apply/Enter).
  const setDraft = (nextDraft: FilterDraft) => {
    onChange({ ...state, draft: nextDraft });
  };

  const updateCond = (id: string, patch: Partial<UiCondition>, reapply: boolean) => {
    const conditions = draft.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c));
    const next = { ...draft, conditions };
    if (reapply) apply(next);
    else setDraft(next);
  };

  const removeCond = (id: string) => {
    const filtered = draft.conditions.filter((c) => c.id !== id);
    if (filtered.length === 0) {
      // Removing the last row clears the filter and closes the panel.
      apply(emptyDraft(firstColumn));
      onClose?.();
      return;
    }
    // Removing a row changes the effective filter — re-apply (prototype).
    apply({ ...draft, conditions: filtered });
  };

  const addCond = () => {
    setDraft({ ...draft, conditions: [...draft.conditions, newCondition(firstColumn)] });
  };

  const clearAll = () => {
    // Reset conditions/raw AND the staged + applied sort, so both the grid order
    // and the preview drop back to bare `SELECT … FROM …;`.
    onSetPendingSort(null);
    apply(emptyDraft(firstColumn), null);
  };

  const switchMode = () => {
    if (draft.rawMode) {
      // Back to builder — keep the conditions as they were.
      setDraft({ ...draft, rawMode: false });
    } else {
      // To raw — pre-fill the input from the built conditions (cosmetic SQL).
      setDraft({ ...draft, rawMode: true, rawSql: draftToDisplaySql(draft, columns) });
    }
  };

  // Dirty = the draft would compile differently from what is applied, OR the
  // staged ORDER BY differs from the applied grid sort. Compare the cosmetic
  // display SQL of each (matching the prototype's `pending`).
  const appliedSql = state.applied ? draftToDisplaySql(state.applied, columns) : "";
  const draftSql = draftToDisplaySql(draft, columns);
  const sortKey = (s: SortSpec | null) => (s ? `${s.column} ${s.direction}` : "");
  const dirty = draftSql !== appliedSql || sortKey(pendingSort) !== sortKey(sort);

  const activeCount = activeConditionCount(draft.conditions);
  const total = draft.conditions.length;

  // Generated-query preview (§ Task 2/3/4). SELECT follows the visible columns
  // (`*` only when all are shown); ORDER BY / LIMIT reflect the staged sort and
  // the current page size live.
  const qualified = (schemaName ? schemaName + "." : "") + (tableName || "table");
  const previewWhere = draftToDisplaySql(draft, columns);
  const orderClause = pendingSort
    ? `\nORDER BY ${pendingSort.column} ${pendingSort.direction === "desc" ? "DESC" : "ASC"}`
    : "";
  const limitClause = pageSize ? `\nLIMIT ${pageSize}` : "";
  const allCols = columns.map((c) => c.name);
  const visible = selectCols.length ? selectCols : allCols;
  const selectList = visible.length === allCols.length ? "*" : visible.join(", ");
  const previewSql =
    `SELECT ${selectList}\nFROM ${qualified}` +
    (previewWhere ? `\nWHERE ${previewWhere}` : "") +
    orderClause +
    limitClause +
    ";";
  const previewHtml = highlightSql(previewSql);
  const copyPreview = () => {
    // Clipboard API with a no-throw fallback (unavailable in some webviews);
    // confirm with a toast either way, like the app's other copy actions.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(previewSql).then(
        () => toast("Query copied", "ok"),
        () => toast("Couldn't copy to clipboard", "err"),
      );
    } else {
      toast("Couldn't copy to clipboard", "err");
    }
  };

  return (
    <div className={"filter-panel" + (open ? "" : " hidden")}>
      {draft.rawMode ? (
        <div className="filter-raw-row">
          <span className="where-label">WHERE</span>
          <input
            className={"where-input" + (error ? " error" : "") + (state.applied ? " applied" : "")}
            placeholder="status = 'paid' AND (total > 100 OR country IN ('DE', 'FR'))"
            value={draft.rawSql}
            onChange={(e) => setDraft({ ...draft, rawSql: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply(draft);
            }}
            spellCheck={false}
            aria-label="Raw WHERE clause"
          />
        </div>
      ) : (
        <div className="filter-rows">
          {draft.conditions.map((c, i) => {
            const colType = (
              columns.find((col) => col.name === c.column)?.dataType ?? ""
            ).toUpperCase();
            const numeric = NUMERIC_RE.test(colType);
            return (
              <div className={"filter-row" + (c.enabled ? "" : " disabled")} key={c.id}>
                <span className="filter-and">
                  {i === 0 ? "WHERE" : draft.combinator.toUpperCase()}
                </span>
                <label
                  className="filter-check"
                  title={
                    c.enabled
                      ? "Condition is active — uncheck to skip it"
                      : "Condition is skipped — check to apply it"
                  }
                >
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={(e) => updateCond(c.id, { enabled: e.target.checked }, true)}
                  />
                  <span className={"filter-checkbox" + (c.enabled ? " on" : "")}>
                    {c.enabled ? <Icon name="check" size={12} /> : null}
                  </span>
                </label>
                <Select
                  className="filter-select"
                  aria-label="Column"
                  value={c.column}
                  options={columns.map((col) => ({ value: col.name, label: col.name }))}
                  onChange={(v) => updateCond(c.id, { column: v }, false)}
                />
                <Select
                  className="filter-select filter-op"
                  aria-label="Operator"
                  value={c.op}
                  options={FILTER_OPS.map((o) => ({ value: o.op, label: o.label }))}
                  onChange={(v) => updateCond(c.id, { op: v as FilterOp }, false)}
                />
                {opNeedsValue(c.op) ? (
                  <input
                    className="filter-value"
                    type={numeric && c.op !== "inList" ? "number" : "text"}
                    placeholder={c.op === "inList" ? "value, value, value" : "value…"}
                    value={c.value}
                    onChange={(e) => updateCond(c.id, { value: e.target.value }, false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") apply(draft);
                    }}
                    spellCheck={false}
                    aria-label="Value"
                  />
                ) : (
                  <span className="filter-novalue" />
                )}
                <button
                  type="button"
                  className="saved-del"
                  title="Remove condition"
                  onClick={() => removeCond(c.id)}
                  aria-label="Remove condition"
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="filter-foot">
        {draft.rawMode ? null : (
          <button type="button" className="filter-add" onClick={addCond}>
            <Icon name="add" size={14} /> Add condition
          </button>
        )}
        <button type="button" className="filter-rawtoggle" onClick={switchMode}>
          <Icon name={draft.rawMode ? "tune" : "code"} size={13} />
          {draft.rawMode ? "Use builder" : "Edit as SQL"}
        </button>
        <button
          type="button"
          className={"filter-rawtoggle" + (showSql ? " on" : "")}
          onClick={() => setShowSql((s) => !s)}
          title="Preview the generated query"
        >
          <Icon name="preview" size={13} />
          {showSql ? "Hide query" : "Show query"}
        </button>
        <div className="filter-orderlimit">
          <Icon name="swap_vert" size={13} style={{ color: "var(--text-faint)" }} />
          <Select
            className="filter-select filter-ol-col"
            aria-label="Order by column"
            value={pendingSort?.column ?? ""}
            options={[
              { value: "", label: "no order" },
              ...columns.map((col) => ({ value: col.name, label: col.name })),
            ]}
            onChange={(v) =>
              onSetPendingSort(v ? { column: v, direction: pendingSort?.direction ?? "asc" } : null)
            }
          />
          <button
            type="button"
            className="filter-ol-dir"
            disabled={!pendingSort}
            title="Toggle direction"
            onClick={() =>
              onSetPendingSort(
                pendingSort
                  ? {
                      column: pendingSort.column,
                      direction: pendingSort.direction === "desc" ? "asc" : "desc",
                    }
                  : pendingSort,
              )
            }
          >
            {pendingSort?.direction === "desc" ? "DESC" : "ASC"}
          </button>
        </div>
        <div style={{ flex: 1 }} />
        {error ? (
          <span className="filter-err-inline">
            <Icon name="error" size={13} /> {error}
          </span>
        ) : draft.rawMode ? null : (
          <span className="filter-count-note">
            {activeCount} of {total} condition{total === 1 ? "" : "s"} active
          </span>
        )}
        <Btn variant="text" small onClick={clearAll}>
          Clear
        </Btn>
        <Btn variant={dirty ? "filled" : "tonal"} icon="check" small onClick={() => apply(draft)}>
          Apply
        </Btn>
      </div>

      {/* Generated-query preview strip — highlighted SQL + Copy + Open-in-SQL. */}
      {showSql ? (
        <div className="filter-sqlpeek">
          <span className="filter-sqlpeek-label">GENERATED QUERY</span>
          <pre className="filter-sqlpeek-code" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          <button
            type="button"
            className="filter-sqlpeek-copy"
            title="Copy query"
            onClick={copyPreview}
          >
            <Icon name="content_copy" size={13} />
          </button>
          <button
            type="button"
            className="filter-sqlpeek-copy"
            title="Open in a new SQL tab"
            onClick={() => onOpenSql(previewSql)}
          >
            <Icon name="open_in_new" size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
