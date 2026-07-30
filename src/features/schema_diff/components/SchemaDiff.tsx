// Schema Diff & Sync (M28) — ported from the prototype's `schemadiff.jsx`.
//
// Compare the STRUCTURE of two SQL schemas, show the per-table / per-column
// diff, expose the Change DDL, and — in sync mode — apply a checkbox-selected,
// one-transaction migration that makes the target match the source.
//
// **Structure only. Row data is never read, copied, or moved.** The backend
// read port can only return columns and indexes, and every surface here repeats
// the promise (banner chip, DDL modal, review modal, success card).
//
// Two modes of the same component:
//   - `compareOnly` — diff pane only. Roles read Schema A / Schema B, the arrow
//     is ⇄, chips read "only in A" / "only in B". The workspace `diff` tab and
//     the connect screen's "Compare schemas…" modal use this.
//   - sync — diff + migration plan, review + production gate, apply.
//
// Where the prototype held every schema in memory, we read two live databases:
// each side is resolved to a handle (reusing an open workspace when there is
// one — see handles.ts), snapshotted once, and cached for the life of the
// comparison, so swapping direction re-diffs without touching either database.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { exportSave } from "../../../shared/api/engine";
import { Icon } from "../../../shared/ui/Icon";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { useToast } from "../../../shared/ui/toastContext";
import { normalizeEnv, type Engine } from "../../../shared/types";
import { connectionDetail, type SavedConnection } from "../../connections/api";
import { useConnectionsStore } from "../../connections/state";
import { saveDialog } from "../../export/exportFlow";
import { useWorkspacesStore } from "../../workspaces/state";
import {
  schemaDiffApply,
  schemaDiffCompare,
  schemaSnapshot,
  type ColumnDiff,
  type MigrationStatement,
  type SchemaComparison,
  type SchemaSnapshot,
  type TableDiff,
} from "../api";
import { acquireHandle, isDiffable, releaseHandle, type DiffHandle } from "../handles";
import { highlightSql } from "../highlight";
import "./SchemaDiff.css";

/**
 * Per-engine badge for the connection cards — the app's own engine identity
 * (short tag + tint, as in `EngineBadge`) rather than the prototype's private
 * table, so a card reads the same as every other engine badge in ByteTable.
 */
const SD_ENGINE: Partial<Record<Engine, { short: string; color: string; name: string }>> = {
  postgres: { short: "Pg", color: "#61afef", name: "PostgreSQL" },
  mysql: { short: "My", color: "#e2b340", name: "MySQL" },
  sqlite: { short: "SQ", color: "#56b6c2", name: "SQLite" },
};

function engineName(engine: Engine): string {
  return SD_ENGINE[engine]?.name ?? engine;
}

/** A planned statement plus its checkbox state (destructive ones start off). */
interface PlanItem extends MigrationStatement {
  on: boolean;
}

/** Highlighted SQL, as spans — never `dangerouslySetInnerHTML`. */
function SqlText({ sql }: { sql: string }) {
  return (
    <>
      {highlightSql(sql).map((token, i) =>
        token.cls === null ? (
          <span key={i}>{token.text}</span>
        ) : (
          <span key={i} className={"sd-" + token.cls}>
            {token.text}
          </span>
        ),
      )}
    </>
  );
}

interface SdConnCardProps {
  conn: SavedConnection | null;
  role: string;
  isTarget?: boolean;
  options: SavedConnection[];
  onChange: (id: string) => void;
  /** The schema this side reads; `null` until the connection has been opened. */
  schema: string | null;
  /** Every schema the connection exposes; empty while it is being opened. */
  schemas: string[];
  onSchemaChange: (schema: string) => void;
  /** Stands in for the schema name until one is known (open in flight/failed). */
  pendingLabel?: string;
}

/**
 * One side of the direction bar: engine badge, the connection name with an
 * invisible full-width `<select>` picker, its env tag, and a detail line
 * carrying a second picker for the **schema** — most databases hold several,
 * and either side of the diff must be able to point at any of them.
 * `conn === null` renders the dashed "Choose a schema…" state.
 *
 * The host:port detail moves to the card's hover tooltip, the same trade the
 * sidebar header makes when its detail line is needed for something else.
 */
function SdConnCard({
  conn,
  role,
  isTarget,
  options,
  onChange,
  schema,
  schemas,
  onSchemaChange,
  pendingLabel = "opening…",
}: SdConnCardProps) {
  const optionLabel = (o: SavedConnection) =>
    o.name + " · " + engineName(o.engine) + " · " + normalizeEnv(o.env);

  if (!conn) {
    return (
      <div className="sd-dir-col">
        <div className="sd-role">{role}</div>
        <div className="sd-conn-card empty">
          <div
            className="sd-eng"
            style={{
              background: "color-mix(in oklab, var(--text-faint) 14%, transparent)",
              color: "var(--text-faint)",
            }}
          >
            <Icon name="database" size={15} />
          </div>
          <div className="sd-conn-meta">
            <div className="sd-conn-name">
              <span className="sd-conn-picker">
                <span className="sd-conn-label" style={{ color: "var(--text-faint)" }}>
                  Choose a schema…
                </span>
                <Icon name="arrow_drop_down" size={16} style={{ color: "var(--text-faint)" }} />
                <select
                  className="sd-conn-overlay"
                  value=""
                  onChange={(e) => e.target.value && onChange(e.target.value)}
                  title="Pick a connection"
                  aria-label={role}
                >
                  <option value="" disabled>
                    Choose a schema…
                  </option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {optionLabel(o)}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            <div className="sd-conn-detail">Not selected</div>
          </div>
        </div>
      </div>
    );
  }

  const meta = SD_ENGINE[conn.engine];
  const color = meta?.color ?? "#888";
  const envColor = conn.color ?? ENV_COLOR[normalizeEnv(conn.env)];
  return (
    <div className="sd-dir-col">
      <div className="sd-role">{role}</div>
      <div
        className={"sd-conn-card" + (isTarget ? " target" : "")}
        title={connectionDetail(conn.params)}
      >
        <div
          className="sd-eng"
          style={{ background: "color-mix(in oklab, " + color + " 20%, transparent)", color }}
        >
          {meta?.short ?? "??"}
        </div>
        <div className="sd-conn-meta">
          <div className="sd-conn-name">
            <span className="sd-conn-picker">
              <span className="sd-conn-label">{conn.name}</span>
              <Icon name="arrow_drop_down" size={16} style={{ color: "var(--text-faint)" }} />
              <select
                className="sd-conn-overlay"
                value={conn.id}
                onChange={(e) => onChange(e.target.value)}
                title="Pick a connection"
                aria-label={role}
              >
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {optionLabel(o)}
                  </option>
                ))}
              </select>
            </span>
            <span
              className="sd-env"
              style={{
                color: envColor,
                borderColor: "color-mix(in oklab, " + envColor + " 45%, transparent)",
                background: "color-mix(in oklab, " + envColor + " 12%, transparent)",
              }}
            >
              {normalizeEnv(conn.env)}
            </span>
          </div>
          <div className="sd-conn-detail">
            {engineName(conn.engine)} ·{" "}
            {schemas.length > 0 ? (
              <span className="sd-conn-picker sd-schema-picker">
                <span className="sd-schema-label">{schema}</span>
                <Icon name="arrow_drop_down" size={13} style={{ color: "var(--text-faint)" }} />
                <select
                  className="sd-conn-overlay"
                  value={schema ?? ""}
                  onChange={(e) => onSchemaChange(e.target.value)}
                  title="Pick a schema"
                  aria-label={role + " schema"}
                >
                  {schemas.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </span>
            ) : (
              <span className="sd-schema-label">{schema ?? pendingLabel}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The `+n ~n -n` counts for one changed table. */
function deltaCounts(cols: ColumnDiff[]) {
  let added = 0;
  let modified = 0;
  let dropped = 0;
  for (const c of cols) {
    if (c.mk === "+" || c.mk === "+idx") added++;
    else if (c.mk === "~") modified++;
    else if (c.mk === "-" || c.mk === "-idx") dropped++;
  }
  return { added, modified, dropped };
}

interface SdTableRowProps {
  table: TableDiff;
  open: boolean;
  onToggle: () => void;
  compareOnly?: boolean;
}

/** One expandable table row of the diff pane. Identical tables never expand. */
function SdTableRow({ table, open, onToggle, compareOnly }: SdTableRowProps) {
  const counts = deltaCounts(table.cols);
  const chip: [string, string] =
    table.status === "new"
      ? ["new", compareOnly ? "Only in A" : "New table"]
      : table.status === "changed"
        ? ["changed", "Changed"]
        : table.status === "only-target"
          ? ["drop", compareOnly ? "Only in B" : "Only in target"]
          : ["same", "Identical"];
  const icon =
    table.status === "new"
      ? "add_box"
      : table.status === "only-target"
        ? "indeterminate_check_box"
        : "table_chart";
  const expandable = table.status !== "same";

  return (
    <div className="sd-tbl">
      <button
        type="button"
        className={"sd-tbl-head" + (expandable ? "" : " static")}
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? open : undefined}
      >
        <Icon
          name="chevron_right"
          size={18}
          style={{
            color: "var(--text-faint)",
            transform: open && expandable ? "rotate(90deg)" : "none",
            transition: "transform .12s",
          }}
        />
        <Icon name={icon} size={16} style={{ color: "var(--text-faint)" }} />
        <span className="sd-tbl-name">{table.name}</span>
        <div className="sd-tbl-stat">
          {table.status === "changed" ? (
            <span className="sd-delta">
              {counts.added > 0 ? <span className="pos">+{counts.added}</span> : null}
              {counts.added > 0 && (counts.modified > 0 || counts.dropped > 0) ? " " : ""}
              {counts.modified > 0 ? <span className="mod">~{counts.modified}</span> : null}
              {counts.modified > 0 && counts.dropped > 0 ? " " : ""}
              {counts.dropped > 0 ? <span className="neg">-{counts.dropped}</span> : null}
            </span>
          ) : null}
          {table.status === "same" ? (
            <span className="sd-delta">{table.delta} · in sync</span>
          ) : null}
          <span className={"sd-chip " + chip[0]}>{chip[1]}</span>
        </div>
      </button>
      {expandable && open ? (
        <div className="sd-cols">
          {table.cols.map((c, i) => {
            const cls =
              c.mk === "+" || c.mk === "+idx"
                ? "add"
                : c.mk === "-" || c.mk === "-idx"
                  ? "drop"
                  : c.mk === "~"
                    ? "alter"
                    : "same";
            const mark =
              c.mk === "+idx"
                ? "+"
                : c.mk === "-idx" || c.mk === "-"
                  ? "−"
                  : c.mk === "="
                    ? "·"
                    : c.mk;
            const isIndex = c.mk === "+idx" || c.mk === "-idx";
            return (
              <div className={"sd-col " + cls} key={c.mk + c.name + i}>
                <span className="sd-mk">{mark}</span>
                <span className="sd-col-badge">
                  {c.pk ? (
                    <Icon name="key" size={13} style={{ color: "var(--warn, #e2b340)" }} />
                  ) : isIndex ? (
                    <span className="sd-idx-tag">idx</span>
                  ) : null}
                </span>
                <span className="sd-col-nm">{c.name}</span>
                <span className="sd-col-type">
                  {c.mk === "~" ? (
                    <>
                      <span className="sd-type-old">{c.old}</span>
                      <Icon name="east" size={13} style={{ color: "var(--change, #5aa7f5)" }} />
                      <span className="sd-type-new">{c.type}</span>
                    </>
                  ) : (
                    <span>{c.type}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export interface SchemaDiffProps {
  /**
   * The connection the diff was opened from. It lands on the RIGHT (Schema B /
   * target): you are standing on it, and you compare some *other* schema into
   * it. Absent (the connect screen) → both cards start unselected.
   */
  currentConn?: SavedConnection | null;
  /** Diff pane only — no migration pane, no apply. A/B wording and ⇄. */
  compareOnly?: boolean;
}

export function SchemaDiff({ currentConn, compareOnly }: SchemaDiffProps) {
  const toast = useToast();
  const savedConnections = useConnectionsStore((s) => s.savedConnections);
  const loadConnections = useConnectionsStore((s) => s.load);
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  const [srcId, setSrcId] = useState<string | null>(null); // never preselected
  const [tgtId, setTgtId] = useState<string | null>(null);
  // Which schema each side reads. `null` = not resolved yet (the connection is
  // still being opened); once resolved the user can point either side at any
  // other schema the connection exposes — a database usually holds several, and
  // comparing two schemas of the SAME connection is a legitimate diff.
  const [srcSchema, setSrcSchema] = useState<string | null>(null);
  const [tgtSchema, setTgtSchema] = useState<string | null>(null);
  /** Schema names per connection id, filled in as connections are opened. */
  const [connSchemas, setConnSchemas] = useState<Record<string, string[]>>({});
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});
  const [comparison, setComparison] = useState<SchemaComparison | null>(null);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by "Try again" — re-runs the resolve/diff effects for the same pair. */
  const [retryTick, setRetryTick] = useState(0);
  const [confirm, setConfirm] = useState("");
  const [appliedKey, setAppliedKey] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [ddlOpen, setDdlOpen] = useState(false);

  // Live connections + their snapshots, cached for the life of the comparison.
  // Refs, not state: nothing renders off them directly, and a re-render must
  // never reopen a connection.
  const handles = useRef(new Map<string, DiffHandle>());
  const snapshots = useRef(new Map<string, SchemaSnapshot>());
  /**
   * Opens still in flight, keyed by connection id. Without this, two callers
   * that both find the `handles` map empty (the effect below and a snapshot
   * read, or React's StrictMode double-invoking the effect) each start their
   * own `connection_open`, and the loser's handle is overwritten in the map and
   * leaks — it is never closed.
   */
  const opening = useRef(new Map<string, Promise<DiffHandle>>());
  /** False once unmounted, so a late open closes itself instead of leaking. */
  const alive = useRef(true);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // Release every handle this diff opened. Borrowed workspace handles are left
  // alone — the workspace owns them.
  useEffect(() => {
    const opened = handles.current;
    const inFlight = opening.current;
    alive.current = true;
    return () => {
      alive.current = false;
      for (const handle of opened.values()) void releaseHandle(handle);
      opened.clear();
      // An open that lands after unmount has no owner — close it as it arrives.
      for (const pending of inFlight.values()) {
        void pending.then(releaseHandle).catch(() => undefined);
      }
      inFlight.clear();
    };
  }, []);

  const eligible = useMemo(() => savedConnections.filter(isDiffable), [savedConnections]);
  const byId = useMemo(
    () => Object.fromEntries(eligible.map((c) => [c.id, c])) as Record<string, SavedConnection>,
    [eligible],
  );

  // Home side: the schema you opened the diff from sits on the right. Runs once
  // the registry has loaded, and only when there IS a home connection — the
  // connect screen deliberately starts with both cards empty.
  const homeApplied = useRef(false);
  useEffect(() => {
    if (homeApplied.current || !currentConn || eligible.length === 0) return;
    homeApplied.current = true;
    const home = eligible.some((c) => c.id === currentConn.id)
      ? currentConn.id
      : (eligible.find((c) => normalizeEnv(c.env) === "production")?.id ?? eligible[0]?.id ?? null);
    setTgtId(home);
  }, [currentConn, eligible]);

  const source = srcId ? (byId[srcId] ?? null) : null;
  const target = tgtId ? (byId[tgtId] ?? null) : null;
  // The pair is (connection, schema) on both sides — switching schema on one
  // connection is as much a new comparison as switching connection.
  const pairKey = srcId + "." + srcSchema + "->" + tgtId + "." + tgtSchema;
  const targetIsProd = target !== null && normalizeEnv(target.env) === "production";
  const samePlace = srcId === tgtId && srcSchema === tgtSchema;
  const synced = !!source && !!target && (appliedKey === pairKey || samePlace);

  // A workspace already holding this connection lends its handle, the schema the
  // user is standing on, and its schema list; anything else is opened
  // transiently.
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const borrow = useCallback((connectionId: string) => {
    const ws = workspacesRef.current.find((w) => w.saved.id === connectionId && w.kind === "sql");
    if (!ws) return null;
    const schema =
      ws.ui.schemaName !== undefined && ws.schemas.some((s) => s.name === ws.ui.schemaName)
        ? ws.ui.schemaName
        : ws.schemas[0]?.name;
    // A SQL workspace always lists at least one schema; if one somehow does
    // not, open the connection transiently rather than guess a schema name.
    if (schema === undefined) return null;
    return { handleId: ws.handleId, schema, schemas: ws.schemas.map((s) => s.name) };
  }, []);

  const handleFor = useCallback(
    (conn: SavedConnection): Promise<DiffHandle> => {
      const open = handles.current.get(conn.id);
      if (open) return Promise.resolve(open);
      const already = opening.current.get(conn.id);
      if (already) return already;
      const pending = acquireHandle(conn, borrow).then((handle) => {
        // Unmounted while it was opening: close it rather than cache it.
        if (!alive.current) {
          void releaseHandle(handle);
          return handle;
        }
        handles.current.set(conn.id, handle);
        setConnSchemas((s) => ({ ...s, [conn.id]: handle.schemas }));
        return handle;
      });
      opening.current.set(conn.id, pending);
      void pending.catch(() => undefined).finally(() => opening.current.delete(conn.id));
      return pending;
    },
    [borrow],
  );

  // Opening a side resolves its handle, which is what fills the schema picker
  // and seeds the schema the side starts on. Runs per side so each card becomes
  // usable as soon as its own connection is open.
  //
  // A failure MUST land in `error`: the side keeps `schema === null`, and a null
  // schema is what "still opening" looks like — so without the error the card
  // would sit at "opening…" and the pane would spin forever.
  useEffect(() => {
    if (!source || srcSchema !== null) return;
    let cancelled = false;
    void handleFor(source)
      .then((handle) => {
        if (!cancelled) setSrcSchema(handle.schema);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(appErrorMessage(err, "Could not open " + source.name + "."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, srcSchema, handleFor, retryTick]);

  useEffect(() => {
    if (!target || tgtSchema !== null) return;
    let cancelled = false;
    void handleFor(target)
      .then((handle) => {
        if (!cancelled) setTgtSchema(handle.schema);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(appErrorMessage(err, "Could not open " + target.name + "."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [target, tgtSchema, handleFor, retryTick]);

  const snapshotFor = useCallback(
    async (conn: SavedConnection, schema: string): Promise<SchemaSnapshot> => {
      // Cached per (connection, schema): switching schema and switching back
      // costs nothing, and two schemas of one connection never collide.
      const key = conn.id + "::" + schema;
      const cached = snapshots.current.get(key);
      if (cached) return cached;
      const handle = await handleFor(conn);
      const snap = await schemaSnapshot(handle.handleId, schema);
      snapshots.current.set(key, snap);
      return snap;
    },
    [handleFor],
  );

  // Diff whenever the pair changes. Both snapshots are read (once each), then
  // compared on the backend; `synced` short-circuits to the identical state.
  useEffect(() => {
    if (!source || !target || srcSchema === null || tgtSchema === null || synced) {
      setComparison(null);
      setPlan([]);
      // MUST clear `busy` too: this branch is reached when a side is swapped out
      // mid-comparison, and a `busy` left over from the previous pair would spin
      // forever — the next run that could clear it never starts.
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const [sourceSnap, targetSnap] = await Promise.all([
          snapshotFor(source, srcSchema),
          snapshotFor(target, tgtSchema),
        ]);
        if (cancelled) return;
        const result = await schemaDiffCompare(sourceSnap, targetSnap, target.engine);
        if (cancelled) return;
        setComparison(result);
        setPlan(result.statements.map((s) => ({ ...s, on: !s.destructive })));
        // Auto-expand everything that differs; identical tables stay collapsed.
        const opened: Record<string, boolean> = {};
        for (const t of result.tables) if (t.status !== "same") opened[t.name] = true;
        setOpenTables(opened);
        setConfirm("");
      } catch (err) {
        if (cancelled) return;
        setComparison(null);
        setPlan([]);
        setError(appErrorMessage(err, "Could not read both schemas."));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, target, srcSchema, tgtSchema, synced, snapshotFor, retryTick]);

  // Picking a connection resets that side's schema: the new connection's own
  // schema list decides where the side lands (the resolve effect above). Any
  // pick also clears a previous failure — the new choice deserves its own try.
  const pickSource = (id: string) => {
    setSrcId(id);
    setSrcSchema(null);
    setAppliedKey(null);
    setError(null);
  };
  const pickTarget = (id: string) => {
    setTgtId(id);
    setTgtSchema(null);
    setAppliedKey(null);
    setError(null);
  };
  const swap = () => {
    if (!srcId) return;
    setSrcId(tgtId);
    setSrcSchema(tgtSchema);
    setTgtId(srcId);
    setTgtSchema(srcSchema);
    setAppliedKey(null);
    setError(null);
  };
  /** Retry the same pair after a failure (re-picking it would be a no-op). */
  const retry = () => {
    setError(null);
    setRetryTick((n) => n + 1);
  };
  const toggleStatement = (id: number) =>
    setPlan((p) => p.map((s) => (s.id === id ? { ...s, on: !s.on } : s)));
  const toggleTable = (name: string) =>
    setOpenTables((o) => ({ ...o, [name]: !(o[name] ?? false) }));

  const diff = comparison?.tables ?? [];
  // A side whose connection is still opening has no schema yet — that reads as
  // "working", not as "nothing to show". An error ends it: a side that failed to
  // open never gets a schema, so without this the spinner would never stop.
  const resolving =
    error === null && ((!!source && srcSchema === null) || (!!target && tgtSchema === null));
  const selected = plan.filter((s) => s.on);
  const destructiveOn = selected.filter((s) => s.destructive).length;
  const gateOk = !targetIsProd || confirm.trim() === (target?.name ?? "");
  const canReview = selected.length > 0 && !applying;

  const stats = useMemo(() => {
    let tablesNew = 0;
    let colsAdd = 0;
    let colsAlter = 0;
    let destructive = 0;
    for (const s of plan) {
      if (s.kind === "create") tablesNew++;
      else if (s.kind === "col-add") colsAdd++;
      else if (s.kind === "col-alter") colsAlter++;
      if (s.destructive) destructive++;
    }
    return { tablesNew, colsAdd, colsAlter, destructive };
  }, [plan]);

  const engName = target ? engineName(target.engine) : "";
  const arrow = compareOnly ? " ⇄ " : " → ";
  /** "connection · schema" — a side is a schema, not just a connection. */
  const sideLabel = (conn: SavedConnection, schema: string | null) =>
    schema === null ? conn.name : conn.name + " · " + schema;

  const doApply = () => {
    const handle = target ? handles.current.get(target.id) : undefined;
    if (!target || !handle || tgtSchema === null || selected.length === 0) return;
    setApplying(true);
    void schemaDiffApply(
      handle.handleId,
      // The schema the target card points at — NOT the connection's default.
      tgtSchema,
      // Strip the UI-only checkbox flag — the wire type is the planner's.
      selected.map((s) => ({
        id: s.id,
        kind: s.kind,
        sql: s.sql,
        table: s.table,
        destructive: s.destructive,
      })),
    )
      .then((count) => {
        // That schema's structure changed — drop its cached snapshot so any
        // later comparison reads reality, not the pre-migration shape.
        snapshots.current.delete(target.id + "::" + tgtSchema);
        setReviewOpen(false);
        setAppliedKey(pairKey);
        setDoneOpen(true);
        toast(
          count + " structural change" + (count !== 1 ? "s" : "") + " applied to " + target.name,
          "ok",
        );
      })
      .catch((err: unknown) => {
        toast(appErrorMessage(err, "The migration could not be applied."), "err");
      })
      .finally(() => setApplying(false));
  };

  const exportSql = () => {
    if (!source || !target || selected.length === 0) return;
    const slug = (name: string) => name.replace(/\W+/g, "_").toLowerCase();
    const text = selected.map((s) => s.sql).join("\n") + "\n";
    void (async () => {
      try {
        const path = await saveDialog(
          slug(source.name) + "_to_" + slug(target.name) + ".sql",
          "sql",
          "SQL file",
        );
        if (!path) return;
        await exportSave(path, text);
        toast("Migration exported as .sql", "ok");
      } catch (err) {
        toast(appErrorMessage(err, "Export needs the desktop app."), "info");
      }
    })();
  };

  const copyDdl = () => {
    void navigator.clipboard.writeText(plan.map((s) => s.sql).join("\n")).then(
      () => toast("DDL copied to clipboard", "ok"),
      () => toast("Could not copy the DDL", "err"),
    );
  };

  return (
    <div className={"sd-app" + (compareOnly ? " sd-compare" : "")}>
      <div className="sd-dirbar">
        <div className="sd-dirrow">
          <SdConnCard
            conn={source}
            role={compareOnly ? "Schema A" : "Source of truth"}
            options={eligible}
            onChange={pickSource}
            schema={srcSchema}
            schemas={srcId ? (connSchemas[srcId] ?? []) : []}
            pendingLabel={error !== null ? "unavailable" : undefined}
            onSchemaChange={(s) => {
              setSrcSchema(s);
              setAppliedKey(null);
              setError(null);
            }}
          />
          <button
            type="button"
            className="sd-swap"
            onClick={swap}
            disabled={!srcId}
            title={srcId ? "Swap direction" : "Choose a schema first"}
            aria-label="Swap direction"
          >
            <Icon name="swap_horiz" size={18} />
          </button>
          <SdConnCard
            conn={target}
            role={compareOnly ? "Schema B" : "Target — will change"}
            isTarget={!compareOnly}
            options={eligible}
            onChange={pickTarget}
            schema={tgtSchema}
            schemas={tgtId ? (connSchemas[tgtId] ?? []) : []}
            pendingLabel={error !== null ? "unavailable" : undefined}
            onSchemaChange={(s) => {
              setTgtSchema(s);
              setAppliedKey(null);
              setError(null);
            }}
          />
        </div>
        <div className="sd-dirrow sd-dirrow-sub">
          <div className="sd-note">
            <Icon name="shield" size={15} style={{ color: "var(--accent)" }} />
            <span>
              Structure only — <b>no rows</b> read or copied
            </span>
          </div>
          {/* Chips describe a computed comparison — never a stale or empty one,
              which would read as "no differences" while the diff is still being
              built. */}
          {source && target && !synced && comparison !== null ? (
            <div className="sd-summary">
              <div className="sd-stat">
                <span className="sd-dot" style={{ background: "var(--accent)" }} />
                <b>{stats.tablesNew}</b>
                <span>
                  {compareOnly
                    ? stats.tablesNew === 1
                      ? "table only in A"
                      : "tables only in A"
                    : stats.tablesNew === 1
                      ? "new table"
                      : "new tables"}
                </span>
              </div>
              <div className="sd-stat">
                <span className="sd-dot" style={{ background: "var(--accent)" }} />
                <b>{stats.colsAdd}</b>
                <span>cols +</span>
              </div>
              <div className="sd-stat">
                <span className="sd-dot" style={{ background: "var(--change, #5aa7f5)" }} />
                <b>{stats.colsAlter}</b>
                <span>cols ~</span>
              </div>
              <div className="sd-stat">
                <span className="sd-dot" style={{ background: "var(--error)" }} />
                <b>{stats.destructive}</b>
                <span>{compareOnly ? "only in B" : "to drop"}</span>
              </div>
            </div>
          ) : null}
          {source && target && synced ? (
            <div className="sd-summary">
              <div className="sd-stat">
                <Icon name="check_circle" size={13} style={{ color: "var(--accent)" }} />
                <span>schemas identical</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="sd-body">
        <div className="sd-pane sd-pane-diff">
          <div className="sd-pane-head">
            <h2>Structural diff</h2>
            <span className="sd-count">
              {source && target
                ? sideLabel(source, srcSchema) + arrow + sideLabel(target, tgtSchema)
                : "no comparison selected"}
            </span>
            {source && target && !synced && plan.length > 0 ? (
              <button
                type="button"
                className="sd-ddl-btn"
                onClick={() => setDdlOpen(true)}
                title="View the DDL for these changes"
              >
                <Icon name="code" size={14} /> Change DDL
              </button>
            ) : null}
          </div>
          <div className="sd-scroll">
            {/* Error first: a failed open leaves the side without a schema,
                which otherwise reads as "still working" forever. */}
            {error !== null ? (
              <div className="sd-empty">
                <Icon name="error" size={38} style={{ color: "var(--error)" }} />
                <div className="sd-err">{error}</div>
                <button type="button" className="sd-ghost" onClick={retry}>
                  Try again
                </button>
              </div>
            ) : busy || resolving ? (
              <div className="sd-empty">
                <span className="sd-spin" />
                <div>{resolving ? "Opening the connection…" : "Reading both schemas…"}</div>
              </div>
            ) : !source || !target ? (
              <div className="sd-empty">
                <Icon name="compare_arrows" size={38} style={{ color: "var(--text-faint)" }} />
                <div>
                  {target ? (
                    <>
                      Choose {compareOnly ? "Schema A" : "a source of truth"} to compare against{" "}
                      <b>{sideLabel(target, tgtSchema)}</b>.
                    </>
                  ) : (
                    <>Choose two schemas to compare.</>
                  )}
                </div>
              </div>
            ) : synced ? (
              <div className="sd-empty">
                <Icon name="check_circle" size={38} style={{ color: "var(--accent)" }} />
                <div>
                  {sideLabel(source, srcSchema)} and {sideLabel(target, tgtSchema)} are structurally
                  identical.
                </div>
              </div>
            ) : (
              diff.map((t) => (
                <SdTableRow
                  key={t.name}
                  table={t}
                  open={openTables[t.name] ?? false}
                  onToggle={() => toggleTable(t.name)}
                  compareOnly={compareOnly}
                />
              ))
            )}
          </div>
        </div>

        {!compareOnly ? (
          <div className="sd-pane sd-pane-mig">
            <div className="sd-pane-head">
              <h2>Migration plan</h2>
              <span className="sd-count">
                {selected.length} of {plan.length} statements
                {target ? " · " + engName + " dialect" : ""}
              </span>
            </div>
            <div className="sd-scroll">
              {plan.length === 0 ? (
                <div className="sd-empty">
                  {!source || !target ? (
                    <>
                      <Icon name="schema" size={38} style={{ color: "var(--text-faint)" }} />
                      <div>Pick a source schema to build a migration plan.</div>
                    </>
                  ) : (
                    <>
                      <Icon name="check_circle" size={38} style={{ color: "var(--accent)" }} />
                      <div>Nothing to migrate.</div>
                    </>
                  )}
                </div>
              ) : (
                <div className="sd-mig-list">
                  {plan.map((s) => (
                    <div
                      key={s.id}
                      className={
                        "sd-mig" + (s.destructive ? " destructive" : "") + (s.on ? "" : " off")
                      }
                    >
                      <button
                        type="button"
                        className={
                          "sd-check" + (s.on ? " on" : "") + (s.destructive ? " destructive" : "")
                        }
                        onClick={() => toggleStatement(s.id)}
                        aria-pressed={s.on}
                        aria-label={(s.on ? "Exclude" : "Include") + " statement: " + s.sql}
                      >
                        {s.on ? (
                          <Icon
                            name="check"
                            size={13}
                            style={{ color: s.destructive ? "#fff" : "var(--on-accent)" }}
                          />
                        ) : null}
                      </button>
                      <div className="sd-mig-sql">
                        <SqlText sql={s.sql} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {plan.length > 0 && target ? (
              <div className="sd-apply">
                {destructiveOn > 0 ? (
                  <div className="sd-warn">
                    <Icon name="warning" size={15} />
                    <span>
                      <b>
                        {destructiveOn} destructive statement{destructiveOn > 1 ? "s" : ""}
                      </b>{" "}
                      selected — DROP permanently removes structure (and any data in those objects)
                      from <b>{target.name}</b>.
                    </span>
                  </div>
                ) : null}
                <div className="sd-apply-row">
                  <div className="sd-apply-meta">
                    Applying <b>{selected.length}</b> change{selected.length !== 1 ? "s" : ""} to{" "}
                    <b>{sideLabel(target, tgtSchema)}</b>
                  </div>
                  <button
                    type="button"
                    className="sd-ghost"
                    onClick={exportSql}
                    disabled={selected.length === 0}
                  >
                    Export .sql
                  </button>
                  <button
                    type="button"
                    className={"sd-apply-btn" + (destructiveOn > 0 ? " danger" : "")}
                    disabled={!canReview}
                    onClick={() => {
                      setConfirm("");
                      setReviewOpen(true);
                    }}
                  >
                    <Icon name="bolt" size={16} /> Review &amp; apply
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {ddlOpen && source && target ? (
        <div className="sd-review-overlay" onClick={() => setDdlOpen(false)} role="presentation">
          <div
            className="sd-review-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Change DDL"
          >
            <div className="sd-review-head">
              <div className="sd-review-title">
                <Icon name="code" size={18} />
                <span>Change DDL</span>
              </div>
              <button
                type="button"
                className="sd-review-x"
                onClick={() => setDdlOpen(false)}
                aria-label="Close"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="sd-review-sub">
              <b>{plan.length}</b> statement{plan.length !== 1 ? "s" : ""} to make{" "}
              <b>{sideLabel(target, tgtSchema)}</b> match <b>{sideLabel(source, srcSchema)}</b> ·{" "}
              {engName} dialect
            </div>
            <div className="sd-review-list">
              {plan.map((s) => (
                <div
                  key={s.id}
                  className={"sd-review-stmt" + (s.destructive ? " destructive" : "")}
                >
                  <Icon name={s.destructive ? "delete_forever" : "terminal"} size={13} />
                  <code>
                    <SqlText sql={s.sql} />
                  </code>
                </div>
              ))}
            </div>
            <div className="sd-review-foot">
              <span className="sd-review-tx">
                <Icon name="shield" size={13} /> Structure only — row data untouched
              </span>
              <div className="sd-review-actions">
                <button type="button" className="sd-ghost" onClick={copyDdl}>
                  Copy DDL
                </button>
                <button type="button" className="sd-apply-btn" onClick={() => setDdlOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {reviewOpen && target ? (
        <div className="sd-review-overlay" onClick={() => setReviewOpen(false)} role="presentation">
          <div
            className="sd-review-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Confirm migration"
          >
            <div className="sd-review-head">
              <div className="sd-review-title">
                <Icon name="rule" size={18} />
                <span>Confirm migration</span>
              </div>
              <button
                type="button"
                className="sd-review-x"
                onClick={() => setReviewOpen(false)}
                aria-label="Close"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="sd-review-sub">
              About to run <b>{selected.length}</b> statement{selected.length !== 1 ? "s" : ""}{" "}
              against{" "}
              <b style={{ color: targetIsProd ? "var(--error)" : "var(--text)" }}>{target.name}</b>
              {tgtSchema !== null ? <span>· schema {tgtSchema}</span> : null}
              {targetIsProd ? (
                <span className="sd-review-prod">
                  <Icon name="vpn_lock" size={12} /> PRODUCTION
                </span>
              ) : null}
              · {engName} dialect
            </div>
            {destructiveOn > 0 ? (
              <div className="sd-warn" style={{ margin: "0 0 12px" }}>
                <Icon name="warning" size={15} />
                <span>
                  <b>
                    {destructiveOn} destructive statement{destructiveOn > 1 ? "s" : ""}
                  </b>{" "}
                  included. DROP permanently removes structure and any data it holds — this cannot
                  be undone.
                </span>
              </div>
            ) : null}
            <div className="sd-review-list">
              {selected.map((s) => (
                <div
                  key={s.id}
                  className={"sd-review-stmt" + (s.destructive ? " destructive" : "")}
                >
                  <Icon name={s.destructive ? "delete_forever" : "check"} size={13} />
                  <code>
                    <SqlText sql={s.sql} />
                  </code>
                </div>
              ))}
            </div>
            <div className="sd-review-foot">
              {targetIsProd ? (
                <div className="sd-review-gate">
                  <label htmlFor="sd-gate-input">
                    Type <code>{target.name}</code> to confirm production change
                  </label>
                  <input
                    id="sd-gate-input"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder={target.name}
                    spellCheck="false"
                    autoFocus
                  />
                </div>
              ) : null}
              <span className="sd-review-tx">
                <Icon name="sync_alt" size={13} /> Runs in one transaction · row data untouched
              </span>
              <div className="sd-review-actions">
                <button type="button" className="sd-ghost" onClick={() => setReviewOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={"sd-apply-btn" + (destructiveOn > 0 ? " danger" : "")}
                  disabled={!gateOk || applying}
                  onClick={doApply}
                >
                  <Icon name="bolt" size={16} />{" "}
                  {destructiveOn > 0
                    ? "Apply (incl. drops)"
                    : "Apply " + selected.length + " change" + (selected.length !== 1 ? "s" : "")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {doneOpen && source && target ? (
        <div className="sd-done-overlay" onClick={() => setDoneOpen(false)} role="presentation">
          <div
            className="sd-done-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Migration applied"
          >
            <div className="sd-ring">
              <Icon name="check" size={30} />
            </div>
            <h3>Migration applied</h3>
            <p>
              Structural changes committed to <b>{sideLabel(target, tgtSchema)}</b> in one
              transaction. Row data was untouched.
            </p>
            <button
              type="button"
              className="sd-apply-btn"
              style={{ margin: "0 auto" }}
              onClick={() => setDoneOpen(false)}
            >
              <Icon name="done_all" size={16} /> {source.name} and {target.name} now match
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
