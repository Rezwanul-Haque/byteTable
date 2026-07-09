// Object Explorer catalog tab (M22, tab kind 'objexplorer'). A spacious,
// sortable/filterable grid of every non-table object in a schema — the full
// surface the sidebar's capped sections escalate into. Ported from the
// prototype's objexplorer.jsx, reading real introspection (list_objects, now
// enriched with grid metadata) instead of the mock registry; double-click opens
// the existing ObjectViewer, and bulk actions reuse ddl.ts + drop_object.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save } from "@tauri-apps/plugin-dialog";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { ENV_COLOR } from "../../../shared/ui/envColors";
import { useToast } from "../../../shared/ui/toastContext";
import { appErrorMessage } from "../../../shared/api/error";
import { exportSave } from "../../../shared/api/engine";
import { objectsKey, useIntrospectionStore } from "../../introspection/state";
import { useWorkspacesStore } from "../../workspaces/state";
import type { Workspace } from "../../workspaces/types";
import { dropObject, type DbObjectInfo, type DbObjectKind } from "../api";
import { isBrowsable, OBJ_SECTIONS, objectClassesFor, typeBadge } from "../kinds";
import { BulkDropModal, type BulkDropRow } from "./BulkDropModal";
import "./ObjectExplorer.css";

type Facet = DbObjectKind | "all";
type ColKey =
  | "type"
  | "detail"
  | "owner"
  | "modified"
  | "returns"
  | "language"
  | "volatility"
  | "argCount"
  | "table"
  | "timing"
  | "events"
  | "enabled"
  | "approxRows"
  | "size"
  | "dependsOn";
type Col = [key: ColKey, label: string, width: number];

const NAME_MIN = 220;
const ROW_HEIGHT = 36; // fixed row height (matches .oe-row) for virtualization
const ROW_OVERSCAN = 12;
const NUMERIC: ReadonlySet<ColKey> = new Set<ColKey>(["argCount", "approxRows"]);

/** One-line summary for the Detail/Comment column + filter text. */
function rowDetail(info: DbObjectInfo): string {
  switch (info.kind) {
    case "function":
      return info.returns ? `→ ${info.returns}` : (info.detail ?? "");
    case "procedure":
      return info.detail ?? "";
    case "trigger":
      return (
        [info.timing, info.events.join("/")].filter(Boolean).join(" ") +
        (info.table ? ` · ${info.table}` : "")
      );
    case "materialized_view":
      return [
        info.approxRows != null ? `${info.approxRows.toLocaleString()} rows` : "",
        info.size ?? "",
        info.dependsOn.length ? `reads ${info.dependsOn.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "view":
      return info.dependsOn.length ? `reads ${info.dependsOn.join(", ")}` : (info.detail ?? "");
  }
}

/** Facet-dependent column set (fixed widths; Name flexes with NAME_MIN). */
function columnsFor(facet: Facet): Col[] {
  switch (facet) {
    case "all":
      return [
        ["type", "Type", 130],
        ["detail", "Detail", 300],
        ["owner", "Owner", 120],
        ["modified", "Modified", 150],
      ];
    case "function":
      return [
        ["returns", "Returns", 140],
        ["language", "Lang", 80],
        ["argCount", "Args", 64],
        ["volatility", "Volatility", 116],
        ["owner", "Owner", 120],
        ["modified", "Modified", 150],
      ];
    case "procedure":
      return [
        ["language", "Lang", 88],
        ["argCount", "Args", 68],
        ["detail", "Comment", 320],
        ["owner", "Owner", 130],
        ["modified", "Modified", 150],
      ];
    case "trigger":
      return [
        ["table", "Table", 160],
        ["timing", "Timing", 96],
        ["events", "Events", 150],
        ["enabled", "Enabled", 100],
        ["modified", "Modified", 150],
      ];
    case "materialized_view":
      return [
        ["approxRows", "Rows", 110],
        ["size", "Size", 96],
        ["dependsOn", "Reads", 220],
        ["owner", "Owner", 120],
        ["modified", "Refreshed", 150],
      ];
    default:
      // view
      return [
        ["dependsOn", "Reads", 220],
        ["detail", "Comment", 300],
        ["owner", "Owner", 130],
        ["modified", "Modified", 150],
      ];
  }
}

interface Row {
  key: string;
  info: DbObjectInfo;
  detail: string;
}

/** Display text for a cell (arrays joined; empties become ""). */
function cellText(row: Row, key: ColKey): string {
  const i = row.info;
  switch (key) {
    case "detail":
      return row.detail;
    case "type":
      return typeBadge(i.kind);
    case "events":
      return i.events.join(", ");
    case "dependsOn":
      return i.dependsOn.join(", ");
    case "argCount":
      return i.argCount == null ? "" : String(i.argCount);
    case "approxRows":
      return i.approxRows == null ? "" : i.approxRows.toLocaleString();
    case "enabled":
      return i.enabled == null ? "" : i.enabled ? "enabled" : "disabled";
    default:
      return (i[key as keyof DbObjectInfo] as string | null) ?? "";
  }
}

export function ObjectExplorer({
  workspace,
  schema,
  focusClass,
}: {
  workspace: Workspace;
  schema: string;
  focusClass: Facet;
}) {
  const engine = workspace.saved.engine;
  const env = workspace.saved.env;
  const envColor = workspace.saved.color ?? ENV_COLOR[env];
  const handleId = workspace.handleId;
  const toast = useToast();

  const loadObjects = useIntrospectionStore((s) => s.loadObjects);
  const loadObjectDefinition = useIntrospectionStore((s) => s.loadObjectDefinition);
  const invalidateObjects = useIntrospectionStore((s) => s.invalidateObjects);
  const objectsMap = useIntrospectionStore((s) => s.objects);
  const openObjectTab = useWorkspacesStore((s) => s.openObjectTab);
  const openTableTab = useWorkspacesStore((s) => s.openTableTab);

  const classes = useMemo(() => objectClassesFor(engine), [engine]);

  const [facet, setFacet] = useState<Facet>(() =>
    focusClass !== "all" && classes.includes(focusClass) ? focusClass : "all",
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: ColKey | "name"; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const [dropping, setDropping] = useState(false);

  // Eager-load every class list (for counts + instant facet switches).
  useEffect(() => {
    for (const kind of classes) {
      if (!objectsMap[objectsKey(handleId, schema, kind)]) {
        void loadObjects(handleId, schema, kind);
      }
    }
  }, [classes, objectsMap, handleId, schema, loadObjects]);

  // React to sidebar escalation re-pointing the facet.
  useEffect(() => {
    if (focusClass === "all" || classes.includes(focusClass)) {
      setFacet(focusClass);
      setSel(new Set());
    }
  }, [focusClass, classes]);

  // Clear selection when the schema changes under us.
  useEffect(() => setSel(new Set()), [schema]);

  const listFor = (kind: DbObjectKind): DbObjectInfo[] | null =>
    objectsMap[objectsKey(handleId, schema, kind)]?.objects ?? null;

  const counts = useMemo(() => {
    const per: Record<string, number> = {};
    let total = 0;
    for (const c of classes) {
      const n = listFor(c)?.length ?? 0;
      per[c] = n;
      total += n;
    }
    return { per, total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes, objectsMap, handleId, schema]);

  const q = query.trim().toLowerCase();

  const rows = useMemo(() => {
    const facetClasses: DbObjectKind[] = facet === "all" ? classes : [facet];
    const out: Row[] = [];
    for (const c of facetClasses) {
      for (const info of listFor(c) ?? []) {
        out.push({ key: `${c}:${info.name}`, info, detail: rowDetail(info) });
      }
    }
    const filtered = out.filter(
      (r) =>
        !q ||
        r.info.name.toLowerCase().includes(q) ||
        r.detail.toLowerCase().includes(q) ||
        (r.info.owner ?? "").toLowerCase().includes(q),
    );
    const { key, dir } = sort;
    filtered.sort((a, b) => {
      if (key !== "name" && NUMERIC.has(key)) {
        const av = (a.info[key as keyof DbObjectInfo] as number | null) ?? -1;
        const bv = (b.info[key as keyof DbObjectInfo] as number | null) ?? -1;
        if (av !== bv) return (av - bv) * dir;
        return a.info.name < b.info.name ? -1 : 1;
      }
      const av = (key === "name" ? a.info.name : cellText(a, key)).toLowerCase();
      const bv = (key === "name" ? b.info.name : cellText(b, key)).toLowerCase();
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.info.name < b.info.name ? -1 : 1;
    });
    return filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facet, classes, objectsMap, handleId, schema, q, sort]);

  const cols = columnsFor(facet);
  const minWidth = 34 + NAME_MIN + cols.reduce((n, c) => n + c[2], 0);

  const allSelected = rows.length > 0 && rows.every((r) => sel.has(r.key));
  const toggleAll = () => setSel(() => (allSelected ? new Set() : new Set(rows.map((r) => r.key))));
  const toggle = (key: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const selRows = rows.filter((r) => sel.has(r.key));

  const setSortKey = (key: ColKey | "name") =>
    setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }));

  const copyName = (name: string) => {
    const done = () => {
      setCopied(name);
      toast(`Copied “${name}”`, "ok");
      setTimeout(() => setCopied((c) => (c === name ? "" : c)), 1200);
    };
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = name;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
      done();
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(name).then(done, fallback);
    } else {
      fallback();
    }
  };

  const openBrowse = (info: DbObjectInfo) => {
    if (isBrowsable(info.kind)) openTableTab(schema, info.name);
    else openObjectTab(schema, info);
  };

  const exportDdl = async () => {
    const parts: string[] = [];
    for (const r of selRows) {
      const def = await loadObjectDefinition(
        handleId,
        schema,
        r.info.kind,
        r.info.name,
        r.info.detail,
      );
      if (def) parts.push(`-- ${typeBadge(r.info.kind)} ${r.info.name}\n${def.ddl}`);
    }
    if (parts.length === 0) {
      toast("Nothing to export.", "err");
      return;
    }
    try {
      // Native save dialog + backend write — the browser Blob/anchor download
      // does nothing inside the Tauri webview.
      const path = await save({
        defaultPath: `${schema}_objects.sql`,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (!path) return; // user cancelled
      await exportSave(path, parts.join("\n\n") + "\n");
      toast(`Exported ${parts.length} object DDL → ${path.split(/[/\\]/).pop()}`, "ok");
    } catch (e) {
      toast(appErrorMessage(e, "Could not export DDL"), "err");
    }
  };

  const confirmBulkDrop = async () => {
    setDropping(true);
    let n = 0;
    try {
      for (const r of selRows) {
        await dropObject(handleId, schema, r.info.kind, r.info.name, r.info.detail);
        n += 1;
      }
      invalidateObjects(handleId, schema);
      setSel(new Set());
      setDropOpen(false);
      toast(`Dropped ${n} object${n === 1 ? "" : "s"}`, "ok");
    } catch (e) {
      invalidateObjects(handleId, schema);
      toast(appErrorMessage(e, "Could not drop the selected objects."), "err");
    } finally {
      setDropping(false);
    }
  };

  // Row virtualization — render only the visible window so a schema with
  // thousands of objects doesn't mount thousands of DOM nodes. The scroll +
  // sticky header live in `.oe-grid-scroll`; the body sits `scrollMargin` px
  // below the scroll top (the header's height), which the virtualizer offsets.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(34);
  useLayoutEffect(() => {
    if (bodyRef.current) setScrollMargin(bodyRef.current.offsetTop);
  }, [rows.length, facet]);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: ROW_OVERSCAN,
    scrollMargin,
  });

  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => searchRef.current?.focus(), []);

  const facetLabel = facet === "all" ? "objects" : OBJ_SECTIONS[facet].group.toLowerCase();

  return (
    <div className="oe-wrap">
      <div className="oe-toolbar">
        <Icon name="category" size={18} style={{ color: "var(--accent)", flex: "none" }} />
        <div className="oe-title">
          Object Explorer<span className="oe-title-schema">{schema}</span>
        </div>
        <div className="oe-search">
          <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
          <input
            ref={searchRef}
            placeholder={`Filter ${facetLabel}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query ? (
            <IconBtn icon="close" size={13} title="Clear" onClick={() => setQuery("")} />
          ) : null}
        </div>
        <span className="oe-total">
          {rows.length} of {facet === "all" ? counts.total : (counts.per[facet] ?? 0)}
        </span>
      </div>

      <div className="oe-body">
        <div className="oe-rail">
          <button
            type="button"
            className={"oe-facet" + (facet === "all" ? " active" : "")}
            onClick={() => {
              setFacet("all");
              setSel(new Set());
            }}
          >
            <Icon
              name="apps"
              size={16}
              style={{ color: facet === "all" ? "var(--accent)" : "var(--text-faint)" }}
            />
            <span className="oe-facet-label">All objects</span>
            <span className="oe-facet-count">{counts.total}</span>
          </button>
          <div className="oe-rail-sep" />
          {classes.map((c) => {
            const sec = OBJ_SECTIONS[c];
            const active = facet === c;
            return (
              <button
                type="button"
                key={c}
                className={"oe-facet" + (active ? " active" : "")}
                onClick={() => {
                  setFacet(c);
                  setSel(new Set());
                }}
              >
                <Icon
                  name={sec.icon}
                  size={16}
                  style={{ color: active ? sec.accent : "var(--text-faint)" }}
                />
                <span className="oe-facet-label">{sec.group}</span>
                <span className="oe-facet-count">{counts.per[c] ?? 0}</span>
              </button>
            );
          })}
        </div>

        <div className="oe-grid">
          <div className="oe-grid-scroll" ref={scrollRef}>
            <div className="oe-grid-head" style={{ minWidth }}>
              <label className="oe-check" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = sel.size > 0 && !allSelected;
                  }}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </label>
              <button
                type="button"
                className={"oe-th oe-th-name" + (sort.key === "name" ? " sorted" : "")}
                onClick={() => setSortKey("name")}
              >
                <span>Name</span>
                {sort.key === "name" ? (
                  <Icon name={sort.dir === 1 ? "arrow_upward" : "arrow_downward"} size={12} />
                ) : null}
              </button>
              {cols.map(([key, label, w]) =>
                key === "type" ? (
                  <div className="oe-th oe-th-static" key={key} style={{ width: w, flex: "none" }}>
                    {label}
                  </div>
                ) : (
                  <button
                    type="button"
                    key={key}
                    className={"oe-th" + (sort.key === key ? " sorted" : "")}
                    style={{ width: w, flex: "none" }}
                    onClick={() => setSortKey(key)}
                  >
                    <span>{label}</span>
                    {sort.key === key ? (
                      <Icon name={sort.dir === 1 ? "arrow_upward" : "arrow_downward"} size={12} />
                    ) : null}
                  </button>
                ),
              )}
            </div>
            {rows.length === 0 ? (
              <div className="oe-grid-body">
                <div className="oe-empty">
                  <Icon name="search_off" size={30} style={{ color: "var(--text-faint)" }} />
                  <p>{q ? `No objects match “${query}”` : `No ${facetLabel}`}</p>
                </div>
              </div>
            ) : (
              <div
                className="oe-grid-body"
                ref={bodyRef}
                style={{ minWidth, height: rowVirtualizer.getTotalSize(), position: "relative" }}
              >
                {rowVirtualizer.getVirtualItems().map((vr) => {
                  const r = rows[vr.index];
                  if (!r) return null;
                  const sec = OBJ_SECTIONS[r.info.kind];
                  const checked = sel.has(r.key);
                  const browse = isBrowsable(r.info.kind);
                  return (
                    <div
                      key={r.key}
                      className={"oe-row" + (checked ? " checked" : "")}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: vr.size,
                        transform: `translateY(${vr.start - scrollMargin}px)`,
                      }}
                      onClick={() => toggle(r.key)}
                      onDoubleClick={() => openObjectTab(schema, r.info)}
                      title="Double-click to open"
                    >
                      <label className="oe-check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(r.key)}
                          aria-label={`Select ${r.info.name}`}
                        />
                      </label>
                      <div className="oe-td oe-td-name">
                        <Icon
                          name={sec.icon}
                          size={15}
                          style={{ color: sec.accent, flex: "none" }}
                        />
                        <span className="oe-name">{r.info.name}</span>
                        <button
                          type="button"
                          className={"oe-copy" + (copied === r.info.name ? " done" : "")}
                          title="Copy name"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyName(r.info.name);
                          }}
                        >
                          <Icon
                            name={copied === r.info.name ? "check" : "content_copy"}
                            size={12}
                          />
                        </button>
                        <button
                          type="button"
                          className="oe-open"
                          title={browse ? "Browse data" : "Open definition"}
                          onClick={(e) => {
                            e.stopPropagation();
                            openBrowse(r.info);
                          }}
                        >
                          <Icon name={browse ? "table_rows" : "code"} size={13} />
                        </button>
                      </div>
                      {cols.map(([key, , w]) => renderCell(key, r, sec.accent, w))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {sel.size > 0 ? (
        <div className="oe-actionbar">
          <span className="oe-sel-n">{sel.size} selected</span>
          <button type="button" className="oe-clear" onClick={() => setSel(new Set())}>
            Clear
          </button>
          <div style={{ flex: 1 }} />
          <Btn icon="download" variant="text" onClick={() => void exportDdl()}>
            Export DDL
          </Btn>
          <Btn
            icon="delete"
            variant="text"
            className="obj-drop-btn"
            onClick={() => setDropOpen(true)}
          >
            Drop…
          </Btn>
        </div>
      ) : null}

      {dropOpen ? (
        <BulkDropModal
          engine={engine}
          env={env}
          envColor={envColor}
          schema={schema}
          rows={selRows.map<BulkDropRow>((r) => ({
            kind: r.info.kind,
            name: r.info.name,
            detail: r.info.detail,
          }))}
          busy={dropping}
          onConfirm={() => void confirmBulkDrop()}
          onClose={() => setDropOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** Render one facet column cell. */
function renderCell(key: ColKey, row: Row, accent: string, w: number) {
  const style = { width: w, flex: "none" as const };
  if (key === "type") {
    return (
      <div className="oe-td" key={key} style={style}>
        <span
          className="obj-type-badge"
          style={{
            color: accent,
            borderColor: `color-mix(in oklab, ${accent} 45%, var(--border))`,
          }}
        >
          {typeBadge(row.info.kind)}
        </span>
      </div>
    );
  }
  if (key === "enabled") {
    return (
      <div className="oe-td" key={key} style={style}>
        {row.info.enabled == null ? (
          <span className="oe-dim">—</span>
        ) : row.info.enabled ? (
          <span className="oe-badge oe-on">enabled</span>
        ) : (
          <span className="oe-badge oe-off">disabled</span>
        )}
      </div>
    );
  }
  if (key === "argCount" || key === "approxRows") {
    const v = row.info[key];
    return (
      <div className="oe-td oe-mono oe-num" key={key} style={style}>
        {v == null ? "—" : v.toLocaleString()}
      </div>
    );
  }
  const val = cellText(row, key);
  const mono = key === "returns" || key === "table" || key === "dependsOn" || key === "size";
  return (
    <div
      className={"oe-td" + (mono ? " oe-mono" : "") + (key === "detail" ? " oe-td-detail" : "")}
      key={key}
      style={style}
      title={val || ""}
    >
      {val ? <span>{val}</span> : <span className="oe-dim">—</span>}
    </div>
  );
}
