// Redis keyspace sidebar (REDIS_SPEC §4) — ported from `redis.jsx`
// RedisSidebar. Top→bottom: connection header (SQL recipe) · scope row (the db
// switcher, or in cluster mode the node picker) · MATCH glob input · type
// filter chips · KEYS section label with a tree⇄flat toggle + match count ·
// the SCAN-backed key list (flat or namespace tree) · a "New CLI console"
// footer.
//
// Listing uses cursor-based SCAN (REDIS_SPEC §0/§2 — never a blocking
// KEYS *): the first page loads on mount / when db|pattern|type|version
// changes; "Load more" pages until the cursor returns "0". Type + TTL come
// enriched in each ScanPage key.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { save } from "@tauri-apps/plugin-dialog";

import { exportSave } from "../../../../shared/api/engine";
import { appErrorMessage } from "../../../../shared/api/error";
import { BulkDeleteModal } from "../../../../shared/ui/BulkDeleteModal";
import { Btn } from "../../../../shared/ui/Btn";
import { EngineBadge } from "../../../../shared/ui/EngineBadge";
import { Icon } from "../../../../shared/ui/Icon";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { useToast } from "../../../../shared/ui/toastContext";
import { LanguageChip } from "../../../../shared/ui/LanguageChip";
import type { KvDbInfo } from "../../../connections/api";
import {
  dbScopeId,
  kvCommand,
  kvDeleteKey,
  kvGetKey,
  kvScan,
  type KeyType,
  type ClusterNode,
  type ClusterTopology,
  type KeyEntry,
  type KvValue,
} from "../api";
import { ScopeSplitAction, ScopeSplitHint } from "../../../workspaces/components/ScopeSplitAction";
import {
  buildNamespaceTree,
  countLeaves,
  humanTTL,
  lastSegment,
  mergeKeys,
  REDIS_TYPE_ORDER,
  REDIS_TYPES,
  type NamespaceNode,
} from "../helpers";
import { allNodes, shardName } from "../cluster";
import { ClusterNodePicker } from "./ClusterNodePicker";
import { RedisTypeBadge } from "./RedisTypeBadge";
import "./RedisSidebar.css";
// `.cl-scope` / `.cl-np-*` — the cluster keyspace chip and its node picker.
import "./ClusterDashboard.css";

/** SCAN COUNT hint per round trip (work, not a result cap). */
const SCAN_COUNT = 200;
/**
 * How many pages the refresh will re-scan to restore what the user had paged
 * in. Bounded because the refresh is on a timer: without a cap, someone who
 * pressed "Load more" fifty times would fire fifty SCANs every tick. Past the
 * cap the tree keeps its head fresh and leaves the tail as it was.
 */
const MAX_REFRESH_PAGES = 25;
/** Indent per tree depth, in px (prototype `redis.jsx`). */
const TREE_INDENT = 13;
/** The number of databases a Redis connection exposes (REDIS_SPEC §2). */
const DB_COUNT = 16;

/** Turn the MATCH box's raw text into the glob sent to `SCAN MATCH`. A bare
 *  term (no glob metacharacters) is wrapped as `*term*` so typing "session"
 *  matches "session:abc" — the substring behavior users expect. An empty box
 *  means "everything" (`*`); anything containing `* ? [ ]` is treated as an
 *  explicit glob and passed through verbatim. */
function scanGlob(raw: string): string {
  const t = raw.trim();
  if (t === "") return "*";
  return /[*?[\]]/.test(t) ? t : `*${t}*`;
}

interface RedisSidebarProps {
  /** Workspace identity for the header (color/name/env/detail/tunnel). */
  workspaceColor: string;
  workspaceName: string;
  envColor: string;
  envLabel: string;
  detail: string;
  isTunneled: boolean;
  tunnelHint: string;
  handleId: string;
  /**
   * The cluster topology when this connection is a cluster node, else null
   * (M36 §B3). Cluster mode rejects `SELECT`, so the db switcher is replaced —
   * not by nothing, but by a NODE picker: a cluster has one database and N
   * nodes, and which node you are attached to decides which slots (and so
   * which keys) `SCAN` can see.
   */
  cluster: ClusterTopology | null;
  /**
   * Attach the workspace to another cluster node. Omitted for a standalone
   * connection; when omitted the chip renders inert.
   */
  onPickNode?: (node: ClusterNode) => void;
  /** True while a node switch is in flight (the chip spins, rows disable). */
  nodeSwitching?: boolean;
  /** Per-db key counts from the open-result overview (REDIS_SPEC §4 popover). */
  databases: KvDbInfo[];
  dbIndex: number;
  /** The active key tab's key name when it targets the selected db, else null. */
  activeKey: string | null;
  /** Re-scan trigger: bumps when the db/pattern/type change or a refresh fires. */
  version: number;
  onDbChange: (db: number) => void;
  /** Db scope ids (`db3`) that already have their own workspace (M33). */
  openedScopes: string[];
  /** Open (or focus) a db as its own workspace, nested in the rail. */
  onOpenScopeWorkspace: (scope: string) => void;
  onRefresh: () => void;
  onOpenKey: (db: number, key: string, keyType: KeyType) => void;
  onOpenCli: () => void;
  onOpenDashboard: () => void;
  onCloseWorkspace: () => void;
}

export function RedisSidebar(props: RedisSidebarProps) {
  const {
    workspaceColor,
    workspaceName,
    envColor,
    envLabel,
    detail,
    isTunneled,
    tunnelHint,
    handleId,
    cluster,
    onPickNode,
    nodeSwitching = false,
    databases,
    dbIndex,
    activeKey,
    version,
    onDbChange,
    openedScopes,
    onOpenScopeWorkspace,
    onRefresh,
    onOpenKey,
    onOpenCli,
    onOpenDashboard,
    onCloseWorkspace,
  } = props;

  // Transient local UI (prototype keeps these local; reset with the component).
  const [pattern, setPattern] = useState("*");
  const [typeFilter, setTypeFilter] = useState<KeyType | "all">("all");
  const [view, setView] = useState<"tree" | "flat">("tree");
  const [dbOpen, setDbOpen] = useState(false);
  const [nodeOpen, setNodeOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Multi-select for bulk delete / export. `selectMode` swaps key-row clicks
  // from "open" to "toggle"; selection is by full key name.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const toast = useToast();
  const isProduction = envLabel === "production";

  // SCAN paging state.
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [cursor, setCursor] = useState("0");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True once the cursor has returned "0" for the current query (no more pages).
  const done = cursor === "0";

  // Spin the refresh icon for one rotation on every keyspace refresh (manual,
  // a write, a db switch, or the auto-refresh timer) so the periodic refresh is
  // visible — the scan itself is usually too fast to see otherwise.
  const [refreshSpin, setRefreshSpin] = useState(false);
  useEffect(() => {
    setRefreshSpin(true);
    const id = setTimeout(() => setRefreshSpin(false), 700);
    return () => clearTimeout(id);
  }, [version]);

  const dbBtnRef = useRef<HTMLButtonElement | null>(null);
  const dbPopRef = useRef<HTMLDivElement | null>(null);
  const nodePickRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Per-db key counts from the overview (the popover + the db button label).
  const dbCounts = useMemo(() => {
    const counts = new Array<number>(DB_COUNT).fill(0);
    for (const d of databases) {
      if (d.index >= 0 && d.index < DB_COUNT) counts[d.index] = d.keyCount;
    }
    return counts;
  }, [databases]);

  // Fetch one page from `fromCursor`, replacing the list when it is a fresh
  // query (cursor "0" + reset) or appending on "Load more".
  const fetchPage = useCallback(
    async (fromCursor: string, append: boolean) => {
      setLoading(true);
      try {
        const page = await kvScan(handleId, dbIndex, {
          pattern: scanGlob(pattern),
          ...(typeFilter !== "all" ? { typeFilter } : {}),
          cursor: fromCursor,
          count: SCAN_COUNT,
        });
        // Merged, not concatenated: SCAN may hand back a key it already gave
        // us on an earlier page (see `mergeKeys`).
        setKeys((prev) => (append ? mergeKeys(prev, page.keys) : page.keys));
        setCursor(page.cursor);
        setError(null);
      } catch (err) {
        setError(appErrorMessage(err, "Could not scan the keyspace."));
        if (!append) setKeys([]);
      } finally {
        setLoading(false);
      }
    },
    [handleId, dbIndex, pattern, typeFilter],
  );

  // How many pages the user has paged in. A refresh has to restore this depth:
  // re-scanning only page 1 would throw away everything "Load more" fetched,
  // which the 10s auto-refresh timer then does over and over — the list grows,
  // vanishes, and the button comes back.
  const pagesRef = useRef(1);

  // Re-scan from the start up to `pages` pages and replace the list in one go.
  // Cursors are not resumable across scans, so restoring depth means walking
  // the pages again rather than picking up where the last one stopped.
  const refetchPages = useCallback(
    async (pages: number) => {
      setLoading(true);
      try {
        let all: KeyEntry[] = [];
        let cur = "0";
        let fetched = 0;
        do {
          const page = await kvScan(handleId, dbIndex, {
            pattern: scanGlob(pattern),
            ...(typeFilter !== "all" ? { typeFilter } : {}),
            cursor: cur,
            count: SCAN_COUNT,
          });
          all = mergeKeys(all, page.keys);
          cur = page.cursor;
          fetched += 1;
        } while (cur !== "0" && fetched < pages);
        // One setState at the end, so the tree never flashes a partial list.
        setKeys(all);
        setCursor(cur);
        setError(null);
      } catch (err) {
        setError(appErrorMessage(err, "Could not scan the keyspace."));
        setKeys([]);
      } finally {
        setLoading(false);
      }
    },
    [handleId, dbIndex, pattern, typeFilter],
  );

  // Reload whenever the query inputs change or `version` bumps (manual refresh,
  // a write, or the auto-refresh timer). A query change hard-resets to one page
  // (clear → show loading); a version-only bump re-scans the depth the user had
  // already paged to and replaces in place, so neither the tree nor the scroll
  // position jumps every tick.
  const queryKey = handleId + "|" + dbIndex + "|" + pattern + "|" + typeFilter;
  const lastQueryKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastQueryKeyRef.current !== queryKey) {
      lastQueryKeyRef.current = queryKey;
      pagesRef.current = 1;
      setKeys([]); // hard reset only when the query itself changed
    }
    void refetchPages(Math.min(pagesRef.current, MAX_REFRESH_PAGES));
    // refetchPages' identity already encodes the query inputs; `version` adds
    // the refresh nonce. queryKey is derived from the same inputs (lint-listed
    // for completeness).
  }, [refetchPages, version, queryKey]);

  const loadMore = useCallback(() => {
    if (loading || done) return;
    pagesRef.current += 1;
    void fetchPage(cursor, true);
  }, [loading, done, fetchPage, cursor]);

  // Infinite scroll: load the next page when the user nears the bottom.
  const onScroll = () => {
    const el = listRef.current;
    if (!el || loading || done) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) loadMore();
  };

  // Sort keys by name for a stable list (SCAN returns them cursor-ordered).
  const sorted = useMemo(() => [...keys].sort((a, b) => a.name.localeCompare(b.name)), [keys]);
  const keyTypeByName = useMemo(() => {
    const m = new Map<string, KeyType>();
    for (const k of keys) m.set(k.name, k.keyType);
    return m;
  }, [keys]);
  const ttlByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k.name, k.ttl);
    return m;
  }, [keys]);

  // The cluster node this connection is attached to, from CLUSTER NODES'
  // `myself` flag — the server's own answer, not something we track locally,
  // so it stays right across a switch.
  const currentNode = useMemo(
    () => (cluster ? (allNodes(cluster.shards).find((n) => n.myself) ?? null) : null),
    [cluster],
  );
  const currentShard = useMemo(() => {
    if (!cluster || !currentNode) return null;
    return (
      cluster.shards.find(
        (s) => s.master.id === currentNode.id || s.replicas.some((r) => r.id === currentNode.id),
      ) ?? null
    );
  }, [cluster, currentNode]);

  // In cluster mode the header names the node this handle is actually attached
  // to. `detail` is the SAVED endpoint, which stops being true the moment the
  // node picker repoints the workspace.
  const nodeDetail = currentNode ? currentNode.host + ":" + currentNode.port + " · db0" : null;

  // Outside-click / Escape close the node picker.
  useEffect(() => {
    if (!nodeOpen) return;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && nodePickRef.current?.contains(event.target)) return;
      setNodeOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNodeOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [nodeOpen]);

  // Outside-click / Escape close the db popover (Sidebar/Rail pattern).
  useEffect(() => {
    if (!dbOpen) return;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".rdb-pop, .redis-db-btn"))
        return;
      setDbOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDbOpen(false);
      dbBtnRef.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", () => setDbOpen(false));
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dbOpen]);

  // Focus into the popover on open (a11y).
  useEffect(() => {
    if (!dbOpen) return;
    const pop = dbPopRef.current;
    (
      pop?.querySelector<HTMLElement>("[aria-checked='true']") ??
      pop?.querySelector<HTMLElement>("[role^='menuitem']")
    )?.focus();
  }, [dbOpen]);

  const onPopKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role^='menuitem']"),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const cur = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (key === "Home") next = 0;
    else if (key === "End") next = items.length - 1;
    else if (key === "ArrowDown") next = cur < 0 ? 0 : (cur + 1) % items.length;
    else next = cur <= 0 ? items.length - 1 : cur - 1;
    items[next]?.focus();
  };

  const selectDb = (db: number) => {
    onDbChange(db);
    setDbOpen(false);
    dbBtnRef.current?.focus();
  };

  // Copy a key + its value to the clipboard as a tab-separated pair (pastes
  // cleanly into a sheet or as plain text). Fetches the value on demand.
  const copyKeyValue = async (name: string) => {
    try {
      const view = await kvGetKey(handleId, dbIndex, name);
      await navigator.clipboard.writeText(name + "\t" + valueToText(view.value));
      toast("Key + value copied", "ok");
    } catch (err) {
      toast(appErrorMessage(err, "Couldn't copy this key's value."), "err");
    }
  };

  // Delete a single key (DEL) straight from the tree — matches the direct,
  // no-modal delete the set-member remove buttons use.
  const deleteKey = async (name: string) => {
    try {
      await kvDeleteKey(handleId, dbIndex, name);
      toast("DEL " + name + " — OK", "ok");
      onRefresh();
    } catch (err) {
      toast(appErrorMessage(err, "Couldn't delete this key."), "err");
    }
  };

  // One key row (flat + tree leaves share it). `display` is the visible label
  // (last segment in tree mode, full name flat).
  const keyRow = (name: string, display: string) => {
    const keyType = keyTypeByName.get(name) ?? "string";
    const ttl = ttlByName.get(name) ?? -1;
    const isActive = name === activeKey;
    const checked = selectedKeys.has(name);
    const activate = () => (selectMode ? toggleKey(name) : onOpenKey(dbIndex, name, keyType));
    return (
      <div
        key={name}
        className={"rkey-item" + (isActive ? " active" : "") + (checked ? " selected" : "")}
        role="button"
        tabIndex={0}
        aria-current={isActive ? "true" : undefined}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activate();
          }
        }}
        title={name + "  ·  " + keyType}
      >
        {selectMode ? (
          <input
            type="checkbox"
            className="rkey-check"
            checked={checked}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleKey(name)}
            aria-label={"Select " + name}
          />
        ) : null}
        <RedisTypeBadge type={keyType} size={16} />
        <span className="rkey-name">{display}</span>
        {!selectMode ? (
          <>
            <IconBtn
              icon="content_copy"
              size={12}
              className="rkey-copy"
              title="Copy key + value"
              onClick={(e) => {
                e.stopPropagation();
                void copyKeyValue(name);
              }}
            />
            <IconBtn
              icon="delete"
              size={12}
              danger
              className="rkey-del"
              title="Delete key (DEL)"
              onClick={(e) => {
                e.stopPropagation();
                void deleteKey(name);
              }}
            />
          </>
        ) : null}
        <span className={"rkey-ttl" + (ttl >= 0 ? " live" : "")}>{humanTTL(ttl)}</span>
      </div>
    );
  };

  const tree = useMemo(() => buildNamespaceTree(sorted.map((k) => k.name)), [sorted]);

  const renderNode = (node: NamespaceNode, prefix: string, depth: number) => {
    const childNames = Object.keys(node.children).sort();
    return (
      <>
        {childNames.map((seg) => {
          const child = node.children[seg];
          if (!child) return null;
          const path = prefix + seg + ":";
          const isCollapsed = collapsed[path] ?? false;
          const count = countLeaves(child);
          return (
            <div key={path}>
              <div
                className="rns-row"
                role="button"
                tabIndex={0}
                aria-expanded={!isCollapsed}
                style={{ paddingLeft: 8 + depth * TREE_INDENT }}
                onClick={() => setCollapsed((c) => ({ ...c, [path]: !isCollapsed }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setCollapsed((c) => ({ ...c, [path]: !isCollapsed }));
                  }
                }}
              >
                <Icon
                  name={isCollapsed ? "chevron_right" : "expand_more"}
                  size={14}
                  style={{ color: "var(--text-faint)" }}
                />
                <Icon name="folder" size={13} style={{ color: "var(--text-faint)" }} />
                <span className="rns-name">{seg}</span>
                <span className="rns-count">{count}</span>
              </div>
              {!isCollapsed ? <div>{renderNode(child, path, depth + 1)}</div> : null}
            </div>
          );
        })}
        {node.keys.map((name) => (
          <div key={name} style={{ paddingLeft: depth * TREE_INDENT }}>
            {keyRow(name, lastSegment(name))}
          </div>
        ))}
      </>
    );
  };

  const matchCount = sorted.length;

  // The KEYS badge counts what is LOADED, not what exists — the list is paged,
  // so "200" with 406 keys on the server reads as a total and makes the "Load
  // more" button below it look like a bug. Show the denominator when there is
  // an honest one: `INFO keyspace`'s count for this db (per node in cluster
  // mode) is comparable only while nothing narrows the scan. Under a MATCH
  // glob or a type filter the server filters too, so `12 / 406` would be a
  // lie — the badge says `12+` instead, which claims only that more may come.
  const narrowed = scanGlob(pattern) !== "*" || typeFilter !== "all";
  const dbTotal = dbCounts[dbIndex] ?? 0;
  // Only quote a denominator we can stand behind: unfiltered, non-zero, and not
  // already behind what is on screen (INFO keyspace can lag a scan by a tick).
  const showTotal = !narrowed && dbTotal > 0 && dbTotal >= matchCount;
  const countLabel = done
    ? String(matchCount)
    : showTotal
      ? matchCount + " / " + dbTotal
      : matchCount + "+";
  const countTitle = done
    ? matchCount + (matchCount === 1 ? " key" : " keys")
    : showTotal
      ? matchCount +
        " of " +
        dbTotal +
        " keys loaded — the list pages through SCAN, so Load more fetches the rest"
      : matchCount +
        (matchCount === 1 ? " key" : " keys") +
        " loaded so far — Load more to keep scanning";

  // Drop the selection whenever the query inputs change (the list is replaced).
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [dbIndex, pattern, typeFilter, version]);

  const toggleKey = (name: string) =>
    setSelectedKeys((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const allLoadedSelected = matchCount > 0 && selectedKeys.size === matchCount;
  const toggleSelectAll = () =>
    setSelectedKeys(allLoadedSelected ? new Set() : new Set(sorted.map((k) => k.name)));
  const exitSelect = () => {
    setSelectMode(false);
    setSelectedKeys(new Set());
  };

  const deleteSelected = async () => {
    const names = [...selectedKeys];
    const reply = await kvCommand(handleId, dbIndex, ["DEL", ...names]);
    if (reply.kind === "error") throw new Error(reply.value);
    const removed = reply.kind === "int" ? reply.value : names.length;
    toast(`Deleted ${removed} key${removed === 1 ? "" : "s"} · db${dbIndex}`, "ok");
    onRefresh();
  };

  // Serialize a typed Redis value to a single CSV cell.
  const valueToText = (v: KvValue): string => {
    switch (v.type) {
      case "str":
        return v.value;
      case "list":
        return JSON.stringify(v.items);
      case "set":
        return JSON.stringify(v.members);
      case "hash":
        return JSON.stringify(Object.fromEntries(v.fields.map((f) => [f.field, f.value])));
      case "zset":
        return JSON.stringify(v.entries.map((e) => [e.member, e.score]));
      case "stream":
        return JSON.stringify(v.entries);
      case "missing":
        return "";
    }
  };

  const exportSelectedCsv = async () => {
    const names = [...selectedKeys];
    if (!names.length) return;
    const esc = (s: string) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    try {
      const views = await Promise.all(names.map((name) => kvGetKey(handleId, dbIndex, name)));
      const csv = ["key,type,value"]
        .concat(
          views.map((view, i) =>
            [esc(names[i] ?? ""), esc(view.keyType), esc(valueToText(view.value))].join(","),
          ),
        )
        .join("\n");
      const path = await save({
        defaultPath: `redis-db${dbIndex}-selection.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await exportSave(path, csv);
      toast(`Exported ${names.length} key${names.length === 1 ? "" : "s"} to CSV`, "ok");
    } catch (e) {
      toast(appErrorMessage(e, "Could not export CSV"), "err");
    }
  };

  return (
    <aside className="redis-sidebar" data-screen-label={"Redis workspace: " + workspaceName}>
      <div className="sidebar-conn">
        <span className="ws-color-bar" style={{ background: workspaceColor }} />
        <EngineBadge engine="redis" size={26} />
        <div className="sidebar-conn-info">
          <div className="sidebar-conn-name">
            {workspaceName}
            <span className="env-dot" style={{ background: envColor }} title={envLabel} />
          </div>
          <div className="sidebar-conn-detail" title={nodeDetail ? detail + " (configured)" : ""}>
            {isTunneled ? (
              <span className="tunnel-lock" title={tunnelHint}>
                <Icon name="vpn_lock" size={11} style={{ color: "var(--accent)" }} />
              </span>
            ) : null}
            {/* After a node switch this line must name the node actually being
                talked to, not the endpoint the connection was configured with —
                otherwise the header claims :7001 while every command goes to
                :7005. The configured endpoint stays in the tooltip. */}
            {nodeDetail ?? detail}
          </div>
        </div>
        <LanguageChip />
        <IconBtn
          icon="power_settings_new"
          title="Close workspace"
          size={16}
          danger
          onClick={onCloseWorkspace}
        />
      </div>

      <div className="schema-row">
        {/* Cluster mode exposes a single logical keyspace and rejects SELECT, so
            the db switcher is replaced by a locked chip — offering db0–db15
            would be offering a command that errors. */}
        {cluster ? (
          // Not a db switcher — a NODE switcher. Cluster mode has one database,
          // so `SELECT` stays unavailable; but `SCAN` answers for the node you
          // are attached to, so reaching another shard's keys means attaching
          // to the node that owns those slots.
          <div ref={nodePickRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <button
              type="button"
              className="cl-scope"
              disabled={!onPickNode || nodeSwitching}
              onClick={() => setNodeOpen((open) => !open)}
              aria-haspopup="dialog"
              aria-expanded={nodeOpen}
              title={
                currentNode
                  ? "Browsing the " +
                    currentNode.role +
                    " " +
                    currentNode.host +
                    ":" +
                    currentNode.port +
                    (currentShard ? " of " + shardName(currentShard) : "") +
                    (currentNode.role === "replica"
                      ? " — reads are served in READONLY mode and may lag its master."
                      : ".") +
                    " Click to browse another node; a cluster has one database, so SELECT is not available."
                  : "Cluster mode exposes a single logical keyspace — SELECT is not available"
              }
            >
              <Icon name="lan" size={15} style={{ color: "var(--accent)" }} />
              <span className="cl-scope-name">
                {currentShard ? shardName(currentShard) : "cluster keyspace"}
              </span>
              {/* A shard is a master AND its replicas, so the shard name alone
                  does not say which one you are on — and it matters: a replica
                  serves reads in READONLY mode and may lag its master.
                  This takes the slot the node's key count briefly had: at the
                  default sidebar width the chip fits the name, one tag and the
                  chevron, and the count is already in the `200 / 406` KEYS
                  badge below while the role is shown nowhere else. */}
              {currentNode ? (
                <span className={"cl-role " + currentNode.role}>{currentNode.role}</span>
              ) : null}
              <Icon
                name={nodeSwitching ? "autorenew" : "expand_more"}
                size={15}
                style={{ color: "var(--text-faint)" }}
                className={nodeSwitching ? "sidebar-sync-spinning" : undefined}
              />
            </button>
            {nodeOpen && onPickNode ? (
              <ClusterNodePicker
                topology={cluster}
                busy={nodeSwitching}
                onClose={() => setNodeOpen(false)}
                onPick={(node) => {
                  setNodeOpen(false);
                  onPickNode(node);
                }}
              />
            ) : null}
          </div>
        ) : (
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <button
              ref={dbBtnRef}
              type="button"
              className="schema-btn redis-db-btn"
              onClick={() => setDbOpen((o) => !o)}
              title="Switch database"
              aria-haspopup="menu"
              aria-expanded={dbOpen}
            >
              <Icon name="storage" size={15} style={{ color: "var(--accent)" }} />
              <span className="schema-btn-name">db{dbIndex}</span>
              <span className="rdb-keycount">{dbCounts[dbIndex]} keys</span>
              <Icon name="expand_more" size={15} style={{ color: "var(--text-faint)" }} />
            </button>
            {dbOpen ? (
              <div
                ref={dbPopRef}
                className="schema-pop rdb-pop"
                role="menu"
                aria-label="Switch database"
                onKeyDown={onPopKeyDown}
              >
                {dbCounts.map((count, index) => (
                  <button
                    key={index}
                    type="button"
                    role="menuitemradio"
                    aria-checked={index === dbIndex}
                    className={
                      "schema-pop-item" +
                      (index === dbIndex ? " active" : "") +
                      (count === 0 ? " empty" : "")
                    }
                    onClick={() => selectDb(index)}
                  >
                    <Icon name="storage" size={14} />
                    <span>db{index}</span>
                    <span className="schema-pop-count">{count}</span>
                    <ScopeSplitAction
                      scope={dbScopeId(index)}
                      label={"db" + index}
                      opened={openedScopes.includes(dbScopeId(index))}
                      onOpen={(scope) => {
                        setDbOpen(false);
                        onOpenScopeWorkspace(scope);
                      }}
                    />
                  </button>
                ))}
                <ScopeSplitHint />
              </div>
            ) : null}
          </div>
        )}
        <IconBtn
          icon={cluster ? "lan" : "monitoring"}
          title={cluster ? "Cluster dashboard" : "Keyspace dashboard"}
          onClick={onOpenDashboard}
        />
        <IconBtn
          icon="sync"
          title="Refresh keyspace"
          onClick={onRefresh}
          className={refreshSpin || loading ? "sidebar-sync-spinning" : undefined}
        />
      </div>

      <div className="sidebar-search">
        <span className="match-label">MATCH</span>
        <input
          placeholder="*"
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          spellCheck="false"
          aria-label="MATCH glob pattern"
        />
        {pattern && pattern !== "*" ? (
          <IconBtn icon="close" size={13} title="Reset" onClick={() => setPattern("*")} />
        ) : null}
      </div>

      <div className="rtype-chips" role="group" aria-label="Filter by type">
        <button
          type="button"
          className={"rtype-chip" + (typeFilter === "all" ? " active" : "")}
          aria-pressed={typeFilter === "all"}
          onClick={() => setTypeFilter("all")}
        >
          all
        </button>
        {REDIS_TYPE_ORDER.map((t) => {
          const active = typeFilter === t;
          return (
            <button
              key={t}
              type="button"
              className={"rtype-chip" + (active ? " active" : "")}
              aria-pressed={active}
              style={
                active
                  ? { color: REDIS_TYPES[t].color, borderColor: REDIS_TYPES[t].color + "88" }
                  : undefined
              }
              onClick={() => setTypeFilter(active ? "all" : t)}
            >
              {REDIS_TYPES[t].label}
            </button>
          );
        })}
      </div>

      <div className="sidebar-section-label">
        <span>Keys</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            className={"rview-toggle" + (selectMode ? " active" : "")}
            title={selectMode ? "Exit selection" : "Select keys (bulk delete / export)"}
            aria-label={selectMode ? "Exit selection" : "Select keys"}
            aria-pressed={selectMode}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
          >
            <Icon name="checklist" size={14} />
          </button>
          <button
            type="button"
            className="rview-toggle"
            title={view === "tree" ? "Switch to flat list" : "Switch to tree"}
            aria-label={view === "tree" ? "Switch to flat list" : "Switch to tree"}
            onClick={() => setView(view === "tree" ? "flat" : "tree")}
          >
            <Icon name={view === "tree" ? "account_tree" : "list"} size={14} />
          </button>
          <span className="sidebar-count" title={countTitle}>
            {countLabel}
          </span>
        </div>
      </div>

      {selectMode ? (
        <div className="rkey-selbar">
          <label className="rkey-selall">
            <input
              type="checkbox"
              className="rkey-check"
              checked={allLoadedSelected}
              ref={(el) => {
                if (el) el.indeterminate = selectedKeys.size > 0 && !allLoadedSelected;
              }}
              onChange={toggleSelectAll}
              aria-label="Select all loaded keys"
            />
            <span>{selectedKeys.size} selected</span>
          </label>
          <div style={{ flex: 1 }} />
          <IconBtn
            icon="download"
            size={15}
            title="Export selected to CSV"
            disabled={selectedKeys.size === 0}
            onClick={() => void exportSelectedCsv()}
          />
          <IconBtn
            icon="delete"
            size={15}
            title="Delete selected"
            className="rkey-selbar-del"
            disabled={selectedKeys.size === 0}
            onClick={() => setDeleteOpen(true)}
          />
        </div>
      ) : null}

      <div className="rkey-list" ref={listRef} onScroll={onScroll}>
        {error !== null && keys.length === 0 ? (
          <div className="sidebar-error">{error}</div>
        ) : loading && keys.length === 0 ? (
          <div className="sidebar-loading">
            <span className="spinner" /> Scanning keys…
          </div>
        ) : matchCount === 0 ? (
          <div className="sidebar-nomatch">
            No keys match “{pattern}”{typeFilter !== "all" ? " · " + typeFilter : ""}
          </div>
        ) : (
          <>
            {view === "flat" ? sorted.map((k) => keyRow(k.name, k.name)) : renderNode(tree, "", 0)}
            {!done ? (
              <div className="rkey-loadmore">
                {loading ? (
                  <>
                    <span className="spinner" /> Loading more…
                  </>
                ) : (
                  <Btn variant="text" small onClick={loadMore}>
                    Load more
                  </Btn>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <Btn
          icon="terminal"
          variant="tonal"
          onClick={onOpenCli}
          style={{ width: "100%", justifyContent: "center" }}
        >
          New CLI console
        </Btn>
      </div>

      {deleteOpen && selectedKeys.size > 0 ? (
        <BulkDeleteModal
          count={selectedKeys.size}
          target={"db" + dbIndex}
          noun="key"
          isProduction={isProduction}
          onConfirm={deleteSelected}
          onClose={() => setDeleteOpen(false)}
          onDone={exitSelect}
        />
      ) : null}
    </aside>
  );
}
