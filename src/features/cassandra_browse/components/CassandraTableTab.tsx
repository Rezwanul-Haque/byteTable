// Cassandra table tab (M19 §19.2, ported from cassandra-table.jsx
// CassandraTableTab): Query / Structure segmented modes; a Filters toggle that
// reveals the stacked partition-key / clustering-key / non-key condition builder
// with an ALLOW FILTERING toggle, a View-CQL preview and Clear/Apply; a
// consistency select; and a bottom limit pager. Opens with no filter applied —
// just a bounded SELECT so rows are visible. (Inline editing + row modal land in
// §19.3; the Structure surface in §19.4.)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { highlightSql } from "../../browse/shared/highlightSql";
import { isAppErrorPayload } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { BulkDeleteModal } from "../../../shared/ui/BulkDeleteModal";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Select } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import {
  cassDeleteRows,
  cassQuery,
  cassUpdateRow,
  keyColumns,
  keyMap,
  keyOf,
  type CassPredicate,
  type CassQueryResult,
  type TableDescriptor,
} from "../api";
import { csvOf, download } from "../cassIo";
import { CassRowGrid } from "./CassRowGrid";
import { CassRowModal } from "./CassRowModal";
import { CassStructure } from "./CassStructure";

const CONSISTENCY_LEVELS = ["ONE", "QUORUM", "LOCAL_ONE", "LOCAL_QUORUM", "ALL"];
const CQL_OPS = ["=", "<", "<=", ">", ">=", "IN", "CONTAINS"];

interface ClusterCond {
  col: string;
  op: string;
  val: string;
}
interface FilterCond {
  col: string;
  op: string;
  val: string;
  enabled: boolean;
}

function colType(t: TableDescriptor, name: string): string {
  return t.columns.find((c) => c.name === name)?.type ?? "text";
}

function cqlLiteral(type: string, val: string): string {
  const bt = type.replace(/<.*$/, "");
  if (val === "") return "null";
  if (
    ["int", "bigint", "smallint", "double", "float", "decimal", "counter", "boolean"].includes(bt)
  )
    return String(val);
  return "'" + String(val).replace(/'/g, "''") + "'";
}

interface CassandraTableTabProps {
  handleId: string;
  ks: string;
  descriptor: TableDescriptor;
  mode: "query" | "structure";
  isProduction: boolean;
  onModeChange: (mode: "query" | "structure") => void;
  onExport: (table: string) => void;
  onImport: (table: string) => void;
  onSchemaChanged: () => void;
}

export function CassandraTableTab({
  handleId,
  ks,
  descriptor: t,
  mode,
  isProduction,
  onModeChange,
  onExport,
  onImport,
  onSchemaChanged,
}: CassandraTableTabProps) {
  const toast = useToast();
  const tableName = t.name;
  const [pkVals, setPkVals] = useState<Record<string, string>>({});
  const [clusterConds, setClusterConds] = useState<ClusterCond[]>([]);
  const [filterConds, setFilterConds] = useState<FilterCond[]>([]);
  const [limit, setLimit] = useState(100);
  const [allowFiltering, setAllowFiltering] = useState(false);
  const [consistency, setConsistency] = useState("LOCAL_QUORUM");
  const [result, setResult] = useState<CassQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCql, setShowCql] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [rowView, setRowView] = useState<Record<string, unknown> | null>(null);
  const [newRow, setNewRow] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Cursor pagination: Cassandra has no OFFSET, so we page with the driver's
  // opaque paging-state token. `pageTokens[i]` is the token to fetch page i
  // (page 0 = null); `appliedRef` freezes the query so Next/Prev reuse it.
  const [pageTokens, setPageTokens] = useState<(string | null)[]>([null]);
  const [pageIdx, setPageIdx] = useState(0);
  const appliedRef = useRef<{
    pv: Record<string, string>;
    cc: ClusterCond[];
    fc: FilterCond[];
    lim: number;
    af: boolean;
  }>({ pv: {}, cc: [], fc: [], lim: 100, af: false });

  const regularNames = useMemo(
    () => t.columns.filter((c) => c.kind === "regular" || c.kind === "static").map((c) => c.name),
    [t],
  );

  const buildPredicates = useCallback(
    (pv: Record<string, string>, cc: ClusterCond[], fc: FilterCond[]): CassPredicate[] => {
      const w: CassPredicate[] = [];
      t.partitionKey.forEach((p) => {
        if (pv[p] !== undefined && pv[p] !== "") w.push({ col: p, op: "=", val: pv[p] });
      });
      cc.forEach((c) => {
        if (c.val !== "") w.push({ col: c.col, op: c.op, val: predVal(c.op, c.val) });
      });
      fc.forEach((c) => {
        if (c.enabled !== false && c.col && c.val !== "")
          w.push({ col: c.col, op: c.op, val: predVal(c.op, c.val) });
      });
      return w;
    },
    [t],
  );

  // Fetch one page using the frozen query (`appliedRef`) + a paging cursor.
  const fetchPage = useCallback(
    async (token: string | null, idx: number) => {
      const a = appliedRef.current;
      try {
        const r = await cassQuery(handleId, {
          keyspace: ks,
          table: tableName,
          predicates: buildPredicates(a.pv, a.cc, a.fc),
          limit: a.lim,
          allowFiltering: a.af,
          consistency,
          pagingState: token ?? undefined,
        });
        setResult(r);
        setError(null);
        setSelected(new Set());
        setPageIdx(idx);
        setPageTokens((prev) => {
          const nextArr = prev.slice(0, idx + 1);
          nextArr[idx] = token;
          if (r.nextPagingState) nextArr[idx + 1] = r.nextPagingState;
          return nextArr;
        });
      } catch (e) {
        setError(isAppErrorPayload(e) ? e.message : "Query failed (desktop app required)");
        setResult(null);
      }
    },
    [handleId, ks, tableName, buildPredicates, consistency],
  );

  // Freeze a new query and fetch page 0 (resets the cursor stack).
  const runFresh = useCallback(
    (pv: Record<string, string>, cc: ClusterCond[], fc: FilterCond[], lim: number, af: boolean) => {
      appliedRef.current = { pv, cc, fc, lim, af };
      setPageTokens([null]);
      void fetchPage(null, 0);
    },
    [fetchPage],
  );

  const runBuilder = () => runFresh(pkVals, clusterConds, filterConds, limit, allowFiltering);
  const nextPage = () => {
    const token = pageTokens[pageIdx + 1];
    if (token) void fetchPage(token, pageIdx + 1);
  };
  const prevPage = () => {
    if (pageIdx > 0) void fetchPage(pageTokens[pageIdx - 1] ?? null, pageIdx - 1);
  };

  // --- staged inline edits (M19 §19.3) ---------------------------------------
  const keyColsSet = useMemo(() => new Set(keyColumns(t)), [t]);
  const baseRows = result?.rows ?? [];
  const displayRows = baseRows.map((r) => {
    const k = keyOf(t, r);
    return edits[k] ? { ...r, ...edits[k] } : r;
  });
  const editCount = Object.values(edits).reduce((n, c) => n + Object.keys(c).length, 0);

  // --- grid multi-select bulk operations (M19) -------------------------------
  const toggleRow = (i: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const toggleAll = () =>
    setSelected((s) =>
      s.size === displayRows.length ? new Set() : new Set(displayRows.map((_, i) => i)),
    );
  const selectedRows = () =>
    [...selected].map((i) => displayRows[i]).filter(Boolean) as Record<string, unknown>[];

  const bulkDelete = async () => {
    const keys = selectedRows().map((r) => keyMap(t, r));
    const n = await cassDeleteRows(handleId, ks, tableName, keys);
    return n;
  };
  const exportSelectedCsv = () => {
    const rows = selectedRows();
    if (!rows.length) return;
    download(ks + "." + tableName + "-selection.csv", csvOf(t.columns, rows), "text/csv");
    toast("Exported " + rows.length + " row" + (rows.length === 1 ? "" : "s") + " to CSV", "ok");
  };

  const stageEdit = (row: Record<string, unknown>, col: string, value: unknown) => {
    const k = keyOf(t, row);
    setEdits((prev) => {
      const re = { ...(prev[k] ?? {}) };
      const orig = baseRows.find((x) => keyOf(t, x) === k);
      const baseVal = orig ? orig[col] : row[col];
      if (value === baseVal) delete re[col];
      else re[col] = value;
      const next = { ...prev };
      if (Object.keys(re).length) next[k] = re;
      else delete next[k];
      return next;
    });
  };
  const isCellEdited = (row: Record<string, unknown>, col: string) => {
    const k = keyOf(t, row);
    return !!(edits[k] && Object.prototype.hasOwnProperty.call(edits[k], col));
  };
  const discardEdits = () => setEdits({});
  const saveEdits = async () => {
    const entries = Object.entries(edits);
    if (!entries.length) return;
    if (
      isProduction &&
      !window.confirm(
        "Write " +
          entries.length +
          " row(s) to the production keyspace " +
          ks +
          "." +
          tableName +
          "?",
      )
    ) {
      return;
    }
    let n = 0;
    try {
      for (const [k, cols] of entries) {
        const row = baseRows.find((x) => keyOf(t, x) === k);
        if (!row) continue;
        await cassUpdateRow(handleId, ks, tableName, keyMap(t, row), cols);
        n += Object.keys(cols).length;
      }
      setEdits({});
      runBuilder();
      toast("Saved " + n + " cell" + (n === 1 ? "" : "s") + " to " + ks + "." + tableName, "ok");
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Save failed", "err");
    }
  };

  // ⌘I add row · ⌘S save staged edits (only on the visible tab).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rootRef.current || rootRef.current.offsetParent === null) return;
      if (mode === "query" && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setNewRow(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && Object.keys(edits).length) {
        e.preventDefault();
        void saveEdits();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, edits]);

  // Open with no filter applied — a bounded scan so rows are visible.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || mode !== "query") return;
    didInit.current = true;
    // Async query — setState happens after the await, off the effect body.
    runFresh({}, [], [], limit, false);
  }, [mode, limit, runFresh]);

  const previewCql = useMemo(() => {
    const where: string[] = [];
    t.partitionKey.forEach((p) => {
      if (pkVals[p]) where.push(p + " = " + cqlLiteral(colType(t, p), pkVals[p]));
    });
    clusterConds.forEach((c) => {
      if (c.val !== "") where.push(c.col + " " + c.op + " " + cqlLiteral(colType(t, c.col), c.val));
    });
    filterConds.forEach((c) => {
      if (c.enabled !== false && c.col && c.val !== "")
        where.push(c.col + " " + c.op + " " + cqlLiteral(colType(t, c.col), c.val));
    });
    let s = "SELECT * FROM " + ks + "." + tableName;
    if (where.length) s += "\n  WHERE " + where.join("\n    AND ");
    if (limit) s += "\n  LIMIT " + limit;
    if (allowFiltering) s += "\n  ALLOW FILTERING";
    return s + ";";
  }, [t, ks, tableName, pkVals, clusterConds, filterConds, limit, allowFiltering]);

  const appliedParts: string[] = [];
  t.partitionKey.forEach((p) => {
    if (pkVals[p]) appliedParts.push(p + " = " + pkVals[p]);
  });
  clusterConds.forEach((c) => {
    if (c.val !== "") appliedParts.push(c.col + " " + c.op + " " + c.val);
  });
  filterConds.forEach((c) => {
    if (c.enabled !== false && c.col && c.val !== "")
      appliedParts.push(c.col + " " + c.op + " " + c.val);
  });
  const appliedSummary = appliedParts.join(" AND ");

  return (
    <div className="table-tab" ref={rootRef}>
      <div className="table-toolbar ddb-toolbar">
        <div className="seg">
          <button
            className={"seg-btn" + (mode === "query" ? " active" : "")}
            onClick={() => onModeChange("query")}
          >
            <Icon name="filter_alt" size={14} /> Query
          </button>
          <button
            className={"seg-btn" + (mode === "structure" ? " active" : "")}
            onClick={() => onModeChange("structure")}
          >
            <Icon name="schema" size={14} /> Structure
          </button>
        </div>
        {mode !== "structure" ? (
          <>
            <button
              className={
                "filter-toggle" +
                (filtersOpen ? " open" : "") +
                (appliedSummary ? " has-applied" : "")
              }
              onClick={() => setFiltersOpen((o) => !o)}
              title="Build the CQL query — partition key, clustering and non-key filters"
            >
              <Icon name="filter_list" size={15} /> Filters
              {appliedSummary ? <span className="filter-dot" /> : null}
              <Icon
                name={filtersOpen ? "expand_less" : "expand_more"}
                size={14}
                style={{ color: "var(--text-faint)" }}
              />
            </button>
            <label className="cass-consistency" title="Consistency level">
              <Icon name="hub" size={13} />
              <select
                className="filter-select"
                value={consistency}
                onChange={(e) => setConsistency(e.target.value)}
              >
                {CONSISTENCY_LEVELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <span
              className={"applied-where" + (appliedSummary ? "" : " empty")}
              title={appliedSummary ? "WHERE " + appliedSummary : ""}
            >
              {appliedSummary ? "WHERE " + appliedSummary : "no filters applied"}
            </span>
          </>
        ) : null}
        <div style={{ flex: 1 }} />
        {mode === "query" ? (
          <IconBtn icon="add_box" title="Add row (⌘I / Ctrl+I)" onClick={() => setNewRow(true)} />
        ) : null}
        <div className="table-actions" style={{ position: "relative" }}>
          <IconBtn
            icon="more_vert"
            title="Table actions"
            active={actionsOpen}
            onClick={() => setActionsOpen((o) => !o)}
          />
          {actionsOpen ? (
            <div className="ctx-menu table-actions-menu">
              <div
                className="ctx-item"
                onClick={() => {
                  setActionsOpen(false);
                  onExport(tableName);
                }}
              >
                <Icon name="download" size={15} /> Export table…
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  setActionsOpen(false);
                  onImport(tableName);
                }}
              >
                <Icon name="upload" size={15} /> Import rows…
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {mode === "query" && filtersOpen ? (
        <div className="cass-builder">
          <div className="filter-rows cass-qb-rows">
            {t.partitionKey.map((p, pi) => (
              <div className="filter-row cass-key-row" key={p}>
                <span className="filter-and">{pi === 0 ? "WHERE" : "AND"}</span>
                <span className="cass-key-badge pk" title="Partition key">
                  PK
                </span>
                <span className="cass-key-col mg-mono">
                  {p}
                  <em>{colType(t, p)}</em>
                </span>
                <span className="cass-key-op">=</span>
                <input
                  className="filter-value mg-mono"
                  value={pkVals[p] ?? ""}
                  onChange={(e) => setPkVals({ ...pkVals, [p]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") runBuilder();
                  }}
                  placeholder="value…"
                  spellCheck={false}
                />
                {pi === 0 ? (
                  <div className="cass-qb-inline">
                    <button
                      className={"cass-qb-allow" + (allowFiltering ? " on" : "")}
                      onClick={() => setAllowFiltering((a) => !a)}
                      title="Allow non-key filtering (full scan)"
                    >
                      <Icon
                        name={allowFiltering ? "check_box" : "check_box_outline_blank"}
                        size={15}
                      />{" "}
                      Allow filtering
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            {t.clustering.map((c) => {
              const cond = clusterConds.find((x) => x.col === c.name) ?? {
                col: c.name,
                op: "=",
                val: "",
              };
              const set = (patch: Partial<ClusterCond>) =>
                setClusterConds((cs) => [
                  ...cs.filter((x) => x.col !== c.name),
                  { ...cond, ...patch },
                ]);
              return (
                <div className="filter-row cass-key-row" key={c.name}>
                  <span className="filter-and">AND</span>
                  <span className="cass-key-badge ck" title="Clustering key">
                    CK
                  </span>
                  <span className="cass-key-col mg-mono">
                    {c.name}
                    <em>{c.type}</em>
                  </span>
                  <select
                    className="filter-select filter-op cass-key-opsel"
                    value={cond.op}
                    onChange={(e) => set({ op: e.target.value })}
                  >
                    {CQL_OPS.slice(0, 5).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  <input
                    className="filter-value mg-mono"
                    value={cond.val}
                    onChange={(e) => set({ val: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") runBuilder();
                    }}
                    placeholder="value…"
                    spellCheck={false}
                  />
                </div>
              );
            })}
            {filterConds.map((fc, i) => {
              const patch = (p: Partial<FilterCond>) =>
                setFilterConds(filterConds.map((x, j) => (j === i ? { ...x, ...p } : x)));
              return (
                <div className={"filter-row" + (fc.enabled === false ? " disabled" : "")} key={i}>
                  <span className="filter-and">AND</span>
                  <label
                    className="filter-check"
                    title={
                      fc.enabled === false ? "Skipped — check to apply" : "Active — uncheck to skip"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={fc.enabled !== false}
                      onChange={(e) => patch({ enabled: e.target.checked })}
                    />
                    <span className={"filter-checkbox" + (fc.enabled !== false ? " on" : "")}>
                      {fc.enabled !== false ? <Icon name="check" size={12} /> : null}
                    </span>
                  </label>
                  <select
                    className="filter-select"
                    value={fc.col}
                    onChange={(e) => patch({ col: e.target.value })}
                  >
                    {regularNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <select
                    className="filter-select filter-op"
                    value={fc.op}
                    onChange={(e) => patch({ op: e.target.value })}
                  >
                    {CQL_OPS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                  <input
                    className="filter-value mg-mono"
                    placeholder="value…"
                    value={fc.val}
                    onChange={(e) => patch({ val: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") runBuilder();
                    }}
                    spellCheck={false}
                  />
                  <button
                    className="saved-del"
                    title="Remove condition"
                    onClick={() => setFilterConds(filterConds.filter((_, j) => j !== i))}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="cass-qb-foot filter-foot">
            {regularNames.length ? (
              <button
                className="filter-add"
                onClick={() =>
                  setFilterConds([
                    ...filterConds,
                    { col: regularNames[0] ?? "", op: "=", val: "", enabled: true },
                  ])
                }
              >
                <Icon name="add" size={14} /> Add condition
              </button>
            ) : null}
            <button className="filter-rawtoggle" onClick={() => setShowCql((s) => !s)}>
              <Icon name={showCql ? "tune" : "code"} size={13} />{" "}
              {showCql ? "Hide CQL" : "View CQL"}
            </button>
            <div style={{ flex: 1 }} />
            {filterConds.some((f) => f.enabled !== false && f.val) && !allowFiltering ? (
              <span className="cass-qb-warn-inline">
                <Icon name="warning" size={12} /> needs ALLOW FILTERING
              </span>
            ) : (
              <span className="filter-count-note">
                {appliedParts.length} condition{appliedParts.length === 1 ? "" : "s"} active
              </span>
            )}
            <Btn
              variant="text"
              small
              onClick={() => {
                setPkVals({});
                setClusterConds([]);
                setFilterConds([]);
                setAllowFiltering(false);
                runFresh({}, [], [], limit, false);
              }}
            >
              Clear
            </Btn>
            <Btn variant="filled" icon="check" small onClick={runBuilder}>
              Apply
            </Btn>
          </div>
          {showCql ? (
            <pre
              className="cass-cql-preview"
              dangerouslySetInnerHTML={{ __html: highlightSql(previewCql) }}
            />
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="sql-results">
          <div className="sql-error">
            <Icon name="error" size={18} />
            <div>
              <div className="sql-error-title">Query error</div>
              <div className="sql-error-msg">{error}</div>
              {/allow filtering/i.test(error) ? (
                <button
                  className="cass-fix-btn"
                  onClick={() => {
                    setAllowFiltering(true);
                    runFresh(pkVals, clusterConds, filterConds, limit, true);
                  }}
                >
                  <Icon name="bolt" size={14} /> Add ALLOW FILTERING and re-run
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : mode === "structure" ? (
        <CassStructure
          handleId={handleId}
          ks={ks}
          table={t}
          isProduction={isProduction}
          onChanged={onSchemaChanged}
        />
      ) : (
        <>
          {result?.warnings.length ? (
            <div className="cass-warn">
              <Icon name="warning" size={14} /> {result.warnings[0]}
            </div>
          ) : null}
          {selected.size > 0 ? (
            <div className="cass-selbar">
              <span className="cass-selbar-count">{selected.size} selected</span>
              <div style={{ flex: 1 }} />
              <Btn icon="download" variant="tonal" small onClick={exportSelectedCsv}>
                Export CSV
              </Btn>
              <Btn
                icon="delete"
                variant="tonal"
                small
                className="cass-selbar-del"
                onClick={() => setBulkDeleteOpen(true)}
              >
                Delete selected
              </Btn>
            </div>
          ) : null}
          <CassRowGrid
            table={{ columns: result?.columns ?? t.columns }}
            rows={displayRows}
            editable
            onEditCell={stageEdit}
            isCellEdited={isCellEdited}
            onComplexEdit={(r) => setRowView(r)}
            onOpenRow={(r) => setRowView(r)}
            keyCols={keyColsSet}
            selected={selected}
            onToggleRow={toggleRow}
            onToggleAll={toggleAll}
          />
          {editCount ? (
            <div className="save-bar">
              <Icon name="edit_note" size={16} style={{ color: "var(--accent)" }} />
              <span className="save-bar-count">
                {editCount} cell{editCount === 1 ? "" : "s"} edited · unsaved
              </span>
              <span className="save-bar-hint">
                nothing is written to the database until you save
              </span>
              <div style={{ flex: 1 }} />
              <Btn variant="text" small onClick={discardEdits}>
                Discard
              </Btn>
              <Btn variant="filled" small icon="save" onClick={() => void saveEdits()}>
                Save · ⌘S
              </Btn>
            </div>
          ) : null}
          <div className="table-footer">
            <span className="table-hint">
              double-click a cell to edit · click # to open the row · ⌘I add · ⌘S save · {ks}.
              {tableName}
            </span>
            <div className="pager">
              <span className="pager-label">Page size</span>
              <Select
                className="pager-size"
                aria-label="Page size"
                placement="up"
                value={String(limit)}
                options={[
                  { value: "100", label: "100" },
                  { value: "300", label: "300" },
                  { value: "1000", label: "1000" },
                  { value: "5000", label: "5000" },
                ]}
                onChange={(v) => {
                  const nl = Number(v);
                  setLimit(nl);
                  runFresh(pkVals, clusterConds, filterConds, nl, allowFiltering);
                }}
              />
              <span className="pager-range">
                {result
                  ? result.returned.toLocaleString() + " rows · " + result.ms.toFixed(1) + " ms"
                  : "0"}
              </span>
              <IconBtn
                icon="chevron_left"
                title="Previous page"
                onClick={prevPage}
                disabled={pageIdx === 0}
              />
              <span className="pager-page">Page {pageIdx + 1}</span>
              <IconBtn
                icon="chevron_right"
                title="Next page"
                onClick={nextPage}
                disabled={!result?.nextPagingState}
              />
            </div>
          </div>
        </>
      )}

      {rowView ? (
        <CassRowModal
          table={t}
          ks={ks}
          handleId={handleId}
          row={rowView}
          isProduction={isProduction}
          onClose={() => setRowView(null)}
          onSaved={() => {
            setRowView(null);
            runBuilder();
          }}
        />
      ) : null}
      {newRow ? (
        <CassRowModal
          table={t}
          ks={ks}
          handleId={handleId}
          row={{}}
          isNew
          isProduction={isProduction}
          onClose={() => setNewRow(false)}
          onSaved={() => {
            setNewRow(false);
            runBuilder();
          }}
        />
      ) : null}
      {bulkDeleteOpen ? (
        <BulkDeleteModal
          count={selected.size}
          target={tableName}
          noun="row"
          isProduction={isProduction}
          onConfirm={bulkDelete}
          onClose={() => setBulkDeleteOpen(false)}
          onDone={() => {
            setBulkDeleteOpen(false);
            setSelected(new Set());
            runBuilder();
          }}
        />
      ) : null}
    </div>
  );
}

/** Split a comma list for `IN`; otherwise the scalar string verbatim. */
function predVal(op: string, val: string): unknown {
  if (op === "IN")
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return val;
}
