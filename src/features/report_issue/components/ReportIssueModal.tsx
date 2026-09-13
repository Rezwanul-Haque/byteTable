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
import { useT } from "../../../shared/i18n/useT";
import type { StringKey } from "../../../shared/i18n";
import type { Engine } from "../../../shared/types";
import {
  AFFECTED_ENGINES,
  bugSeverities,
  bugTypes,
  buildIssueBody,
  collectDiagnostics,
  issueUrl,
  REPORT_REPO,
  type AffectedEngine,
  type BugFields,
  type BugTypeId,
} from "../api";
import "./ReportIssueModal.css";

/** Diagnostics chip keys that are labels (not values) — the brand name is not. */
const DIAG_LABEL: Record<string, StringKey> = {
  OS: "bug.diag.os",
  Engine: "bug.diag.engine",
  Theme: "bug.diag.theme",
  Locale: "bug.diag.locale",
};

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
  const tr = useT();
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

  const types = bugTypes();
  const severities = bugSeverities();
  const meta = types.find((ty) => ty.id === type)!;
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
      toast(tr("bug.err.open"), "err");
      return;
    }
    toast(tr("bug.opening"), "ok");
    onClose();
  };

  const copyBody = async () => {
    const done = () => toast(tr("bug.copied"), "ok");
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
    <Modal className="bug-modal" label={tr("bug.title")} onClose={onClose}>
      <div className="bug-head">
        <div
          className="bug-head-mark"
          style={{ color: meta.accent, background: meta.accent + "1c" }}
        >
          <Icon name={meta.icon} size={19} />
        </div>
        <div className="bug-head-txt">
          <div className="modal-title-text">{tr("bug.title")}</div>
          <p className="bug-sub">{tr("bug.sub", { repo: REPORT_REPO })}</p>
        </div>
        <IconBtn icon="close" onClick={onClose} title={tr("common.close")} />
      </div>

      <div className="bug-types">
        {types.map((ty) => (
          <button
            key={ty.id}
            type="button"
            className={"bug-type" + (type === ty.id ? " on" : "")}
            style={
              type === ty.id
                ? ({ borderColor: ty.accent, background: ty.accent + "14" } as CSSProperties)
                : undefined
            }
            onClick={() => setType(ty.id)}
          >
            <Icon
              name={ty.icon}
              size={16}
              style={{ color: type === ty.id ? ty.accent : "var(--text-dim)" }}
            />
            <span className="bug-type-label">{ty.label}</span>
            <span className="bug-type-blurb">{ty.blurb}</span>
          </button>
        ))}
      </div>

      <div className="bug-body">
        <label className="bug-field">
          <span className="bug-label">
            {tr("bug.field.title")}{" "}
            <span className="bug-star" title={tr("bug.required")} aria-label={tr("bug.required")}>
              *
            </span>
          </span>
          <input
            className="bug-input"
            value={title}
            autoFocus
            spellCheck={false}
            placeholder={tr(`bug.ph.title.${type}` as StringKey)}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="bug-field">
          <span className="bug-label">
            {tr(`bug.desc.${type}` as StringKey)}{" "}
            <span className="bug-star" title={tr("bug.required")} aria-label={tr("bug.required")}>
              *
            </span>
          </span>
          <textarea
            className="bug-input bug-ta"
            rows={3}
            value={fields.desc}
            spellCheck
            placeholder={tr(`bug.ph.desc.${type}` as StringKey)}
            onChange={(e) => setF("desc", e.target.value)}
          />
        </label>

        {type === "bug" ? (
          <>
            <div className="bug-field">
              <span className="bug-label">{tr("bug.severity")}</span>
              <div className="bug-sev">
                {severities.map((s) => (
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
                <span className="bug-label">{tr("bug.steps")}</span>
                <textarea
                  className="bug-input bug-ta"
                  rows={3}
                  value={fields.steps}
                  placeholder={tr("bug.ph.steps")}
                  onChange={(e) => setF("steps", e.target.value)}
                />
              </label>
              <div className="bug-col">
                <label className="bug-field">
                  <span className="bug-label">{tr("bug.expected")}</span>
                  <textarea
                    className="bug-input bug-ta sm"
                    rows={1}
                    value={fields.expected}
                    placeholder={tr("bug.ph.expected")}
                    onChange={(e) => setF("expected", e.target.value)}
                  />
                </label>
                <label className="bug-field">
                  <span className="bug-label">{tr("bug.actual")}</span>
                  <textarea
                    className="bug-input bug-ta sm"
                    rows={1}
                    value={fields.actual}
                    placeholder={tr("bug.ph.actual")}
                    onChange={(e) => setF("actual", e.target.value)}
                  />
                </label>
              </div>
            </div>
          </>
        ) : type === "feature" ? (
          <label className="bug-field">
            <span className="bug-label">{tr("bug.solution")}</span>
            <textarea
              className="bug-input bug-ta"
              rows={2}
              value={fields.solution}
              placeholder={tr("bug.ph.solution")}
              onChange={(e) => setF("solution", e.target.value)}
            />
          </label>
        ) : null}

        <label className="bug-field">
          <span className="bug-label">
            {tr("bug.handle")} <span className="bug-req">{tr("bug.optionalTag")}</span>
          </span>
          <input
            className="bug-input"
            value={fields.handle}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={tr("bug.ph.handle")}
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
            {tr("bug.attachDiag")}
          </button>
          <div className={"bug-diag-body" + (includeDiag ? "" : " off")}>
            {/* When a workspace is open its engine is auto-detected and shown
                as a read-only chip. With nothing open there's nothing to
                detect, so offer a dropdown to name the affected engine. */}
            {activeEngine === null ? (
              <div className="bug-diag-engine">
                <span className="bug-diag-engine-label">{tr("bug.affectedEngine")}</span>
                <Select<AffectedEngine>
                  value={engine}
                  options={AFFECTED_ENGINES.map((e) => ({
                    value: e.id,
                    label: e.id === "na" ? tr("bug.engine.na") : e.label,
                  }))}
                  onChange={setEngine}
                  disabled={!includeDiag}
                  mono={false}
                  aria-label={tr("bug.affectedEngine")}
                />
              </div>
            ) : null}
            <div className="bug-diag-chips">
              {diags
                .filter((d) => d.k !== "Engine" || activeEngine !== null)
                .map((d) => (
                  <span key={d.k} className="bug-diag-chip">
                    <b>{DIAG_LABEL[d.k] ? tr(DIAG_LABEL[d.k]!) : d.k}</b> {d.v}
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
            {tr("bug.previewLabel", { action: showPreview ? tr("bug.hide") : tr("bug.preview") })}
          </button>
          <div style={{ flex: 1 }} />
          <IconBtn
            icon="image"
            size={15}
            className="bug-infobtn"
            title={tr("bug.attachTip")}
            aria-label={tr("bug.attachAria")}
          />
          <button
            type="button"
            className="bug-linkbtn"
            onClick={() => void copyBody()}
            title={tr("bug.copyBodyTitle")}
          >
            <Icon name="content_copy" size={13} /> {tr("bug.copyBody")}
          </button>
        </div>
        {showPreview ? <pre className="bug-preview">{body}</pre> : null}
      </div>

      <div className="bug-foot">
        <div style={{ flex: 1 }} />
        <Btn variant="text" onClick={onClose}>
          {tr("common.cancel")}
        </Btn>
        <Btn
          variant="filled"
          icon="open_in_new"
          onClick={() => void submit()}
          disabled={!canSubmit}
        >
          {tr("bug.openGithub")}
        </Btn>
      </div>
      {!canSubmit ? <div className="bug-hint">{tr("bug.hint")}</div> : null}
    </Modal>
  );
}
