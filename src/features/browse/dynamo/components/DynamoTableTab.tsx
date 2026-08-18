// Table tab (M17 §17.2): Scan vs Query mode toggle, the PK value + sort-key
// condition row + index selector for Query, the schemaless item grid, a
// capacity readout (`N items · M scanned · X RCU`), and the read-only Indexes
// view. Backed by the real `dynamo_scan` / `dynamo_query` commands (bounded
// pages). Ported from the prototype's `DynamoTableTab` / `DynamoStructure`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { exportSave } from "../../../../shared/api/engine";
import { isAppErrorPayload } from "../../../../shared/api/error";
import { Btn } from "../../../../shared/ui/Btn";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { Select } from "../../../../shared/ui/Select";
import { useToast } from "../../../../shared/ui/toastContext";
import {
  dynamoBatchWrite,
  dynamoQuery,
  dynamoScan,
  type DynamoItem,
  type ItemPage,
  type QueryRequest,
  type SortKeyOp,
  type TableDescriptor,
} from "../api";
import { attributeUnion, itemKeyOf } from "../helpers";
import { DynamoDeleteModal } from "./DynamoDeleteModal";
import { DynamoItemGrid } from "./DynamoItemGrid";
import { DynamoItemDrawer } from "./DynamoItemDrawer";

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
  onTruncate: (table: string) => void;
  onDelete: (table: string) => void;
  /**
   * Whether this tab is the visible one. The workspace keeps every tab mounted
   * (under `display: none`) to preserve its state, so this component cannot tell
   * from its own render whether anyone can see it — and two things depend on the
   * answer: the keyboard shortcuts, and the item drawer, which portals to
   * `document.body` and so is NOT hidden by the wrapper.
   */
  active: boolean;
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
  onTruncate,
  onDelete,
  active,
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
  // Which grid row the open drawer belongs to, so the gutter can mark it and the
  // row can be tinted while the drawer is up.
  const [inspectingRow, setInspectingRow] = useState<number | null>(null);
  // The attribute the drawer should land on — the column that was clicked, or
  // null when the row was opened from the gutter (start at the top).
  const [inspectingAttr, setInspectingAttr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Multi-select (by current-page row index); cleared on any (re)fetch.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  // One item queued for deletion from the drawer's header button, kept separate
  // from the grid's multi-select so the two cannot be confused for each other.
  const [deleteItem, setDeleteItem] = useState<DynamoItem | null>(null);
  // The key condition that produced the rows on screen, or null when they came
  // from a scan. Drives the footer's source label and the stale-source banner,
  // both of which would otherwise read `sourceRef` during render — a ref the
  // fetch mutates without re-rendering, so the label could lag the data.
  const [shownQuery, setShownQuery] = useState<string | null>(null);
  // Un-committed item writes, keyed by primary key — the same two-stage contract
  // the SQL and Cassandra grids use: the drawer stages, the save bar commits.
  // A whole ITEM is the unit, not a cell, because DynamoDB's only write is
  // PutItem, which replaces the item entirely.
  const [staged, setStaged] = useState<Map<string, { item: DynamoItem; isNew: boolean }>>(
    new Map(),
  );
  const [savingEdits, setSavingEdits] = useState(false);
  const toast = useToast();

  // ⌘I / Ctrl+I opens the new-item editor and ⌘F / Ctrl+F goes to Query with the
  // partition key focused — the same bindings the SQL, Cassandra and data-file
  // grids use for "add row" and "find rows".
  //
  // ⌘F means "narrow this down", and DynamoDB's answer to that is a Query on the
  // partition key, not a client-side filter over a scanned page — so the
  // shortcut switches modes and drops the caret where the condition goes.
  //
  // ⌘S commits whatever the drawer has staged, and ⌘E toggles the inspector.
  // All four are gated on `active` — every tab stays mounted, so an ungated
  // listener would fire on all of them at once.
  const pkRef = useRef<HTMLInputElement | null>(null);
  // ⌘S commits the staged batch. Read through a ref so the key listener does not
  // need re-binding every time the buffer changes.
  const saveStagedRef = useRef<() => void>(() => {});
  // True while the item drawer is up — it takes ⌘S for staging (see below).
  const drawerOpenRef = useRef(false);
  // ⌘E toggles the inspector; read through a ref so the listener is bound once
  // rather than re-bound whenever the page changes.
  const toggleInspectorRef = useRef<() => void>(() => {});
  // The row ⌘E should reopen on — the last one inspected, so the key is a real
  // toggle rather than "close, then jump back to the top". Survives the close
  // that `inspectingRow` does not, and is reset by a fetch (see `fetchAt`).
  const lastInspectedRef = useRef(0);
  // Bumped by ⌘F; the focus itself waits for the effect below, because the
  // query bar does not exist yet on the render that requests it.
  const [focusPk, setFocusPk] = useState(0);
  useEffect(() => {
    // Every tab stays mounted, so without this gate one keypress would act on
    // all of them at once, all but one invisible.
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "i" && key !== "f" && key !== "s" && key !== "e") return;
      if (key === "f") {
        e.preventDefault();
        onModeChange("query");
        setFocusPk((n) => n + 1);
        return;
      }
      if (key === "e") {
        e.preventDefault();
        toggleInspectorRef.current();
        return;
      }
      if (key === "s") {
        e.preventDefault();
        // The drawer owns ⌘S while it is open: its edits must be staged before
        // there is anything worth committing, so one keystroke never both stages
        // and commits.
        if (!drawerOpenRef.current) saveStagedRef.current();
        return;
      }
      // Indexes is a read-only view of the schema; nothing to add an item to.
      if (mode === "structure") return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, mode, onModeChange]);

  useEffect(() => {
    if (focusPk === 0 || mode !== "query") return;
    pkRef.current?.focus();
    pkRef.current?.select();
  }, [focusPk, mode]);

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
      // The gutter marker is a row INDEX, and a new page renumbers everything —
      // keeping it would highlight whichever item happened to land in that slot.
      // The drawer itself stays open; it identifies its item by key, not index.
      setInspectingRow(null);
      lastInspectedRef.current = 0;
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
    setShownQuery(null);
    setTokens([undefined]);
    void fetchAt(0, undefined, sourceRef.current);
  }, [fetchAt]);

  // Default scan on open + whenever the external version changes (post-import).
  useEffect(() => {
    runScan();
  }, [runScan, version]);

  // Nothing else in this tab starts a scan. A scan reads every item in the
  // table and is billed for it, so apart from the one page on open, every read
  // is the user's decision: switching modes, opening the Indexes view or coming
  // back from a Query all leave the current page alone. The banner below the
  // toolbar is what keeps that honest — it names the rows' real source instead
  // of quietly re-reading the table to make the label true.

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
    // Describe the condition for the banner while the inputs are still to hand
    // — the index (and so the key attribute names) can change afterwards.
    const keyName = useIndex
      ? (t.gsis.concat(t.lsis).find((i) => i.name === useIndex)?.pk ?? useIndex)
      : t.keySchema.pk;
    setShownQuery(keyName + " = " + JSON.stringify(pkVal.trim()));
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

  // The page with staged writes folded over it: an edited item shows its edited
  // form, and a staged-new item is appended so it is visible before it exists.
  // Nothing here has been written — the save bar is what commits.
  const { items, stagedRows, stagedNewRows } = useMemo(() => {
    const fetched = result?.items ?? [];
    if (staged.size === 0) {
      return { items: fetched, stagedRows: new Set<number>(), stagedNewRows: new Set<number>() };
    }
    const rows: DynamoItem[] = [];
    const edited = new Set<number>();
    const fresh = new Set<number>();
    const usedKeys = new Set<string>();
    for (const it of fetched) {
      const k = itemKeyOf(it, t.keySchema);
      const st = staged.get(k);
      if (st) {
        edited.add(rows.length);
        usedKeys.add(k);
        rows.push(st.item);
      } else {
        rows.push(it);
      }
    }
    // Anything staged that is not on this page is appended so it stays visible:
    // a brand-new item, or an edit to an item the pager has since moved past.
    // The stored `isNew` flag decides which marker it gets — "not on this page"
    // is not the same claim as "does not exist in the table".
    for (const [k, st] of staged) {
      if (usedKeys.has(k)) continue;
      (st.isNew ? fresh : edited).add(rows.length);
      rows.push(st.item);
    }
    return { items: rows, stagedRows: edited, stagedNewRows: fresh };
  }, [result, staged, t.keySchema]);

  const stageItem = useCallback(
    (item: DynamoItem, isNew: boolean) => {
      const k = itemKeyOf(item, t.keySchema);
      setStaged((prev) => {
        const next = new Map(prev);
        next.set(k, { item, isNew: prev.get(k)?.isNew ?? isNew });
        return next;
      });
    },
    [t.keySchema],
  );
  const discardStaged = () => setStaged(new Map());

  // Commit every staged item in one chunked BatchWriteItem. PutItem replaces the
  // whole item, which is exactly what the drawer staged, so a batch write and a
  // per-item loop have identical semantics — the batch is simply fewer calls.
  const saveStaged = useCallback(async () => {
    if (staged.size === 0 || savingEdits) return;
    const list = [...staged.values()];
    if (
      isProduction &&
      !window.confirm(
        "This connection is a PRODUCTION environment.\n\nWrite " +
          list.length +
          " item(s) to " +
          t.name +
          "? Existing items with these keys will be overwritten.",
      )
    ) {
      return;
    }
    setSavingEdits(true);
    try {
      const res = await dynamoBatchWrite(
        handleId,
        t.name,
        list.map((s) => s.item),
      );
      if (res.unprocessed > 0) {
        // Partial success is real: DynamoDB returns what it could not write.
        // Keep the whole batch staged rather than guess which ones landed.
        toast(
          res.written + " item(s) written · " + res.unprocessed + " could not be — still staged",
          "err",
        );
      } else {
        toast(res.written + " item" + (res.written === 1 ? "" : "s") + " saved", "ok");
        setStaged(new Map());
      }
      // Re-read page 0 so the grid shows what the table now holds, not what we
      // hoped it would. Inlined rather than calling `refetchCurrent` below: that
      // const is declared further down the component, and reaching forward to it
      // from a callback works only by closure timing.
      setTokens([undefined]);
      void fetchAt(0, undefined, sourceRef.current);
    } catch (e) {
      toast(isAppErrorPayload(e) ? e.message : "Saving items requires the desktop app", "err");
    } finally {
      setSavingEdits(false);
    }
  }, [staged, savingEdits, isProduction, handleId, t.name, toast, fetchAt]);

  useEffect(() => {
    saveStagedRef.current = () => void saveStaged();
  }, [saveStaged]);

  useEffect(() => {
    drawerOpenRef.current = itemView !== null || creating;
  }, [itemView, creating]);

  // ⌘E: close the inspector if it is open, else open it on the first item with
  // no attribute focused — "show me this record", the same toggle the SQL and
  // data-file grids give the key. It deliberately ignores the NEW-item drawer:
  // silently discarding a half-composed item is not a toggle.
  useEffect(() => {
    toggleInspectorRef.current = () => {
      if (creating) return;
      if (itemView) {
        setItemView(null);
        setInspectingRow(null);
        setInspectingAttr(null);
        return;
      }
      // Reopen where the user left off. Clamped, because the remembered index
      // can outlive the page it referred to (a shorter page, or a truncate).
      const row = Math.min(lastInspectedRef.current, items.length - 1);
      const target = items[row];
      if (!target) return;
      lastInspectedRef.current = row;
      setItemView(target);
      setInspectingRow(row);
      setInspectingAttr(null);
    };
  }, [creating, itemView, items]);

  const openInspector = useCallback((item: DynamoItem, index: number, attr?: string) => {
    lastInspectedRef.current = index;
    setItemView(item);
    setInspectingRow(index);
    setInspectingAttr(attr ?? null);
  }, []);

  const clearSelection = () => setSelected(new Set());
  // Stable identities so the memoised DynamoItemGrid (see its own note) doesn't
  // re-render — and re-reconcile its many cells — on unrelated parent state
  // changes, of which a tab switch is one: every tab in this workspace stays
  // mounted, so an unmemoised grid re-rendered even while hidden.
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
            title="Query — narrow by partition key (⌘F / Ctrl+F)"
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
          <span className="ddb-scan-note">
            <Icon name="warning" size={12} style={{ color: "#e2b340" }} /> Scan reads every item
          </span>
        ) : null}
        {/* Everything below is the toolbar's action cluster — run, new item,
            table actions — held together at the right edge. The spacer is what
            separates it from the mode/projection controls on the left. */}
        <div style={{ flex: 1 }} />
        {mode === "scan" ? (
          <Btn icon="play_arrow" variant="tonal" small onClick={() => void runScan()}>
            Run scan
          </Btn>
        ) : null}
        {mode !== "structure" ? (
          <IconBtn
            icon="add_box"
            title="New item (⌘I / Ctrl+I)"
            onClick={() => setCreating(true)}
          />
        ) : null}
        <div className="ddb-table-actions" style={{ position: "relative" }}>
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
                <Icon name="download" size={15} /> Export table
              </button>
              <button
                type="button"
                className="ddb-ctx-item"
                onClick={() => {
                  setActionsOpen(false);
                  onImport(t.name);
                }}
              >
                <Icon name="upload" size={15} /> Import items
              </button>
              {/* Destructive last, behind a separator — same order as the
                  sidebar's per-table menu. */}
              <div className="ddb-ctx-sep" />
              <button
                type="button"
                className="ddb-ctx-item danger"
                onClick={() => {
                  setActionsOpen(false);
                  onTruncate(t.name);
                }}
              >
                <Icon name="delete_sweep" size={15} /> Empty table
              </button>
              <button
                type="button"
                className="ddb-ctx-item danger"
                onClick={() => {
                  setActionsOpen(false);
                  onDelete(t.name);
                }}
              >
                <Icon name="delete_forever" size={15} /> Delete table
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
              ref={pkRef}
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
          {/* The rows on screen outlive a mode switch, because re-reading the
              table to make the toolbar's label true would bill the user for a
              scan they did not ask for. Say what they actually are instead. */}
          {mode === "scan" && shownQuery && !loading ? (
            <div className="ddb-stale-src">
              <Icon name="filter_alt" size={14} />
              {/* No Run scan button here — the toolbar's own sits directly
                  above it, and a scan is not an action to offer twice. */}
              <span>
                These rows came from a Query on <code>{shownQuery}</code> — not a scan of the table.
              </span>
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
              onOpenItem={openInspector}
              inspectingRow={inspectingRow}
              selected={selected}
              onToggleRow={toggleRow}
              onToggleAll={toggleAll}
              staged={stagedRows}
              stagedNew={stagedNewRows}
            />
          )}
          {staged.size > 0 ? (
            <div className="save-bar">
              <Icon name="edit_note" size={16} style={{ color: "var(--accent)" }} />
              <span className="save-bar-count">
                {staged.size} item{staged.size === 1 ? "" : "s"} edited · unsaved
              </span>
              <span className="save-bar-hint">nothing is written to DynamoDB until you save</span>
              <div style={{ flex: 1 }} />
              <Btn variant="text" small onClick={discardStaged} disabled={savingEdits}>
                Discard
              </Btn>
              <Btn
                variant="filled"
                small
                icon="save"
                disabled={savingEdits}
                onClick={() => void saveStaged()}
              >
                {savingEdits ? "Saving…" : "Save · ⌘S"}
              </Btn>
            </div>
          ) : null}
          <div className="ddb-table-foot">
            <span className="ddb-table-hint">
              {loading ? "Loading…" : shownQuery ? "Query" : "Scan"} · click any item to view &amp;
              edit · ⌘E inspect · ⌘I add · ⌘S save · keys are immutable
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

      {/* Gated on `active`: the drawer portals to document.body, so the
          `display: none` that hides an inactive tab does not reach it — without
          this it stayed on screen over whichever table you switched to. Its
          STATE is kept, like everything else in a hidden tab, so switching back
          restores the drawer and any edits composed in it. */}
      {active && itemView ? (
        <DynamoItemDrawer
          item={itemView}
          table={t}
          focusAttr={inspectingAttr}
          onDelete={() => setDeleteItem(itemView)}
          onClose={() => {
            setItemView(null);
            setInspectingRow(null);
            setInspectingAttr(null);
          }}
          onStage={(item) => stageItem(item, false)}
        />
      ) : null}

      {active && creating ? (
        <DynamoItemDrawer
          item={{}}
          table={t}
          create
          onClose={() => setCreating(false)}
          onStage={(item) => stageItem(item, true)}
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

      {/* The drawer's own delete — the same confirm, with a single key. */}
      {deleteItem ? (
        <DynamoDeleteModal
          handleId={handleId}
          table={t.name}
          isProduction={isProduction}
          keys={[keyOf(deleteItem)]}
          onClose={() => setDeleteItem(null)}
          onDone={() => {
            // The item is gone, so the drawer showing it has to go too.
            setDeleteItem(null);
            setItemView(null);
            setInspectingRow(null);
            setInspectingAttr(null);
            // Drop any staged edit to it — writing it back would resurrect the
            // item the user just deleted.
            setStaged((prev) => {
              const next = new Map(prev);
              next.delete(itemKeyOf(deleteItem, t.keySchema));
              return next;
            });
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
