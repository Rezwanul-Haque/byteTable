// Data quality (M35 Task 5) — ported from the prototype's `CsvIssuesTab`.
//
// The severity counters, then one card per finding. Every card says what the
// finding MEANS and what to do about it, and offers the two moves worth making:
// "Show rows" narrows the Data tab to exactly those rows, "Column" jumps to that
// column's profile card. Detection is entirely in the core — this file only
// renders what `findIssues` produced.

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import type { Issue, IssueSeverity } from "../core";
import type { DataFileDoc } from "../doc";

const SEV_META: Record<IssueSeverity, { label: string; color: string }> = {
  error: { label: "Error", color: "var(--danger)" },
  warn: { label: "Warning", color: "var(--warn)" },
  note: { label: "Note", color: "var(--text-faint)" },
};

const SEVERITIES: IssueSeverity[] = ["error", "warn", "note"];

interface DataFileIssuesTabProps {
  doc: DataFileDoc;
  onShowRows: (issue: Issue) => void;
  onFocusColumn: (name: string) => void;
}

export function DataFileIssuesTab({ doc, onShowRows, onFocusColumn }: DataFileIssuesTabProps) {
  const issues = doc.analysis.issues;
  const count = (sev: IssueSeverity) => issues.filter((i) => i.sev === sev).length;

  return (
    <div className="csvv-pane csvv-scroll" data-screen-label={"Data quality: " + doc.name}>
      <div className="csvv-pane-head">
        <Icon name="rule" size={15} style={{ color: "var(--accent)" }} />
        <h3>Data quality</h3>
        <span className="csvv-pane-note">
          checked on open · {doc.parsed.rows.length.toLocaleString()} rows ×{" "}
          {doc.analysis.cols.length} columns
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
              <span>
                {SEV_META[sev].label}
                {n === 1 ? "" : "s"}
              </span>
            </div>
          );
        })}
      </div>

      {issues.length === 0 ? (
        <div className="csvv-clean">
          <Icon name="verified" size={22} style={{ color: "var(--accent)" }} />
          <div>
            <b>Nothing to flag</b>
            <span>
              Every row has the expected field count and every column holds one consistent type.
            </span>
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
                    Show rows
                  </Btn>
                ) : null}
                {iss.col ? (
                  <Btn icon="insights" variant="text" small onClick={() => onFocusColumn(iss.col!)}>
                    Column
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
