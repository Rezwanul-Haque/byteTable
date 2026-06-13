// Redis keyspace sidebar (REDIS_SPEC §4) — ported from `redis.jsx`
// RedisSidebar. Top→bottom: connection header (SQL recipe) · db switcher row
// (storage button + db popover, dashboard, refresh) · MATCH glob input · type
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

import { appErrorMessage } from "../../../shared/api/error";
import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import type { KvDbInfo } from "../../connections/api";
import { kvScan, type KeyEntry, type KeyType } from "../api";
import {
  buildNamespaceTree,
  countLeaves,
  humanTTL,
  lastSegment,
  REDIS_TYPE_ORDER,
  REDIS_TYPES,
  type NamespaceNode,
} from "../helpers";
import { RedisTypeBadge } from "./RedisTypeBadge";
import "./RedisSidebar.css";

/** SCAN COUNT hint per round trip (work, not a result cap). */
const SCAN_COUNT = 200;
/** Indent per tree depth, in px (prototype `redis.jsx`). */
const TREE_INDENT = 13;
/** The number of databases a Redis connection exposes (REDIS_SPEC §2). */
const DB_COUNT = 16;

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
  /** Per-db key counts from the open-result overview (REDIS_SPEC §4 popover). */
  databases: KvDbInfo[];
  dbIndex: number;
  /** The active key tab's key name when it targets the selected db, else null. */
  activeKey: string | null;
  /** Re-scan trigger: bumps when the db/pattern/type change or a refresh fires. */
  version: number;
  onDbChange: (db: number) => void;
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
    databases,
    dbIndex,
    activeKey,
    version,
    onDbChange,
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // SCAN paging state.
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [cursor, setCursor] = useState("0");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True once the cursor has returned "0" for the current query (no more pages).
  const done = cursor === "0";

  const dbBtnRef = useRef<HTMLButtonElement | null>(null);
  const dbPopRef = useRef<HTMLDivElement | null>(null);
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
          pattern: pattern || "*",
          ...(typeFilter !== "all" ? { typeFilter } : {}),
          cursor: fromCursor,
          count: SCAN_COUNT,
        });
        setKeys((prev) => (append ? [...prev, ...page.keys] : page.keys));
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

  // Reset + load the first page whenever the query inputs change. `version`
  // is the refresh / write-invalidation nonce.
  useEffect(() => {
    // fetchPage closes over db/pattern/type (its identity changes with them);
    // `version` is the refresh / write-invalidation nonce, so re-run on it too.
    setKeys([]);
    setCursor("0");
    void fetchPage("0", false);
  }, [fetchPage, version]);

  const loadMore = useCallback(() => {
    if (loading || done) return;
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

  // Outside-click / Escape close the db popover (Sidebar/Rail pattern).
  useEffect(() => {
    if (!dbOpen) return;
    const onDown = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".rdb-pop, .redis-db-btn")
      )
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

  // One key row (flat + tree leaves share it). `display` is the visible label
  // (last segment in tree mode, full name flat).
  const keyRow = (name: string, display: string) => {
    const keyType = keyTypeByName.get(name) ?? "string";
    const ttl = ttlByName.get(name) ?? -1;
    const isActive = name === activeKey;
    return (
      <div
        key={name}
        className={"rkey-item" + (isActive ? " active" : "")}
        role="button"
        tabIndex={0}
        aria-current={isActive ? "true" : undefined}
        onClick={() => onOpenKey(dbIndex, name, keyType)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpenKey(dbIndex, name, keyType);
          }
        }}
        title={name + "  ·  " + keyType}
      >
        <RedisTypeBadge type={keyType} size={16} />
        <span className="rkey-name">{display}</span>
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
              {!isCollapsed ? (
                <div>{renderNode(child, path, depth + 1)}</div>
              ) : null}
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
          <div className="sidebar-conn-detail">
            {isTunneled ? (
              <span className="tunnel-lock" title={tunnelHint}>
                <Icon name="vpn_lock" size={11} style={{ color: "var(--accent)" }} />
              </span>
            ) : null}
            {detail}
          </div>
        </div>
        <IconBtn
          icon="power_settings_new"
          title="Close workspace"
          size={16}
          onClick={onCloseWorkspace}
        />
      </div>

      <div className="schema-row">
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
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <IconBtn icon="monitoring" title="Keyspace dashboard" onClick={onOpenDashboard} />
        <IconBtn
          icon="sync"
          title="Refresh keyspace"
          onClick={onRefresh}
          className={loading ? "sidebar-sync-spinning" : undefined}
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
            className="rview-toggle"
            title={view === "tree" ? "Switch to flat list" : "Switch to tree"}
            aria-label={view === "tree" ? "Switch to flat list" : "Switch to tree"}
            onClick={() => setView(view === "tree" ? "flat" : "tree")}
          >
            <Icon name={view === "tree" ? "account_tree" : "list"} size={14} />
          </button>
          <span className="sidebar-count">{matchCount}</span>
        </div>
      </div>

      <div className="rkey-list" ref={listRef} onScroll={onScroll}>
        {error !== null && keys.length === 0 ? (
          <div className="sidebar-error">{error}</div>
        ) : loading && keys.length === 0 ? (
          <div className="sidebar-loading">
            <span className="spinner" /> Scanning keys…
          </div>
        ) : matchCount === 0 ? (
          <div className="sidebar-nomatch">
            No keys match “{pattern}”
            {typeFilter !== "all" ? " · " + typeFilter : ""}
          </div>
        ) : (
          <>
            {view === "flat"
              ? sorted.map((k) => keyRow(k.name, k.name))
              : renderNode(tree, "", 0)}
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
    </aside>
  );
}
