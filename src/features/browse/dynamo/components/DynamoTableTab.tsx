// Table tab (M17 §17.2): Scan vs Query mode toggle, the PK value + sort-key
// condition row + index selector for Query, the schemaless item grid, a
// capacity readout (`N items · M scanned · X RCU`), and the read-only Indexes
// view. Backed by the real `dynamo_scan` / `dynamo_query` commands (bounded
// pages). Ported from the prototype's `DynamoTableTab` / `DynamoStructure`.

import { useCallback, useEffect, useRef, useState } from "react";

import { exportSave } from "../../../../shared/api/engine";
import { isAppErrorPayload } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import {
  dynamoQuery,
  dynamoScan,
  type DynamoItem,
  type ItemPage,
  type QueryRequest,
  type SortKeyOp,
  type TableDescriptor,
} from "../api";
import { attributeUnion } from "../helpers";
import { DynamoDeleteModal } from "./DynamoDeleteModal";
import { DynamoItemGrid } from "./DynamoItemGrid";
import { DynamoItemModal } from "./DynamoItemModal";

const DEFAULT_LIMIT = 100;
const PAGE_SIZES = [25, 50, 100, 200, 500];

type Mode = "scan" | "query" | "structure";

interface DynamoTableTabProps {
  table: TableDescriptor;
  handleId: string;
  isProduction: boolean;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  /** Bumped externally (e.g. after an import) to force a re-scan. */
  version: number;
  onExport: (table: string) => void;
  onImport: (table: string) => void;
}

export function DynamoTableTab({
  table,
  handleId,
  isProduction,
  mode,
  onModeChange,
  version,
  onExport,
  onImport,
}: DynamoTableTabProps) {
  const t = table;
  // Projection — chosen via a checkbox picker of the attributes seen so far
  // (DynamoDB is schemaless, so the column list is discovered from scanned data
  // and accumulated). `projSel` is the chosen subset (empty = all attributes);
  // `projectionRef` shadows the resolved comma-string so `fetchAt` (scan paging)
  // reads the latest without re-creating its callback.
  const [projSel, setProjSel] = useState<Set<string>>(new Set());
  const [projOpen, setProjOpen] = useState(false);
  const [knownCols, setKnownCols] = useState<string[]>([]);
  const projectionRef = useRef("");
  const [pkVal, setPkVal] = useState("");
  const [skVal, setSkVal] = useState("");
  const [skVal2, setSkVal2] = useState("");
  const [skOp, setSkOp] = useState<SortKeyOp>("begins_with");
  const [useIndex, setUseIndex] = useState("");
  const [result, setResult] = useState<ItemPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [itemView, setItemView] = useState<DynamoItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Multi-select (by current-page row index); cleared on any (re)fetch.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const toast = useToast();

  // Cursor paging. DynamoDB is cursor-only (LastEvaluatedKey) — there is no
  // offset and no exact total, so the grid pages forward by continuation token
  // (and back via a captured token stack), unlike the SQL grid's limit/offset.
  // `pageIndex` is the 0-based current page; `tokens[i]` is the ExclusiveStartKey
  // for page i (tokens[0] is always undefined = the first page). The active fetch
  // (scan vs query + the frozen query params) lives in a ref so Next/Prev reuse
  // it without re-reading changing inputs.
  const [pageIndex, setPageIndex] = useState(0);
  const [tokens, setTokens] = useState<(string | undefined)[]>([undefined]);
  const sourceRef = useRef<{ kind: "scan" | "query"; query: QueryRequest | null }>({
    kind: "scan",
    query: null,
  });
  // Page size (items per request). A ref shadows the state so `fetchAt` always
  // reads the latest value without re-creating its callback.
  const [pageLimit, setPageLimit] = useState(DEFAULT_LIMIT);
  const limitRef = useRef(DEFAULT_LIMIT);

  useEffect(() => {
    if (!actionsOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest && el.closest(".ddb-table-actions")) return;
      setActionsOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [actionsOpen]);

  // Fetch one page at `idx` starting from `startToken`, for the given source.
  const fetchAt = useCallback(
    async (
      idx: number,
      startToken: string | undefined,
      src: { kind: "scan" | "query"; query: QueryRequest | null },
    ) => {
      setLoading(true);
      setError(null);
      setSelected(new Set());
      try {
        const page =
          src.kind === "scan"
            ? await dynamoScan(handleId, t.name, {
                limit: limitRef.current,
                nextToken: startToken,
                projection: projectionRef.current.trim() || undefined,
              })
            : await dynamoQuery(handleId, t.name, {
                ...(src.query as QueryRequest),
                nextToken: startToken,
              });
        setResult(page);
        setPageIndex(idx);
        // Accumulate every attribute seen so a later (projected) page doesn't
        // shrink the picker's choices.
        setKnownCols((prev) => {
          const s = new Set(prev);
          for (const it of page.items) for (const k of Object.keys(it)) s.add(k);
          return s.size === prev.length ? prev : [...s];
        });
      } catch (e) {
        const verb = src.kind === "scan" ? "Scan" : "Query";
        setError(isAppErrorPayload(e) ? e.message : `${verb} requires the desktop app`);
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [handleId, t.name],
  );

  // Start a fresh scan from page 0 (resets the cursor stack).
  const runScan = useCallback(() => {
    sourceRef.current = { kind: "scan", query: null };
    setTokens([undefined]);
    void fetchAt(0, undefined, sourceRef.current);
  }, [fetchAt]);

  // Default scan on open + whenever the external version changes (post-import).
  useEffect(() => {
    runScan();
  }, [runScan, version]);

  // Start a fresh query from page 0 with the current inputs (frozen for paging).
  const runQuery = () => {
    if (!pkVal.trim()) {
      toast("Enter a partition-key value to Query", "err");
      return;
    }
    const query: QueryRequest = {
      pkValue: pkVal.trim(),
      index: useIndex || undefined,
      skOp: skVal.trim() ? skOp : undefined,
      skValue: skVal.trim() || undefined,
      skValue2: skVal2.trim() || undefined,
      limit: limitRef.current,
      projection: projectionRef.current.trim() || undefined,
    };
    sourceRef.current = { kind: "query", query };
    setTokens([undefined]);
    void fetchAt(0, undefined, sourceRef.current);
  };

  // Change the page size and re-run the current source from page 0 (the old
  // cursor stack is invalid for a different page size). `limitRef` is updated
  // synchronously so the immediate refetch uses the new size.
  const changeLimit = (n: number) => {
    setPageLimit(n);
    limitRef.current = n;
    const src = sourceRef.current;
    if (src.kind === "query" && src.query) {
      sourceRef.current = { kind: "query", query: { ...src.query, limit: n } };
    }
    setTokens([undefined]);
    void fetchAt(0, undefined, sourceRef.current);
  };

  // Columns offered in the picker — keys first, then the rest, over every
  // attribute seen so far.
  const projCols = [t.keySchema.pk, t.keySchema.sk]
    .filter((c): c is string => Boolean(c))
    .concat(knownCols.filter((c) => c !== t.keySchema.pk && c !== t.keySchema.sk).sort());
  const toggleProj = (col: string) =>
    setProjSel((s) => {
      const n = new Set(s);
      if (n.has(col)) n.delete(col);
      else n.add(col);
      return n;
    });

  // Apply the picked projection to the current source from page 0 (scan reads
  // the ref; a frozen query's projection is refreshed here).
  const applyProjection = () => {
    const str = [...projSel].join(", ");
    projectionRef.current = str;
    if (sourceRef.current.kind === "query" && sourceRef.current.query) {
      sourceRef.current = {
        kind: "query",
        query: { ...sourceRef.current.query, projection: str || undefined },
      };
    }
    setProjOpen(false);
    setTokens([undefined]);
    void fetchAt(0, undefined, sourceRef.current);
  };

  useEffect(() => {
    if (!projOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest && el.closest(".ddb-proj")) return;
      setProjOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [projOpen]);

  const canPrev = pageIndex > 0 && !loading;
  const canNext = !!result?.nextToken && !loading;

  const goPrev = () => {
    if (pageIndex === 0) return;
    void fetchAt(pageIndex - 1, tokens[pageIndex - 1], sourceRef.current);
  };
  const goNext = () => {
    const tok = result?.nextToken;
    if (!tok) return;
    // Capture this page's next cursor so Prev can return here later.
    setTokens((prev) => {
      const next = [...prev];
      next[pageIndex + 1] = tok;
      return next;
    });
    void fetchAt(pageIndex + 1, tok, sourceRef.current);
  };

  const items = result?.items ?? [];
  const clearSelection = () => setSelected(new Set());
  // Stable identities so the memoised DynamoItemGrid doesn't re-render (and
  // re-reconcile its many cells) on unrelated parent state changes.
  const toggleRow = useCallback(
    (i: number) =>
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(i)) n.delete(i);
        else n.add(i);
        return n;
      }),
    [],
  );
  const itemCount = items.length;
  const toggleAll = useCallback(
    () =>
      setSelected((s) =>
        s.size === itemCount ? new Set() : new Set(Array.from({ length: itemCount }, (_, i) => i)),
      ),
    [itemCount],
  );
  const refetchCurrent = () => {
    setTokens([undefined]);
    void fetchAt(0, undefined, sourceRef.current);
  };

  // Primary key (PK + optional SK) of a row — what BatchWriteItem delete needs.
  const keyOf = (it: DynamoItem): DynamoItem => {
    const k: DynamoItem = { [t.keySchema.pk]: it[t.keySchema.pk] };
    if (t.keySchema.sk) k[t.keySchema.sk] = it[t.keySchema.sk];
    return k;
  };
  const selectedItems = () => [...selected].map((i) => items[i]).filter(Boolean) as DynamoItem[];

  // The actual delete + production gate live in DynamoDeleteModal; the bar just
  // opens it with the selected rows' primary keys.

  const exportSelectedCsv = async () => {
    const rows = selectedItems();
    if (!rows.length) return;
    const cols = [t.keySchema.pk, t.keySchema.sk]
      .filter((c): c is string => Boolean(c))
      .concat(
        attributeUnion(rows)
          .filter((c) => c !== t.keySchema.pk && c !== t.keySchema.sk)
          .sort(),
      );
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [cols.join(",")]
      .concat(rows.map((r) => cols.map((c) => esc(r[c])).join(",")))
      .join("\n");

    // Real save: prompt for a path (the user's consent) and write via the
    // backend, like the rest of the app's exports — not a silent blob download.
    let path: string | null;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      path = await save({
        defaultPath: `${t.name}-selected.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
    } catch {
      toast("Exporting requires the ByteTable desktop app.", "info");
      return;
    }
    if (!path) return; // cancelled
    try {
      await exportSave(path, csv);
      const file = path.split(/[\\/]/).pop() ?? "export.csv";
      toast(`Exported ${rows.length} item${rows.length === 1 ? "" : "s"} to ${file}`, "ok");
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Could not write the CSV file", "err");
    }
  };

  const idx = useIndex ? t.gsis.concat(t.lsis).find((g) => g.name === useIndex) : undefined;
  const idxPk = idx ? idx.pk : t.keySchema.pk;
  const idxSk = idx ? idx.sk : t.keySchema.sk;

  const indexOptions = [
    { value: "", label: `${t.name} (base table)` },
    ...t.gsis.map((g) => ({ value: g.name, label: `${g.name} (GSI)` })),
    ...t.lsis.map((g) => ({ value: g.name, label: `${g.name} (LSI)` })),
  ];
  const skOpOptions: { value: SortKeyOp; label: string }[] = [
    { value: "eq", label: "=" },
    { value: "lt", label: "<" },
    { value: "lte", label: "≤" },
    { value: "gt", label: ">" },
    { value: "gte", label: "≥" },
    { value: "begins_with", label: "begins with" },
    { value: "between", label: "between" },
  ];

  return (
    <div className="ddb-table-tab">
      <div className="ddb-table-toolbar">
        <div className="seg">
          <button
            type="button"
            className={"seg-btn" + (mode === "scan" ? " active" : "")}
            onClick={() => onModeChange("scan")}
          >
            <Icon name="dataset" size={14} /> Scan
          </button>
          <button
            type="button"
            className={"seg-btn" + (mode === "query" ? " active" : "")}
            onClick={() => onModeChange("query")}
          >
            <Icon name="search" size={14} /> Query
          </button>
          <button
            type="button"
            className={"seg-btn" + (mode === "structure" ? " active" : "")}
            onClick={() => onModeChange("structure")}
          >
            <Icon name="account_tree" size={14} /> Indexes
          </button>
        </div>
        {mode !== "structure" ? (
          <div className="ddb-tb-proj">
            <span className="ddb-proj-label">
              <Icon name="filter_list" size={13} /> Projection
            </span>
            <div className="ddb-proj">
              <button
                type="button"
                className="ddb-proj-trigger"
                onClick={() => setProjOpen((o) => !o)}
                disabled={projCols.length === 0}
              >
                {projSel.size === 0 ? (
                  <span className="ddb-proj-all">All attributes</span>
                ) : (
                  <span className="ddb-proj-chips">
                    {projCols
                      .filter((c) => projSel.has(c))
                      .map((c) => (
                        <span key={c} className="ddb-proj-chip">
                          {c}
                          <span
                            className="ddb-proj-chip-x"
                            role="button"
                            tabIndex={-1}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleProj(c);
                            }}
                          >
                            <Icon name="close" size={11} />
                          </span>
                        </span>
                      ))}
                  </span>
                )}
                <Icon name="expand_more" size={16} />
              </button>
              {projOpen ? (
                <div className="ddb-proj-pop">
                  <div className="ddb-proj-pop-head">
                    <span>Return attributes</span>
                    <button
                      type="button"
                      className="ddb-proj-clear"
                      onClick={() => setProjSel(new Set())}
                    >
                      All
                    </button>
                  </div>
                  <div className="ddb-proj-list">
                    {projCols.map((c) => (
                      <label key={c} className="ddb-proj-opt">
                        <input
                          type="checkbox"
                          className="ddb-dg-check"
                          checked={projSel.has(c)}
                          onChange={() => toggleProj(c)}
                        />
                        <span>{c}</span>
                      </label>
                    ))}
                  </div>
                  <div className="ddb-proj-foot">
                    <Btn variant="filled" small icon="bolt" onClick={applyProjection}>
                      Apply
                    </Btn>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {mode === "scan" ? (
          <>
            <span className="ddb-scan-note">
              <Icon name="warning" size={12} style={{ color: "#e2b340" }} /> Scan reads every item
            </span>
            <Btn icon="refresh" variant="tonal" small onClick={() => void runScan()}>
              Run scan
            </Btn>
          </>
        ) : (
          <div style={{ flex: 1 }} />
        )}
        {mode !== "structure" ? (
          <IconBtn icon="add_box" title="New item" onClick={() => setCreating(true)} />
        ) : null}
        <div className="ddb-table-actions" style={{ position: "relative", marginLeft: "auto" }}>
          <IconBtn
            icon="more_vert"
            title="Table actions"
            active={actionsOpen}
            onClick={() => setActionsOpen((o) => !o)}
          />
          {actionsOpen ? (
            <div className="ddb-ctx-menu ddb-table-actions-menu">
              <button
                type="button"
                className="ddb-ctx-item"
                onClick={() => {
                  setActionsOpen(false);
                  onExport(t.name);
                }}
              >
                <Icon name="download" size={15} /> Export table…
              </button>
              <button
                type="button"
                className="ddb-ctx-item"
                onClick={() => {
                  setActionsOpen(false);
                  onImport(t.name);
                }}
              >
                <Icon name="upload" size={15} /> Import items…
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {mode === "query" ? (
        <div className="ddb-query-bar">
          <div className="ddb-q-field ddb-q-index">
            <span>Index</span>
            <Select
              className="ddb-q-select"
              aria-label="Index"
              mono={false}
              value={useIndex}
              options={indexOptions}
              onChange={(v) => {
                setUseIndex(v);
                // A different index has a different key schema — the old PK/SK
                // values no longer apply.
                setPkVal("");
                setSkVal("");
                setSkVal2("");
              }}
            />
          </div>
          <label className="ddb-q-field">
            <span>
              <span className="ddb-key-badge pk">PK</span> {idxPk} =
            </span>
            <input
              className="ddb-where-input"
              placeholder="partition key value"
              value={pkVal}
              onChange={(e) => setPkVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runQuery();
              }}
              spellCheck={false}
            />
          </label>
          {idxSk ? (
            <div className="ddb-q-field ddb-q-sk">
              <span>
                <span className="ddb-key-badge sk">SK</span> {idxSk}
              </span>
              <div className="ddb-sk-row">
                <Select
                  className="ddb-sk-op"
                  aria-label="Sort key operator"
                  mono={false}
                  value={skOp}
                  options={skOpOptions}
                  onChange={setSkOp}
                />
                <input
                  className="ddb-where-input"
                  placeholder={skOp === "begins_with" ? "prefix" : "value"}
                  value={skVal}
                  onChange={(e) => setSkVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runQuery();
                  }}
                  spellCheck={false}
                />
                {skOp === "between" ? (
                  <input
                    className="ddb-where-input"
                    placeholder="and…"
                    value={skVal2}
                    onChange={(e) => setSkVal2(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void runQuery();
                    }}
                    spellCheck={false}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
          <Btn icon="play_arrow" variant="filled" small onClick={() => void runQuery()}>
            Query
          </Btn>
        </div>
      ) : null}

      {mode === "structure" ? (
        <DynamoStructure t={t} />
      ) : (
        <>
          {selected.size > 0 ? (
            <div className="ddb-selbar">
              <span className="ddb-selbar-count">
                {selected.size} selected
                {result?.nextToken ? " (this page)" : ""}
              </span>
              <div style={{ flex: 1 }} />
              <Btn icon="download" variant="tonal" small onClick={() => void exportSelectedCsv()}>
                Export CSV
              </Btn>
              <Btn
                icon="delete"
                variant="tonal"
                small
                className="ddb-selbar-del"
                onClick={() => setDeleteOpen(true)}
              >
                Delete selected
              </Btn>
              <IconBtn icon="close" title="Clear selection" size={16} onClick={clearSelection} />
            </div>
          ) : null}
          {error ? (
            <div className="ddb-tab-error">
              <Icon name="error" size={16} /> {error}
            </div>
          ) : (
            <DynamoItemGrid
              items={items}
              keySchema={t.keySchema}
              onOpenItem={setItemView}
              selected={selected}
              onToggleRow={toggleRow}
              onToggleAll={toggleAll}
            />
          )}
          <div className="ddb-table-foot">
            <span className="ddb-table-hint">
              {loading ? "Loading…" : sourceRef.current.kind === "scan" ? "Scan" : "Query"} · click
              any item to view &amp; edit · keys are immutable
            </span>
            <div style={{ flex: 1 }} />
            {result ? (
              <span className="ddb-rowcount">
                {result.count} items · {result.scannedCount} scanned · {result.capacity.toFixed(1)}{" "}
                RCU
              </span>
            ) : null}
            <div className="ddb-pagesize">
              <span>Page size</span>
              <Select
                className="ddb-pagesize-select"
                aria-label="Page size"
                mono={false}
                placement="up"
                value={String(pageLimit)}
                options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
                onChange={(v) => changeLimit(Number(v))}
              />
            </div>
            {result ? (
              <div className="ddb-pager">
                <IconBtn
                  icon="chevron_left"
                  title="Previous page"
                  size={16}
                  disabled={!canPrev}
                  onClick={goPrev}
                />
                <span className="ddb-pager-label">Page {pageIndex + 1}</span>
                <IconBtn
                  icon="chevron_right"
                  title={canNext ? "Next page" : "No more items"}
                  size={16}
                  disabled={!canNext}
                  onClick={goNext}
                />
              </div>
            ) : null}
          </div>
        </>
      )}

      {itemView ? (
        <DynamoItemModal
          item={itemView}
          table={t}
          handleId={handleId}
          isProduction={isProduction}
          onClose={() => setItemView(null)}
          onSaved={() => void runScan()}
        />
      ) : null}

      {creating ? (
        <DynamoItemModal
          item={{}}
          table={t}
          handleId={handleId}
          isProduction={isProduction}
          create
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            refetchCurrent();
          }}
        />
      ) : null}

      {deleteOpen && selected.size > 0 ? (
        <DynamoDeleteModal
          handleId={handleId}
          table={t.name}
          isProduction={isProduction}
          keys={selectedItems().map(keyOf)}
          onClose={() => setDeleteOpen(false)}
          onDone={() => {
            clearSelection();
            refetchCurrent();
          }}
        />
      ) : null}
    </div>
  );
}

function MetaRow({ label, val }: { label: string; val: string }) {
  return (
    <div className="ddb-meta-row">
      <span>{label}</span>
      <b>{val}</b>
    </div>
  );
}

function DynamoStructure({ t }: { t: TableDescriptor }) {
  return (
    <div className="ddb-structure-view">
      <h3 className="ddb-h">
        <Icon name="key" size={15} style={{ color: "var(--accent)" }} /> Primary key
      </h3>
      <div className="ddb-structure-card">
        <div className="ddb-structure-card-name">
          <span className="ddb-key-badge pk">PK</span> {t.keySchema.pk}{" "}
          <span className="ddb-tag">{t.attrTypes[t.keySchema.pk] ?? "S"}</span>
          {t.keySchema.sk ? (
            <>
              {" "}
              <span className="ddb-key-badge sk">SK</span> {t.keySchema.sk}{" "}
              <span className="ddb-tag">{t.attrTypes[t.keySchema.sk] ?? "S"}</span>
            </>
          ) : (
            <span className="ddb-idx-keys"> · partition-only</span>
          )}
        </div>
      </div>

      <h3 className="ddb-h" style={{ marginTop: 18 }}>
        <Icon name="bolt" size={15} style={{ color: "#e2b340" }} /> Global secondary indexes{" "}
        <span className="ddb-rail-count">{t.gsis.length}</span>
      </h3>
      {t.gsis.length === 0 ? (
        <div className="ddb-structure-none">None</div>
      ) : (
        t.gsis.map((g) => (
          <div key={g.name} className="ddb-structure-card">
            <div className="ddb-structure-card-name">
              {g.name} <span className="ddb-tag">{g.projection}</span>
            </div>
            <div className="ddb-structure-card-detail">
              <span className="ddb-key-badge pk">PK</span> {g.pk}
              {g.sk ? (
                <>
                  {" "}
                  · <span className="ddb-key-badge sk">SK</span> {g.sk}
                </>
              ) : null}
            </div>
          </div>
        ))
      )}

      {t.lsis.length ? (
        <>
          <h3 className="ddb-h" style={{ marginTop: 18 }}>
            <Icon name="bolt" size={15} style={{ color: "#e2b340" }} /> Local secondary indexes{" "}
            <span className="ddb-rail-count">{t.lsis.length}</span>
          </h3>
          {t.lsis.map((g) => (
            <div key={g.name} className="ddb-structure-card">
              <div className="ddb-structure-card-name">
                {g.name} <span className="ddb-tag">{g.projection}</span>
              </div>
              <div className="ddb-structure-card-detail">
                <span className="ddb-key-badge pk">PK</span> {g.pk}
                {g.sk ? (
                  <>
                    {" "}
                    · <span className="ddb-key-badge sk">SK</span> {g.sk}
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </>
      ) : null}

      <h3 className="ddb-h" style={{ marginTop: 18 }}>
        <Icon name="settings" size={15} /> Settings
      </h3>
      <div className="ddb-meta">
        <MetaRow label="Status" val={t.status} />
        <MetaRow
          label="Billing mode"
          val={t.billing === "PAY_PER_REQUEST" ? "On-demand" : "Provisioned"}
        />
        {t.billing === "PROVISIONED" ? (
          <MetaRow label="Capacity" val={(t.rcu ?? 0) + " RCU / " + (t.wcu ?? 0) + " WCU"} />
        ) : null}
        {t.ttlAttribute ? <MetaRow label="TTL attribute" val={t.ttlAttribute} /> : null}
        <MetaRow label="Item count" val={t.itemCount.toLocaleString()} />
        <MetaRow label="Table size" val={(t.sizeBytes / 1024).toFixed(1) + " KB"} />
        {t.created ? <MetaRow label="Created" val={t.created.slice(0, 10)} /> : null}
      </div>
    </div>
  );
}
