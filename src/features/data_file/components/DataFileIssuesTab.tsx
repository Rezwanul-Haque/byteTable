// Data quality (M35 Task 5) — ported from the prototype's `CsvIssuesTab`.
//
// The severity counters, then one card per finding. Every card says what the
// finding MEANS and what to do about it, and offers the two moves worth making:
// "Show rows" narrows the Data tab to exactly those rows, "Column" jumps to that
// column's profile card. Detection is entirely in the core — this file only
// renders what `findIssues` produced.

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { useT } from "../../../shared/i18n/useT";
import type { StringKey } from "../../../shared/i18n";
import type { Issue, IssueSeverity } from "../core";
import type { DataFileDoc } from "../doc";

const SEV_META: Record<IssueSeverity, { label: StringKey; color: string }> = {
  error: { label: "dfile.sevErrorN", color: "var(--danger)" },
  warn: { label: "dfile.sevWarnN", color: "var(--warn)" },
  note: { label: "dfile.sevNoteN", color: "var(--text-faint)" },
};

const SEVERITIES: IssueSeverity[] = ["error", "warn", "note"];

interface DataFileIssuesTabProps {
  doc: DataFileDoc;
  onShowRows: (issue: Issue) => void;
  onFocusColumn: (name: string) => void;
}

export function DataFileIssuesTab({ doc, onShowRows, onFocusColumn }: DataFileIssuesTabProps) {
  const t = useT();
  const issues = doc.analysis.issues;
  const count = (sev: IssueSeverity) => issues.filter((i) => i.sev === sev).length;

  return (
    <div className="csvv-pane csvv-scroll" data-screen-label={"Data quality: " + doc.name}>
      <div className="csvv-pane-head">
        <Icon name="rule" size={15} style={{ color: "var(--accent)" }} />
        <h3>{t("dfile.tabQuality")}</h3>
        <span className="csvv-pane-note">
          {t("dfile.checkedNote", {
            rows: doc.parsed.rows.length.toLocaleString(),
            cols: doc.analysis.cols.length,
          })}
        </span>
      </div>

      <div className="csvv-sevrow">
        {SEVERITIES.map((sev) => {
          const n = count(sev);
          return (
            <div
              key={sev}
              className="csvv-sev"
              style={{ borderColor: n ? SEV_META[sev].color + "66" : "var(--border)" }}
            >
              <b style={{ color: n ? SEV_META[sev].color : "var(--text-faint)" }}>{n}</b>
              <span>{t(SEV_META[sev].label, { count: n })}</span>
            </div>
          );
        })}
      </div>

      {issues.length === 0 ? (
        <div className="csvv-clean">
          <Icon name="verified" size={22} style={{ color: "var(--accent)" }} />
          <div>
            <b>{t("dfile.nothingToFlag")}</b>
            <span>{t("dfile.cleanBody")}</span>
          </div>
        </div>
      ) : (
        <div className="csvv-issues">
          {issues.map((iss) => (
            <div className={"csvv-issue " + iss.sev} key={iss.id}>
              <Icon name={iss.icon} size={16} style={{ color: SEV_META[iss.sev].color }} />
              <div className="csvv-issue-body">
                <div className="csvv-issue-title">{iss.title}</div>
                <div className="csvv-issue-detail">{iss.detail}</div>
                <div className="csvv-issue-fix">
                  <Icon name="lightbulb" size={12} />
                  {iss.fix}
                </div>
              </div>
              <div className="csvv-issue-actions">
                {iss.rows && iss.rows.length ? (
                  <Btn icon="table_rows" variant="text" small onClick={() => onShowRows(iss)}>
                    {t("dfile.showRows")}
                  </Btn>
                ) : null}
                {iss.col ? (
                  <Btn icon="insights" variant="text" small onClick={() => onFocusColumn(iss.col!)}>
                    {t("dfile.columnAction")}
                  </Btn>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
