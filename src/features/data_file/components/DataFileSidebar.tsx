// Data-file sidebar (M35 Task 5) — ported from the prototype's `CsvSidebar`
// (csv-viewer.jsx). Reuses the shared sidebar chrome (.sidebar, .schema-row,
// .sidebar-search, .sidebar-section-label, .sidebar-tables).
//
// Four things, top to bottom: the file as a "connection" header, the parse pill
// (what the file was read AS, and the way back to the open sheet), the four
// views, and the column list — where each column shows its type, how full it is,
// how many values are off-type, and can be hidden from the grid.

import { useState } from "react";

import { EngineMark } from "../../../shared/ui/EngineMark";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useT } from "../../../shared/i18n/useT";
import type { StringKey } from "../../../shared/i18n";
import { delimLabel, fmtBytes, TYPES } from "../core";
import type { DataFileDoc } from "../doc";
import { DATA_FILE_TABS, type DataFileTabKind } from "../state";

/** A fill fraction as a whole percentage. */
const pct = (x: number): number => Math.round(x * 100);

interface DataFileSidebarProps {
  workspaceName: string;
  workspaceColor: string;
  doc: DataFileDoc;
  activeKind: DataFileTabKind;
  hidden: Set<string>;
  onOpen: (kind: DataFileTabKind) => void;
  onToggleColumn: (name: string) => void;
  onFocusColumn: (name: string) => void;
  /** Re-open the sheet: another file, or the same one parsed differently. */
  onReopen: () => void;
  onCloseWorkspace: () => void;
}

export function DataFileSidebar({
  workspaceName,
  workspaceColor,
  doc,
  activeKind,
  hidden,
  onOpen,
  onToggleColumn,
  onFocusColumn,
  onReopen,
  onCloseWorkspace,
}: DataFileSidebarProps) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const cols = doc.analysis.cols.filter((c) => !needle || c.name.toLowerCase().includes(needle));
  const t = useT();

  const issueCount = doc.analysis.issues.length;
  const views: { kind: DataFileTabKind; label: StringKey; meta: string; bad?: boolean }[] = [
    { kind: "data", label: "dfile.tabData", meta: doc.parsed.rows.length.toLocaleString() },
    { kind: "profile", label: "dfile.tabProfile", meta: String(doc.analysis.cols.length) },
    {
      kind: "issues",
      label: "dfile.tabQuality",
      meta: issueCount ? String(issueCount) : t("dfile.clean"),
      bad: doc.errors > 0,
    },
    { kind: "sql", label: "dfile.viewQuerySql", meta: doc.table },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-conn" title={doc.path ?? doc.name}>
        <span className="ws-color-bar" style={{ background: workspaceColor }} />
        <EngineMark engine="csv" size={26} />
        <div className="sidebar-conn-info">
          <div className="sidebar-conn-name">{workspaceName}</div>
          <div className="sidebar-conn-detail">
            <span className="conn-env" style={{ color: "var(--text-faint)" }}>
              {t("dfile.statusFile")}
            </span>
            <span className="conn-eng">{fmtBytes(doc.size)}</span>
          </div>
        </div>
        <IconBtn
          icon="power_settings_new"
          title={t("dfile.closeWorkspace")}
          onClick={onCloseWorkspace}
          size={16}
          danger
        />
      </div>

      <div className="schema-row">
        <button
          type="button"
          className="csvv-parse-pill"
          onClick={onReopen}
          title={t("dfile.reopenTitle")}
        >
          <Icon name="tune" size={13} />
          <span>{delimLabel(doc.parsed.opts.delimiter)}</span>
          <span className="csvv-parse-dim">
            {doc.parsed.opts.header ? t("dfile.header") : t("dfile.noHeader")}
            {doc.parsed.opts.trim ? " " + t("dfile.trimmed") : ""}
          </span>
        </button>
        <IconBtn icon="folder_open" title={t("dfile.openAnother")} onClick={onReopen} />
      </div>

      <div className="csvv-views">
        {views.map((v) => (
          <button
            type="button"
            key={v.kind}
            className={"csvv-view" + (activeKind === v.kind ? " active" : "")}
            onClick={() => onOpen(v.kind)}
          >
            <Icon
              name={DATA_FILE_TABS[v.kind].icon}
              size={15}
              style={{ color: activeKind === v.kind ? "var(--accent)" : "var(--text-faint)" }}
            />
            <span className="csvv-view-label">{t(v.label)}</span>
            <span className={"csvv-view-meta" + (v.bad ? " bad" : "")}>{v.meta}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
        <input
          placeholder={t("dfile.filterColsPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div className="sidebar-section-label">
        <span>{t("ws.table.columns")}</span>
        <span className="sidebar-count">{doc.analysis.cols.length}</span>
      </div>
      <div className="sidebar-tables csvv-cols">
        {cols.map((c) => {
          const off = hidden.has(c.name);
          return (
            // A row, not a <button>: it hosts the eye toggle, and a button
            // inside a button is invalid. Same shape as `.table-item` in every
            // other sidebar.
            <div
              key={c.name}
              className={"csvv-col" + (off ? " off" : "")}
              onClick={() => onFocusColumn(c.name)}
              title={t("dfile.colTitle", { name: c.name, type: c.type, pct: pct(c.fill) })}
            >
              <Icon
                name={TYPES[c.type].icon}
                size={13}
                style={{ color: off ? "var(--text-faint)" : TYPES[c.type].color }}
              />
              <div className="csvv-col-body">
                <div className="csvv-col-name">{c.name}</div>
                <div className="csvv-fill">
                  <span
                    style={{
                      width: Math.max(2, pct(c.fill)) + "%",
                      background: TYPES[c.type].color,
                    }}
                  />
                </div>
              </div>
              {c.bad.length ? (
                <span
                  className="csvv-col-bad"
                  title={t("dfile.badTitle", { count: c.bad.length, type: c.type })}
                >
                  {c.bad.length}
                </span>
              ) : null}
              <button
                type="button"
                className="csvv-col-eye"
                title={off ? t("dfile.showColumn") : t("dfile.hideColumn")}
                aria-label={off ? t("dfile.showColumn") : t("dfile.hideColumn")}
                onClick={(e) => {
                  // Or the row's own click would also jump to the profile card.
                  e.stopPropagation();
                  onToggleColumn(c.name);
                }}
              >
                <Icon name={off ? "visibility_off" : "visibility"} size={13} />
              </button>
            </div>
          );
        })}
        {cols.length === 0 ? (
          <div className="sidebar-nomatch">{t("stv.noColMatch", { query: q })}</div>
        ) : null}
      </div>
    </aside>
  );
}
