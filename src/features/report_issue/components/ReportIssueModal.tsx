// Report an issue modal (M24) — ported from the prototype's bugreport.jsx
// BugReportModal. Type picker (Bug / Feature / Question), a type-aware
// templated form, toggleable auto-collected diagnostics, a collapsible
// markdown preview, "Copy body", and "Open on GitHub" which hands the
// prefilled /issues/new URL to the OS browser. Nothing is sent silently —
// the issue only exists once the user submits it on GitHub.

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal } from "../../../shared/ui/Modal";
import { Select } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import type { Engine } from "../../../shared/types";
import {
  AFFECTED_ENGINES,
  BUG_SEVERITY,
  BUG_TYPES,
  buildIssueBody,
  collectDiagnostics,
  issueUrl,
  REPORT_REPO,
  type AffectedEngine,
  type BugFields,
  type BugTypeId,
} from "../api";
import "./ReportIssueModal.css";

/**
 * Open a URL in the OS default browser. Inside Tauri the opener plugin routes
 * to the system browser (design §5 shell.open); plain-browser dev has no Tauri
 * IPC, so fall back to window.open to keep the flow testable.
 */
async function openExternal(url: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

interface ReportIssueModalProps {
  /** Engine of the active workspace — the default for the "Affected engine"
   *  dropdown; null when no workspace is open → the dropdown defaults to N/A. */
  activeEngine: Engine | null;
  /** Running app version (no leading `v`) for the diagnostics chip. */
  version: string;
  onClose: () => void;
}

export function ReportIssueModal({ activeEngine, version, onClose }: ReportIssueModalProps) {
  const toast = useToast();
  const [type, setType] = useState<BugTypeId>("bug");
  const [title, setTitle] = useState("");
  const [includeDiag, setIncludeDiag] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  // The affected engine reported in the diagnostics — pre-selected to the open
  // workspace's engine, but the user can override it (or pick N/A).
  const [engine, setEngine] = useState<AffectedEngine>(activeEngine ?? "na");
  const [fields, setFields] = useState<BugFields>({
    desc: "",
    steps: "",
    expected: "",
    actual: "",
    solution: "",
    severity: "medium",
    handle: "",
  });
  const setF = (k: keyof BugFields, v: string) => setFields((f) => ({ ...f, [k]: v }));

  const meta = BUG_TYPES.find((t) => t.id === type)!;
  const diags = useMemo(() => collectDiagnostics(engine, version), [engine, version]);
  const body = useMemo(
    () => buildIssueBody(type, fields, diags, includeDiag),
    [type, fields, diags, includeDiag],
  );
  // Submit gate (prototype): title ≥ 6 chars and description ≥ 10 chars.
  const canSubmit = title.trim().length >= 6 && fields.desc.trim().length >= 10;

  const submit = async () => {
    if (!canSubmit) return;
    try {
      await openExternal(issueUrl(type, title, fields, diags, includeDiag));
    } catch {
      toast("Couldn't open browser — copy the body and open GitHub manually", "err");
      return;
    }
    toast("Opening GitHub with your issue pre-filled…", "ok");
    onClose();
  };

  const copyBody = async () => {
    const done = () => toast("Issue body copied to clipboard", "ok");
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(body);
        done();
        return;
      } catch {
        /* fall through to the textarea fallback */
      }
    }
    const ta = document.createElement("textarea");
    ta.value = body;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* best-effort */
    }
    document.body.removeChild(ta);
    done();
  };

  return (
    <Modal className="bug-modal" label="Report an issue" onClose={onClose}>
      <div className="bug-head">
        <div
          className="bug-head-mark"
          style={{ color: meta.accent, background: meta.accent + "1c" }}
        >
          <Icon name={meta.icon} size={19} />
        </div>
        <div className="bug-head-txt">
          <div className="modal-title-text">Report an issue</div>
          <p className="bug-sub">
            Opens a pre-filled issue on <span className="bug-repo">{REPORT_REPO}</span>. Nothing is
            sent without your review on GitHub.
          </p>
        </div>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </div>

      <div className="bug-types">
        {BUG_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={"bug-type" + (type === t.id ? " on" : "")}
            style={
              type === t.id
                ? ({ borderColor: t.accent, background: t.accent + "14" } as CSSProperties)
                : undefined
            }
            onClick={() => setType(t.id)}
          >
            <Icon
              name={t.icon}
              size={16}
              style={{ color: type === t.id ? t.accent : "var(--text-dim)" }}
            />
            <span className="bug-type-label">{t.label}</span>
            <span className="bug-type-blurb">{t.blurb}</span>
          </button>
        ))}
      </div>

      <div className="bug-body">
        <label className="bug-field">
          <span className="bug-label">
            Title{" "}
            <span className="bug-star" title="required" aria-label="required">
              *
            </span>
          </span>
          <input
            className="bug-input"
            value={title}
            autoFocus
            spellCheck={false}
            placeholder={
              type === "bug"
                ? "Row inspector drawer overlaps the title bar"
                : type === "feature"
                  ? "Add saved-connection folders"
                  : "How do I export only the schema?"
            }
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="bug-field">
          <span className="bug-label">
            {type === "feature" ? "Problem" : type === "question" ? "Question" : "Description"}{" "}
            <span className="bug-star" title="required" aria-label="required">
              *
            </span>
          </span>
          <textarea
            className="bug-input bug-ta"
            rows={3}
            value={fields.desc}
            spellCheck
            placeholder={
              type === "bug"
                ? "What happened? Include the engine, tab, and any error text."
                : type === "feature"
                  ? "What is painful or missing today?"
                  : "Describe what you are trying to do."
            }
            onChange={(e) => setF("desc", e.target.value)}
          />
        </label>

        {type === "bug" ? (
          <>
            <div className="bug-field">
              <span className="bug-label">Severity</span>
              <div className="bug-sev">
                {BUG_SEVERITY.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={"bug-sev-btn" + (fields.severity === s.id ? " on" : "")}
                    title={s.hint}
                    onClick={() => setF("severity", s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="bug-grid2">
              <label className="bug-field">
                <span className="bug-label">Steps to reproduce</span>
                <textarea
                  className="bug-input bug-ta"
                  rows={3}
                  value={fields.steps}
                  placeholder={"1. Open a MySQL table\n2. Click a row\n3. …"}
                  onChange={(e) => setF("steps", e.target.value)}
                />
              </label>
              <div className="bug-col">
                <label className="bug-field">
                  <span className="bug-label">Expected</span>
                  <textarea
                    className="bug-input bug-ta sm"
                    rows={1}
                    value={fields.expected}
                    placeholder="Drawer stays below the title bar"
                    onChange={(e) => setF("expected", e.target.value)}
                  />
                </label>
                <label className="bug-field">
                  <span className="bug-label">Actual</span>
                  <textarea
                    className="bug-input bug-ta sm"
                    rows={1}
                    value={fields.actual}
                    placeholder="Drawer covers the traffic lights"
                    onChange={(e) => setF("actual", e.target.value)}
                  />
                </label>
              </div>
            </div>
          </>
        ) : type === "feature" ? (
          <label className="bug-field">
            <span className="bug-label">Proposed solution</span>
            <textarea
              className="bug-input bug-ta"
              rows={2}
              value={fields.solution}
              placeholder="Describe the ideal behavior, or a rough sketch of the UI."
              onChange={(e) => setF("solution", e.target.value)}
            />
          </label>
        ) : null}

        <label className="bug-field">
          <span className="bug-label">
            GitHub handle <span className="bug-req">optional</span>
          </span>
          <input
            className="bug-input"
            value={fields.handle}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="e.g. octocat — so maintainers can follow up"
            onChange={(e) => setF("handle", e.target.value)}
          />
        </label>

        <div className="bug-diag">
          <button
            type="button"
            className={"bug-diag-toggle" + (includeDiag ? " on" : "")}
            onClick={() => setIncludeDiag(!includeDiag)}
            aria-pressed={includeDiag}
          >
            <span className={"bug-check" + (includeDiag ? " on" : "")}>
              {includeDiag ? <Icon name="check" size={11} /> : null}
            </span>
            Attach diagnostics
          </button>
          <div className={"bug-diag-body" + (includeDiag ? "" : " off")}>
            {/* When a workspace is open its engine is auto-detected and shown
                as a read-only chip. With nothing open there's nothing to
                detect, so offer a dropdown to name the affected engine. */}
            {activeEngine === null ? (
              <div className="bug-diag-engine">
                <span className="bug-diag-engine-label">Affected engine</span>
                <Select<AffectedEngine>
                  value={engine}
                  options={AFFECTED_ENGINES.map((e) => ({ value: e.id, label: e.label }))}
                  onChange={setEngine}
                  disabled={!includeDiag}
                  mono={false}
                  aria-label="Affected engine"
                />
              </div>
            ) : null}
            <div className="bug-diag-chips">
              {diags
                .filter((d) => d.k !== "Engine" || activeEngine !== null)
                .map((d) => (
                  <span key={d.k} className="bug-diag-chip">
                    <b>{d.k}</b> {d.v}
                  </span>
                ))}
            </div>
          </div>
        </div>

        <div className="bug-actions">
          <button
            type="button"
            className="bug-preview-toggle"
            onClick={() => setShowPreview(!showPreview)}
            aria-expanded={showPreview}
          >
            <Icon name={showPreview ? "expand_less" : "expand_more"} size={15} />
            {showPreview ? "Hide" : "Preview"} issue markdown
          </button>
          <div style={{ flex: 1 }} />
          <IconBtn
            icon="image"
            size={15}
            className="bug-infobtn"
            title="Have a screenshot or recording? Attach it on GitHub after clicking Open — the form supports drag-and-drop. Redact sensitive values first."
            aria-label="About attaching screenshots"
          />
          <button
            type="button"
            className="bug-linkbtn"
            onClick={() => void copyBody()}
            title="Copy the markdown body"
          >
            <Icon name="content_copy" size={13} /> Copy body
          </button>
        </div>
        {showPreview ? <pre className="bug-preview">{body}</pre> : null}
      </div>

      <div className="bug-foot">
        <div style={{ flex: 1 }} />
        <Btn variant="text" onClick={onClose}>
          Cancel
        </Btn>
        <Btn
          variant="filled"
          icon="open_in_new"
          onClick={() => void submit()}
          disabled={!canSubmit}
        >
          Open on GitHub
        </Btn>
      </div>
      {!canSubmit ? (
        <div className="bug-hint">Add a title (6+ chars) and a description to continue.</div>
      ) : null}
    </Modal>
  );
}
