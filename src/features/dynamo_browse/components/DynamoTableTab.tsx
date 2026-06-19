// Table tab (M17 §17.2): Scan vs Query mode toggle, the PK value + sort-key
// condition row + index selector for Query, the schemaless item grid, a
// capacity readout (`N items · M scanned · X RCU`), and the read-only Indexes
// view. Backed by the real `dynamo_scan` / `dynamo_query` commands (bounded
// pages). Ported from the prototype's `DynamoTableTab` / `DynamoStructure`.

import { useCallback, useEffect, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Select } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import {
  dynamoQuery,
  dynamoScan,
  type DynamoItem,
  type ItemPage,
  type QueryRequest,
  type SortKeyOp,
  type TableDescriptor,
} from "../api";
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
  const [pkVal, setPkVal] = useState("");
  const [skVal, setSkVal] = useState("");
  const [skVal2, setSkVal2] = useState("");
  const [skOp, setSkOp] = useState<SortKeyOp>("begins_with");
  const [useIndex, setUseIndex] = useState("");
  const [result, setResult] = useState<ItemPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [itemView, setItemView] = useState<DynamoItem | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
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
      try {
        const page =
          src.kind === "scan"
            ? await dynamoScan(handleId, t.name, {
                limit: limitRef.current,
                nextToken: startToken,
              })
            : await dynamoQuery(handleId, t.name, {
                ...(src.query as QueryRequest),
                nextToken: startToken,
              });
        setResult(page);
        setPageIndex(idx);
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
        {result && mode !== "structure" ? (
          <span className="ddb-rowcount">
            {result.count} items · {result.scannedCount} scanned · {result.capacity.toFixed(1)} RCU
          </span>
        ) : null}
        {mode !== "structure" ? (
          <div className="ddb-pagesize">
            <span>Page size</span>
            <Select
              className="ddb-pagesize-select"
              aria-label="Page size"
              mono={false}
              value={String(pageLimit)}
              options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
              onChange={(v) => changeLimit(Number(v))}
            />
          </div>
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
              onChange={setUseIndex}
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
          {error ? (
            <div className="ddb-tab-error">
              <Icon name="error" size={16} /> {error}
            </div>
          ) : (
            <DynamoItemGrid
              items={result ? result.items : []}
              keySchema={t.keySchema}
              onOpenItem={setItemView}
            />
          )}
          <div className="ddb-table-foot">
            <span className="ddb-table-hint">
              {loading ? "Loading…" : sourceRef.current.kind === "scan" ? "Scan" : "Query"} · click
              any item to view &amp; edit · keys are immutable
            </span>
            <div style={{ flex: 1 }} />
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
