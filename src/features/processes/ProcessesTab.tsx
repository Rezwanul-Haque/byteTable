// Processes tab (M26) — a TablePlus-style live session/operation/client list
// with filter, auto-refresh, selection, and per-row / bulk kill. Ported from
// the prototype's processes.jsx `ProcessesTab`, wired to the real backend
// (`processList` / `processKill`) instead of the mock churn engine.

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { appErrorMessage } from "../../shared/api/error";
import { Icon } from "../../shared/ui/Icon";
import { IconBtn } from "../../shared/ui/IconBtn";
import { ENV_COLOR } from "../../shared/ui/envColors";
import { normalizeEnv, type Engine } from "../../shared/types";
import { useToast } from "../../shared/ui/toastContext";
import {
  PROC_SOURCES,
  fmtProcTime,
  procNounPlural,
  procStateCls,
  processList,
  type ProcessInfo,
} from "./api";
import { KillProcessModal } from "./KillProcessModal";
import "../browse/shared/DataGrid.css";
import "./ProcessList.css";

const REFRESH_MS = 2500;

/** The resizable data columns (the fixed check/kill gutters bracket them). Each
 *  carries a default px width; a drag override lives in `colW`. Fixed px tracks
 *  + horizontal scroll mirror the SQL data grid's resize behaviour. */
const PROC_COL_DEFS = [
  { key: "pid", def: 120 },
  { key: "user", def: 140 },
  { key: "host", def: 180 },
  { key: "db", def: 120 },
  { key: "state", def: 130 },
  { key: "time", def: 90 },
  { key: "query", def: 360 },
] as const;

/** Minimum a column can be dragged to (matches the data grid's floor). */
const PROC_COL_MIN = 60;

export function ProcessesTab({
  handleId,
  engine,
  env,
  schemaName,
  isActive = true,
}: {
  handleId: string;
  engine: Engine;
  /** Connection deployment env (drives the kill modal's production gate). */
  env: string;
  /** The db/schema label shown in the DB column for a fresh listing. */
  schemaName?: string;
  /** False while the tab is not the visible one — pauses auto-refresh. */
  isActive?: boolean;
}) {
  const toast = useToast();
  const cfg = PROC_SOURCES[engine];
  const envColor = ENV_COLOR[normalizeEnv(env)] ?? ENV_COLOR.dev;

  const [procs, setProcs] = useState<ProcessInfo[]>([]);
  const [query, setQuery] = useState("");
  const [auto, setAuto] = useState(true);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [killTarget, setKillTarget] = useState<ProcessInfo[] | null>(null);
  const [colW, setColW] = useState<Record<string, number>>({});
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // A ref so the interval always calls the latest refresh without re-arming.
  const refresh = useRef<() => void>(() => {});
  refresh.current = () => {
    void (async () => {
      try {
        const next = await processList(handleId);
        setProcs(next);
        // Prune the selection to rows that still EXIST (drop vanished ones so the
        // count stays honest). Do NOT drop a pid merely because it is flagged
        // `is_self` this tick: for pooled SQL engines the pid running each
        // refresh's query hops between pool connections, so the self flag rotates
        // through rows — dropping on self would peel selections off one per tick.
        // The self row is instead hidden from the checkbox + excluded from the
        // kill set below (`checked = sel && !isSelf`, `selProcs` filters self),
        // so it can never be selected or killed while it is the active one.
        const present = new Set(next.map((p) => p.pid));
        setSel((s) => new Set([...s].filter((pid) => present.has(pid))));
        setError(null);
      } catch (err) {
        setError(appErrorMessage(err, "Could not read the process list."));
      } finally {
        setLastRefresh(new Date());
        setLoaded(true);
      }
    })();
  };

  // Initial load (and reload when the connection changes).
  useEffect(() => {
    if (!cfg) return;
    setLoaded(false);
    refresh.current();
  }, [handleId, cfg]);

  // Auto-refresh only while enabled AND the tab is the visible one.
  useEffect(() => {
    if (!cfg || !auto || !isActive) return;
    const t = setInterval(() => refresh.current(), REFRESH_MS);
    return () => clearInterval(t);
  }, [cfg, auto, isActive]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return procs;
    return procs.filter((p) =>
      [p.pid, p.user, p.host, p.db, p.state, p.query].join(" ").toLowerCase().includes(q),
    );
  }, [procs, query]);

  const active = procs.filter((p) => p.state === "active").length;
  const waiting = procs.filter((p) => procStateCls(p.state) === "warn").length;
  const noun = procNounPlural(engine);

  const toggleSel = (p: ProcessInfo) => {
    if (p.isSelf) return; // never select the app's own connection
    setSel((s) => {
      const n = new Set(s);
      if (n.has(p.pid)) n.delete(p.pid);
      else n.add(p.pid);
      return n;
    });
  };

  const onKilled = (killed: ProcessInfo[]) => {
    const keys = new Set(killed.map((p) => p.pid));
    setProcs((ps) => ps.filter((p) => !keys.has(p.pid)));
    setSel((s) => {
      const n = new Set(s);
      keys.forEach((k) => n.delete(k));
      return n;
    });
    const stmts = cfg ? killed.map((p) => cfg.kill(p)).join(" ") : "";
    toast(stmts + " — terminated", "ok");
  };

  // SQLite / DynamoDB / Cassandra: no server session list.
  if (!cfg) {
    return (
      <div className="proc-tab">
        <div className="empty-state">
          <Icon name="monitor_heart" size={40} style={{ color: "var(--text-faint)" }} />
          <p>No server processes</p>
          <span>
            {engine === "sqlite" ? "SQLite" : engine} is an embedded database — there is no server
            session list to inspect.
          </span>
        </div>
      </div>
    );
  }

  // Never include the app's own connection, even if a pooled-engine self-hop
  // briefly left its pid in the set before the next refresh prunes it.
  const selProcs = procs.filter((p) => sel.has(p.pid) && !p.isSelf);
  const L = cfg.labels ?? {};

  // Select-all over the currently-visible, non-self rows (the data grid's
  // header checkbox behaviour).
  const selectable = filtered.filter((p) => !p.isSelf);
  const allChecked = selectable.length > 0 && selectable.every((p) => sel.has(p.pid));
  const someChecked = !allChecked && selectable.some((p) => sel.has(p.pid));
  const toggleAll = () =>
    setSel((s) => {
      const n = new Set(s);
      if (allChecked) selectable.forEach((p) => n.delete(p.pid));
      else selectable.forEach((p) => n.add(p.pid));
      return n;
    });

  // Per-engine column headers + the resizable-column machinery.
  const colLabel: Record<string, string> = {
    pid: cfg.pidLabel,
    user: L.user ?? "User",
    host: L.host ?? "Host",
    db: L.db ?? "DB",
    state: L.state ?? "State",
    time: L.time ?? "Time",
    query: L.query ?? "Query",
  };
  // Shared grid template (check gutter + data columns + kill gutter), applied to
  // the header and every row so they stay aligned. A drag override in `colW`
  // wins over the column's default width.
  const template =
    "34px " + PROC_COL_DEFS.map((c) => (colW[c.key] ?? c.def) + "px").join(" ") + " 40px";

  // Drag a header's right-edge handle to set a manual px width (session-only);
  // double-click resets to the default. Mirrors the data grid's .dg-col-resize.
  const startResize = (e: ReactMouseEvent, key: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement;
    const startW = th ? th.getBoundingClientRect().width : PROC_COL_MIN;
    const startX = e.clientX;
    document.body.classList.add("dg-col-resizing");
    const onMove = (me: MouseEvent) => {
      const w = Math.max(PROC_COL_MIN, Math.round(startW + (me.clientX - startX)));
      setColW((prev) => ({ ...prev, [key]: w }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dg-col-resizing");
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
    <div className="proc-tab" data-screen-label="Processes">
      <div className="proc-toolbar">
        <Icon name="monitor_heart" size={16} style={{ color: "var(--accent)" }} />
        <span className="proc-title">Processes</span>
        <span className="proc-src" title="System source">
          {cfg.src}
        </span>
        <div className="proc-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            placeholder="Filter by user, host, state, query…"
            spellCheck="false"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button className="proc-search-x" onClick={() => setQuery("")}>
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </div>
        <div style={{ flex: 1 }}></div>
        <span className="proc-stat">
          <b>{procs.length}</b> {noun}
        </span>
        <span className="proc-stat run">
          <b>{active}</b> active
        </span>
        {waiting ? (
          <span className="proc-stat warn">
            <b>{waiting}</b> waiting
          </span>
        ) : null}
        <button
          className={"proc-auto" + (auto ? " on" : "")}
          onClick={() => setAuto(!auto)}
          title="Auto-refresh every 2.5s"
        >
          <Icon name="autorenew" size={13} /> auto
        </button>
        {/* Manual refresh only matters while auto is off — with the 2.5s poll
            running the list is already current, so the button would be noise. */}
        {auto ? null : (
          <IconBtn icon="refresh" title="Refresh now" onClick={() => refresh.current()} />
        )}
      </div>
      {selProcs.length ? (
        <div className="dg-selbar">
          <span className="dg-selbar-count">{selProcs.length} selected</span>
          <button className="proc-clear" onClick={() => setSel(new Set())}>
            Clear
          </button>
          <div style={{ flex: 1 }}></div>
          <button className="btn btn-danger proc-kill-sel" onClick={() => setKillTarget(selProcs)}>
            <Icon name="dangerous" size={15} /> <span>Kill selected…</span>
          </button>
        </div>
      ) : null}
      <div className="proc-grid-wrap">
        <div className="proc-grid">
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
                onChange={toggleAll}
              />
            </div>
            {PROC_COL_DEFS.map((c) => (
              <div className="dg-th" key={c.key}>
                <span className="dg-colname">{colLabel[c.key]}</span>
                <span
                  className="dg-col-resize"
                  title="Drag to resize · double-click to reset"
                  onMouseDown={(e) => startResize(e, c.key)}
                  onDoubleClick={() => resetCol(c.key)}
                />
              </div>
            ))}
            <div className="dg-th"></div>
          </div>
          {filtered.map((p) => (
            <div
              key={p.pid}
              className={"proc-grid-row" + (sel.has(p.pid) ? " row-selected" : "")}
              style={{ gridTemplateColumns: template }}
              onClick={() => toggleSel(p)}
            >
              <div className="dg-check-c">
                <input
                  type="checkbox"
                  className="dg-check"
                  checked={sel.has(p.pid) && !p.isSelf}
                  disabled={p.isSelf}
                  onChange={() => toggleSel(p)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              <div className="dg-td">
                {engine === "clickhouse" ? (p.qid ?? p.pid) : p.pid}
                {p.isSelf ? (
                  <span className="proc-self" title="This connection">
                    me
                  </span>
                ) : null}
              </div>
              <div className="dg-td">{p.user}</div>
              <div className="dg-td cell-dim">{p.host}</div>
              <div className="dg-td cell-dim">{p.db || schemaName}</div>
              <div className="dg-td">
                <span className={"proc-state " + procStateCls(p.state)}>{p.state}</span>
              </div>
              <div className="dg-td">{fmtProcTime(p.timeS)}</div>
              <div className="dg-td cell-text" title={p.query}>
                {p.query || <span className="cell-dim">—</span>}
              </div>
              <div className="dg-td proc-kill-cell">
                <button
                  className="proc-kill"
                  title={p.isSelf ? "This is your own connection" : "Kill process"}
                  disabled={p.isSelf}
                  onClick={(e) => {
                    e.stopPropagation();
                    setKillTarget([p]);
                  }}
                >
                  <Icon name="dangerous" size={14} />
                </button>
              </div>
            </div>
          ))}
          {filtered.length === 0 ? (
            <div className="dg-empty-body">
              {error ? (
                <span className="dg-error">
                  <Icon name="error" size={22} /> {error}
                </span>
              ) : !loaded ? (
                <>
                  <Icon name="autorenew" size={22} /> Loading…
                </>
              ) : query ? (
                <>
                  <Icon name="search_off" size={22} /> No processes match “{query}”
                </>
              ) : (
                <>
                  <Icon name="monitor_heart" size={22} /> No active {noun}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <div className="proc-foot">
        <span>Updated {lastRefresh ? lastRefresh.toLocaleTimeString() : "—"}</span>
        <div style={{ flex: 1 }}></div>
        <span className="dim">
          Click a row to select · kill terminates the {noun.slice(0, -1)} immediately
        </span>
      </div>
      {killTarget ? (
        <KillProcessModal
          handleId={handleId}
          procs={killTarget}
          engine={engine}
          env={env}
          envColor={envColor}
          onConfirm={onKilled}
          onClose={() => setKillTarget(null)}
        />
      ) : null}
    </div>
  );
}
