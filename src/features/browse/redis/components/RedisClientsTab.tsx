// Redis connected clients (M36 §A2/§A3) — the Redis-native replacement for the
// generic processes tab. `CLIENT LIST` is not a session list: the fields, the
// risks and the kill verbs are all Redis's own, so this tab models them
// directly instead of squeezing them into the shared `ProcessInfo` shape.
//
// Toolbar → type filter → search → auto-refresh → **Kill by filter**.
// Stats strip → connected · normal · pub/sub · replica · blocked · idle > 5m
// (a clickable filter) · total client memory.
// Table → every column sortable, default age descending, the kill column pinned
// to the right edge so it survives horizontal scroll.
//
// In cluster mode this list is understood as **per node** — `CLIENT LIST` never
// spans a cluster; it is the node this workspace is attached to.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { appErrorMessage } from "../../../../shared/api/error";
import { t as i18nT, type StringKey } from "../../../../shared/i18n";
import { useT } from "../../../../shared/i18n/useT";
import { Icon } from "../../../../shared/ui/Icon";
import { useReadOnly } from "../../../../shared/ui/readOnlyContext";
import { IconBtn } from "../../../../shared/ui/IconBtn";
import { ENV_COLOR } from "../../../../shared/ui/envColors";
import { normalizeEnv } from "../../../../shared/types";
import { useToast } from "../../../../shared/ui/toastContext";
import {
  kvClientKill,
  kvClientKillIds,
  kvClientList,
  kvClientNoEvict,
  kvClientUnpause,
  type KvClient,
} from "../api";
import {
  CLIENT_TYPE_COLOR,
  breakdown,
  clientRisk,
  humanAge,
  humanClientMem,
  isBlocked,
  isStale,
} from "../clients";
import { RedisClientInspector } from "./RedisClientInspector";
import { RedisKillFilter, type KillFilterRequest } from "./RedisKillFilter";
import { RedisKillClientsModal, type KillTarget } from "./RedisKillClientsModal";
import "../../shared/styles/DataGrid.css";
import "../../../processes/components/ProcessList.css";
import "./RedisClientsTab.css";

/** Auto-refresh cadence — the prototype's 2.5s. */
const REFRESH_MS = 2500;

/** The type segmented control's options — labels resolved from i18n at render. */
const TYPES: [
  string,
  "redis.ct.all" | "redis.ct.normal" | "redis.ct.pubsub" | "redis.ct.replica",
][] = [
  ["all", "redis.ct.all"],
  ["normal", "redis.ct.normal"],
  ["pubsub", "redis.ct.pubsub"],
  ["replica", "redis.ct.replica"],
];

/** The sortable columns, by the `KvClient` key they read. */
type SortCol = "id" | "name" | "addr" | "clientType" | "age" | "idle" | "totMem" | "cmd";

/**
 * The resizable data columns, in order — the fixed check and kill gutters
 * bracket them. Each carries a default px width; a drag override lives in
 * `colW`. Fixed px tracks + horizontal scroll is the SQL data grid's model,
 * which is what keeps this table looking like the rest of the app.
 */
const COL_DEFS: { key: SortCol; labelKey: string; def: number; num?: boolean }[] = [
  { key: "id", labelKey: "redis.ct.col.id", def: 110 },
  { key: "name", labelKey: "redis.ct.col.name", def: 150 },
  { key: "addr", labelKey: "redis.ct.col.addr", def: 190 },
  { key: "clientType", labelKey: "redis.ct.col.clientType", def: 110 },
  { key: "age", labelKey: "redis.ct.col.age", def: 90, num: true },
  { key: "idle", labelKey: "redis.ct.col.idle", def: 90, num: true },
  { key: "totMem", labelKey: "redis.ct.col.totMem", def: 110, num: true },
  { key: "cmd", labelKey: "redis.ct.col.cmd", def: 260 },
];

/** Minimum a column can be dragged to (matches the data grid's floor). */
const COL_MIN = 60;

/** Below this the Memory column is dropped — it is in the inspector, and the
 *  narrower the pane the more the command column is worth. Dropping it from
 *  the template (not hiding it with CSS) keeps the header and rows aligned. */
const MEMORY_MIN_WIDTH = 1240;

interface Sort {
  col: SortCol;
  dir: "asc" | "desc";
}

export function RedisClientsTab({
  handleId,
  env,
  isActive = true,
}: {
  handleId: string;
  /** Connection deployment env — drives the kill modal's production gate. */
  env: string;
  /** False while the tab is not the visible one — pauses auto-refresh. */
  isActive?: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const envColor = ENV_COLOR[normalizeEnv(env)] ?? ENV_COLOR.dev;

  const [clients, setClients] = useState<KvClient[]>([]);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [onlyIdle, setOnlyIdle] = useState(false);
  const [auto, setAuto] = useState(true);
  const [sel, setSel] = useState<Set<number>>(() => new Set());
  const [inspectId, setInspectId] = useState<number | null>(null);
  const [kill, setKill] = useState<KillTarget | null>(null);
  // Read-only workspace: the client list stays fully inspectable; the kill
  // verbs (per row, bulk, by filter) go.
  const readOnly = useReadOnly();
  const [filterOpen, setFilterOpen] = useState(false);
  const [sort, setSort] = useState<Sort>({ col: "age", dir: "desc" });
  const [updated, setUpdated] = useState<Date | null>(null);
  const [colW, setColW] = useState<Record<string, number>>({});
  const [resizing, setResizing] = useState<string | null>(null);
  // A media query rather than a CSS rule: the grid template is set inline, so
  // the column has to leave the template and the rows together or they skew.
  const [wideEnoughForMemory, setWideEnoughForMemory] = useState(
    () => typeof window === "undefined" || window.innerWidth > MEMORY_MIN_WIDTH,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: " + MEMORY_MIN_WIDTH + "px)");
    const apply = () => setWideEnoughForMemory(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // A ref so the interval always calls the latest refresh without re-arming.
  const refresh = useRef<() => void>(() => {});
  refresh.current = () => {
    void (async () => {
      try {
        const next = await kvClientList(handleId);
        setClients(next);
        // Prune the selection to connections that still exist, so the count
        // in the action bar never promises to kill a socket that already went.
        const present = new Set(next.map((c) => c.id));
        setSel((s) => new Set([...s].filter((id) => present.has(id))));
        setError(null);
      } catch (err) {
        setError(appErrorMessage(err, t("redis.ct.readFail")));
      } finally {
        setUpdated(new Date());
        setLoaded(true);
      }
    })();
  };

  useEffect(() => {
    setLoaded(false);
    refresh.current();
  }, [handleId]);

  useEffect(() => {
    if (!auto || !isActive) return;
    const t = setInterval(() => refresh.current(), REFRESH_MS);
    return () => clearInterval(t);
  }, [auto, isActive]);

  // Click-away closes the kill-by-filter popover (it is a popover, not a modal).
  useEffect(() => {
    if (!filterOpen) return;
    const close = () => setFilterOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [filterOpen]);

  const counts = useMemo(() => breakdown(clients), [clients]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = clients.filter(
      (c) =>
        (type === "all" ||
          c.clientType === type ||
          (type === "replica" && c.clientType === "master")) &&
        (!onlyIdle || isStale(c)) &&
        (needle === "" ||
          [c.id, c.name, c.addr, c.user, c.cmd, c.flags].join(" ").toLowerCase().includes(needle)),
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = a[sort.col];
      const vb = b[sort.col];
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [clients, query, type, onlyIdle, sort]);

  // Your own connection is never selectable — the kill would close the socket
  // the command itself travels over.
  const selected = clients.filter((c) => sel.has(c.id) && !c.isSelf);
  const inspected = clients.find((c) => c.id === inspectId) ?? null;

  const toggle = (id: number) =>
    setSel((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sortBy = (col: SortCol) =>
    setSort((s) => ({ col, dir: s.col === col && s.dir === "desc" ? "asc" : "desc" }));

  // Header checkbox over the currently-visible, non-self rows — the data
  // grid's select-all behaviour.
  const selectable = rows.filter((c) => !c.isSelf);
  const allChecked = selectable.length > 0 && selectable.every((c) => sel.has(c.id));
  const someChecked = !allChecked && selectable.some((c) => sel.has(c.id));
  const toggleAll = () =>
    setSel((s) => {
      const next = new Set(s);
      if (allChecked) selectable.forEach((c) => next.delete(c.id));
      else selectable.forEach((c) => next.add(c.id));
      return next;
    });

  /** After a kill lands: drop the rows, clear them, close a stale inspector. */
  const afterKill = useCallback(
    (hit: KvClient[], closed: number, cmd: string) => {
      const ids = new Set(hit.map((c) => c.id));
      setClients((cs) => cs.filter((c) => !ids.has(c.id)));
      setSel((s) => new Set([...s].filter((id) => !ids.has(id))));
      setInspectId((id) => (id !== null && ids.has(id) ? null : id));
      toast(t("redis.ct.killResult", { cmd: cmd.split("\n")[0] ?? "", count: closed }), "ok");
      // Re-read straight away: the server is the source of truth for what a
      // filter actually matched.
      refresh.current();
    },
    [toast, t],
  );

  /** Per-row / inspector kill: one id, no arming needed. */
  const killOne = (c: KvClient): KillTarget => ({
    clients: [c],
    cmd: "CLIENT KILL ID " + c.id,
    title: t("redis.ct.killOne", { id: c.id }),
    run: () => kvClientKillIds(handleId, [c.id]),
  });

  /** Multi-select kill: one `CLIENT KILL ID` per line, exactly as it runs. */
  const killSelected = (): KillTarget => ({
    clients: selected,
    cmd: selected.map((c) => "CLIENT KILL ID " + c.id).join("\n"),
    title: t("redis.ct.killSelected", { count: selected.length }),
    run: () =>
      kvClientKillIds(
        handleId,
        selected.map((c) => c.id),
      ),
  });

  /** Kill by filter: one server-side command, the count comes back from Redis. */
  const killByFilter = (request: KillFilterRequest): KillTarget => ({
    clients: request.matched,
    cmd: request.cmd,
    title: request.title,
    run: () => kvClientKill(handleId, request.filter, request.value),
  });

  const copyInfoLine = (line: string) => {
    void navigator.clipboard
      ?.writeText(line)
      .then(() => toast(t("redis.ct.infoCopied"), "ok"))
      .catch(() => toast(t("redis.ct.infoCopyFail"), "err"));
  };

  const noEvict = () => {
    void kvClientNoEvict(handleId, true).then(
      () => toast(t("redis.ct.noEvictOn"), "ok"),
      (err: unknown) => toast(appErrorMessage(err, t("redis.ct.noEvictFail")), "err"),
    );
  };

  const unpause = () => {
    void kvClientUnpause(handleId).then(
      () => toast(t("redis.ct.unpauseOk"), "ok"),
      (err: unknown) => toast(appErrorMessage(err, t("redis.ct.unpauseFail")), "err"),
    );
  };

  // Fixed px tracks + horizontal scroll, exactly like the SQL data grid: the
  // header and every row share one `grid-template-columns` so they stay
  // aligned, and a drag override lives in `colW`.
  const cols = COL_DEFS.filter((c) => c.key !== "totMem" || wideEnoughForMemory);
  const template = "34px " + cols.map((c) => (colW[c.key] ?? c.def) + "px").join(" ") + " 40px";

  // Drag a header's right-edge handle for a manual px width (session-only);
  // double-click resets. Mirrors ProcessesTab / the data grid.
  const startResize = (event: ReactMouseEvent, key: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // Without this the mousedown would also reach the header's sort handler.
    event.stopPropagation();
    const th = (event.currentTarget as HTMLElement).parentElement;
    const startW = th ? th.getBoundingClientRect().width : COL_MIN;
    const startX = event.clientX;
    setResizing(key);
    document.body.classList.add("dg-col-resizing");
    const onMove = (move: MouseEvent) => {
      const w = Math.max(COL_MIN, Math.round(startW + (move.clientX - startX)));
      setColW((prev) => ({ ...prev, [key]: w }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dg-col-resizing");
      setResizing(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const resetCol = (key: string) =>
    setColW((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  return (
    <div className="proc-tab rc-tab" data-screen-label="Redis clients">
      <div className="proc-toolbar">
        <Icon name="monitor_heart" size={16} style={{ color: "var(--accent)" }} />
        <span className="proc-title">{t("redis.connectedClients")}</span>
        <span className="proc-src" title={t("redis.ct.srcTitle")}>
          CLIENT LIST
        </span>
        <div className="rc-typeseg" role="group" aria-label={t("redis.ct.filterAria")}>
          {TYPES.map(([value, labelKey]) => {
            const n = value === "all" ? 0 : (counts[value as keyof typeof counts] as number);
            return (
              <button
                key={value}
                type="button"
                className={"seg-btn" + (type === value ? " active" : "")}
                onClick={() => setType(value)}
              >
                {t(labelKey)}
                {value !== "all" && n ? <em className="rc-seg-n">{n}</em> : null}
              </button>
            );
          })}
        </div>
        <div className="proc-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            placeholder={t("redis.ct.searchPh")}
            spellCheck="false"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button type="button" className="proc-search-x" onClick={() => setQuery("")}>
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </div>
        <div style={{ flex: 1 }} />
        {/* Manual refresh only earns its place while auto is paused — with the
            2.5s timer running, a "now" button is a button for waiting 2.5s
            less. It sits BEFORE the auto toggle so that hiding it moves
            nothing: everything to its right is packed against the toolbar's
            end and keeps its position, while a trailing button would make
            `auto` jump 28px every time it was toggled. */}
        {!auto ? (
          <IconBtn icon="refresh" title="CLIENT LIST now" onClick={() => refresh.current()} />
        ) : null}
        <button
          type="button"
          className={"proc-auto" + (auto ? " on" : "")}
          onClick={() => setAuto(!auto)}
          title={auto ? t("redis.ct.autoOn") : t("redis.ct.autoOff")}
        >
          <Icon name="autorenew" size={13} /> {t("redis.ct.auto")}
        </button>
        {/* In the toolbar, never in the wrapping stats strip — see the CSS note.
            Hidden in a read-only workspace: CLIENT KILL changes server state. */}
        <div className="rc-kf-wrap" onClick={(e) => e.stopPropagation()} hidden={readOnly}>
          <button
            type="button"
            className="rc-kfbtn"
            onClick={() => setFilterOpen((v) => !v)}
            aria-expanded={filterOpen}
          >
            <Icon name="filter_alt" size={14} />
            {t("redis.ct.killByFilter")}
          </button>
          {filterOpen ? (
            <RedisKillFilter
              clients={clients}
              onClose={() => setFilterOpen(false)}
              onRun={(request) => {
                setFilterOpen(false);
                setKill(killByFilter(request));
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="rc-stats">
        <div className="rc-stat">
          <b>{counts.total}</b>
          <span>{t("redis.ct.stConnected")}</span>
        </div>
        <div className="rc-stat">
          <b style={{ color: CLIENT_TYPE_COLOR.normal }}>{counts.normal}</b>
          <span>{t("redis.ct.stNormal")}</span>
        </div>
        <div className="rc-stat">
          <b style={{ color: CLIENT_TYPE_COLOR.pubsub }}>{counts.pubsub}</b>
          <span>{t("redis.ct.stPubsub")}</span>
        </div>
        <div className="rc-stat">
          <b style={{ color: CLIENT_TYPE_COLOR.replica }}>{counts.replica}</b>
          <span>{t("redis.ct.stReplica")}</span>
        </div>
        <div className="rc-stat">
          <b>{counts.blocked}</b>
          <span>{t("redis.ct.stBlocked")}</span>
        </div>
        <button
          type="button"
          className={
            "rc-stat rc-stat-btn" + (onlyIdle ? " on" : "") + (counts.stale ? " warn" : "")
          }
          onClick={() => setOnlyIdle((v) => !v)}
          title={t("redis.ct.staleTitle")}
        >
          <b>{counts.stale}</b>
          <span>{t("redis.ct.stIdle")}</span>
        </button>
        <div className="rc-stat">
          <b>{humanClientMem(counts.mem)}</b>
          <span>{t("redis.ct.stMem")}</span>
        </div>
      </div>

      {selected.length ? (
        <div className="dg-selbar">
          <span className="dg-selbar-count">
            {t("ws.grid.selected", { count: selected.length })}
          </span>
          <button type="button" className="proc-clear" onClick={() => setSel(new Set())}>
            {t("redis.ct.clear")}
          </button>
          <div style={{ flex: 1 }} />
          {readOnly ? null : (
            <button
              type="button"
              className="btn btn-danger proc-kill-sel"
              onClick={() => setKill(killSelected())}
            >
              <Icon name="dangerous" size={15} />
              <span>{t("redis.ct.killSelectedBtn")}</span>
            </button>
          )}
        </div>
      ) : null}

      <div className="rc-body">
        <div className="proc-grid-wrap">
          <div className="proc-grid rc-grid">
            <div className="dg-header proc-grid-row" style={{ gridTemplateColumns: template }}>
              <div className="dg-check-c dg-check-h">
                <input
                  type="checkbox"
                  className="dg-check"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked;
                  }}
                  disabled={selectable.length === 0}
                  aria-label={t("redis.ct.selectAllAria")}
                  onChange={toggleAll}
                />
              </div>
              {cols.map((c) => (
                <div
                  key={c.key}
                  className={"dg-th sortable" + (c.num ? " rc-num" : "")}
                  onClick={() => sortBy(c.key)}
                  aria-sort={
                    sort.col === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  <span className="dg-colname">{i18nT(c.labelKey as StringKey)}</span>
                  {sort.col === c.key ? (
                    <Icon
                      name={sort.dir === "desc" ? "arrow_drop_down" : "arrow_drop_up"}
                      size={14}
                      style={{ color: "var(--accent)" }}
                    />
                  ) : null}
                  <span
                    className={"dg-col-resize" + (resizing === c.key ? " active" : "")}
                    title={t("redis.ct.resizeTitle")}
                    onMouseDown={(e) => startResize(e, c.key)}
                    onDoubleClick={() => resetCol(c.key)}
                  />
                </div>
              ))}
              <div className="dg-th rc-kill-c" />
            </div>
            {rows.map((c) => {
              const risk = clientRisk(c);
              const color = CLIENT_TYPE_COLOR[c.clientType] ?? "var(--text-faint)";
              return (
                <div
                  key={c.id}
                  className={
                    "proc-grid-row" +
                    (sel.has(c.id) ? " row-selected" : "") +
                    (inspectId === c.id ? " rc-open" : "")
                  }
                  style={{ gridTemplateColumns: template }}
                  onClick={() => setInspectId(inspectId === c.id ? null : c.id)}
                >
                  <div className="dg-check-c">
                    <input
                      type="checkbox"
                      className="dg-check"
                      checked={sel.has(c.id) && !c.isSelf}
                      disabled={c.isSelf}
                      title={c.isSelf ? t("redis.ct.selfTitle") : undefined}
                      aria-label={t("redis.ct.selectAria", { id: c.id })}
                      onChange={() => toggle(c.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  <div className="dg-td">
                    {c.id}
                    {c.isSelf ? (
                      <span className="proc-self" title={t("redis.ct.thisConn")}>
                        me
                      </span>
                    ) : null}
                  </div>
                  <div className="dg-td">{c.name || <span className="cell-dim">—</span>}</div>
                  <div className="dg-td cell-dim">{c.addr}</div>
                  <div className="dg-td">
                    <span
                      className="rc-type"
                      style={{
                        color,
                        background: "color-mix(in oklab, " + color + " 13%, transparent)",
                      }}
                    >
                      {c.clientType}
                    </span>
                  </div>
                  <div className="dg-td rc-num">{humanAge(c.age)}</div>
                  <div className={"dg-td rc-num" + (risk?.sev === "warn" ? " rc-hot" : "")}>
                    {isBlocked(c) ? (
                      <span className="cell-dim">{t("redis.ct.blockedCell")}</span>
                    ) : (
                      humanAge(c.idle)
                    )}
                  </div>
                  {wideEnoughForMemory ? (
                    <div className="dg-td rc-num cell-dim">{humanClientMem(c.totMem)}</div>
                  ) : null}
                  <div className="dg-td cell-text" title={c.cmd}>
                    <span className="rc-cmd">{c.cmd || "—"}</span>
                  </div>
                  <div className="dg-td rc-kill-c">
                    <button
                      type="button"
                      className="proc-kill"
                      disabled={c.isSelf || readOnly}
                      title={
                        readOnly
                          ? t("ws.readOnly.title")
                          : c.isSelf
                            ? t("redis.ct.selfTitle")
                            : "CLIENT KILL ID " + c.id
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        setKill(killOne(c));
                      }}
                    >
                      <Icon name="dangerous" size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
            {rows.length === 0 ? (
              <div className="dg-empty-body">
                {error ? (
                  <span className="dg-error">
                    <Icon name="error" size={22} /> {error}
                  </span>
                ) : !loaded ? (
                  <>
                    <Icon name="autorenew" size={22} /> {t("redis.ct.loading")}
                  </>
                ) : (
                  <>
                    <Icon name="search_off" size={22} /> {t("redis.ct.noMatch")}
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
        {inspected ? (
          <RedisClientInspector
            client={inspected}
            onClose={() => setInspectId(null)}
            onKill={(c) => setKill(killOne(c))}
            onNoEvict={noEvict}
            onUnpause={unpause}
            onCopyInfoLine={copyInfoLine}
          />
        ) : null}
      </div>

      <div className="proc-foot">
        <span>
          {t("redis.ct.updatedAt", { time: updated ? updated.toLocaleTimeString() : "—" })}
        </span>
        <div style={{ flex: 1 }} />
        <span className="dim">{t("redis.ct.footHint")}</span>
      </div>

      {kill ? (
        <RedisKillClientsModal
          target={kill}
          env={env}
          envColor={envColor}
          onConfirm={afterKill}
          onClose={() => setKill(null)}
        />
      ) : null}
    </div>
  );
}
