// Report an issue (M24) — the non-UI core ported from the prototype's
// bugreport.jsx: the type/severity config, diagnostics collection, the exact
// markdown template (`buildIssueBody`), and the prefilled `/issues/new` URL.
// Nothing is sent silently — `issueUrl` just assembles a URL the user opens
// and submits on GitHub themselves, so it works for anonymous users with no
// token and no API write.

import { platform } from "@tauri-apps/plugin-os";

import type { Engine } from "../../shared/types";
import { UPDATE_REPO } from "../updater/api";

/** GitHub repo issues are filed against — reused from the updater so the repo
 *  slug has a single source of truth. */
export const REPORT_REPO = UPDATE_REPO;

export type BugTypeId = "bug" | "feature" | "question";

export interface BugType {
  id: BugTypeId;
  label: string;
  icon: string;
  accent: string;
  labels: string[];
  blurb: string;
}

// Prototype bugreport.jsx BUG_TYPES — accent colors, GitHub labels, and blurbs
// are the source of truth; do not invent copy or colors.
export const BUG_TYPES: BugType[] = [
  {
    id: "bug",
    label: "Bug",
    icon: "bug_report",
    accent: "#e06c75",
    labels: ["bug"],
    blurb: "Something is broken or behaves unexpectedly.",
  },
  {
    id: "feature",
    label: "Feature",
    icon: "lightbulb",
    accent: "#e5c07b",
    labels: ["enhancement"],
    blurb: "Suggest a new capability or improvement.",
  },
  {
    id: "question",
    label: "Question",
    icon: "help",
    accent: "#61afef",
    labels: ["question"],
    blurb: "Ask about usage, behavior, or the roadmap.",
  },
];

export interface BugSeverity {
  id: string;
  label: string;
  hint: string;
}

// Prototype BUG_SEVERITY (Bug only). The chip tooltips are the `hint` values.
export const BUG_SEVERITY: BugSeverity[] = [
  { id: "low", label: "Low", hint: "minor / cosmetic" },
  { id: "medium", label: "Medium", hint: "workaround exists" },
  { id: "high", label: "High", hint: "blocks a workflow" },
  { id: "critical", label: "Critical", hint: "data loss / crash" },
];

/** The templated form's mutable fields (prototype `fields` state). `handle` is
 *  an optional GitHub username the reporter can add so maintainers can follow
 *  up — the app never authenticates as them; it only stamps the body. */
export interface BugFields {
  desc: string;
  steps: string;
  expected: string;
  actual: string;
  solution: string;
  severity: string;
  handle: string;
}

/** Normalize a user-entered GitHub handle: drop surrounding whitespace and any
 *  leading `@`s so the body always renders a single canonical `@name`. Returns
 *  "" when nothing usable was entered. */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").trim();
}

/** A read-only environment chip (key + value) in the diagnostics block. */
export interface Diagnostic {
  k: string;
  v: string;
}

/** The engine the report is about: one of the real engines, or `"na"` when the
 *  issue isn't engine-specific (or no workspace is open). Chosen in the
 *  diagnostics dropdown; defaults to the active workspace's engine. */
export type AffectedEngine = Engine | "na";

// Ordered engine options for the "Affected engine" dropdown — `na` first so the
// default when nothing is open reads sensibly. Engine display names are a
// private copy by the same precedent as Rail.tsx / EngineBadge.tsx.
export const AFFECTED_ENGINES: { id: AffectedEngine; label: string }[] = [
  { id: "na", label: "N/A — not engine-specific" },
  { id: "sqlite", label: "SQLite" },
  { id: "mysql", label: "MySQL" },
  { id: "postgres", label: "PostgreSQL" },
  { id: "mssql", label: "MS SQL Server" },
  { id: "redis", label: "Redis" },
  { id: "dynamodb", label: "DynamoDB" },
  { id: "mongodb", label: "MongoDB" },
  { id: "cassandra", label: "Cassandra" },
];

/** Display label for an affected-engine value (falls back to the raw id). */
export function engineLabel(engine: AffectedEngine): string {
  return AFFECTED_ENGINES.find((e) => e.id === engine)?.label ?? engine;
}

// platform() OS id → the human label shown in the diagnostics chip (prototype
// detectPlatform().label). Guarded so plain-browser dev (no Tauri plugin)
// falls back to navigator.platform instead of throwing.
function osLabel(): string {
  try {
    const os = platform();
    const labels: Record<string, string> = {
      macos: "macOS",
      windows: "Windows",
      linux: "Linux",
      ios: "iOS",
      android: "Android",
    };
    return labels[os] ?? os.charAt(0).toUpperCase() + os.slice(1);
  } catch {
    return navigator.platform || "Unknown";
  }
}

/**
 * Auto-collected environment for the issue body (prototype collectDiagnostics):
 * ByteTable version, OS, the affected engine (chosen in the dropdown), the
 * current theme, and the browser locale.
 */
export function collectDiagnostics(engine: AffectedEngine, version: string): Diagnostic[] {
  return [
    { k: "ByteTable", v: "v" + version },
    { k: "OS", v: osLabel() },
    { k: "Engine", v: engineLabel(engine) },
    { k: "Theme", v: document.documentElement.getAttribute("data-theme") || "dark" },
    { k: "Locale", v: navigator.language || "en" },
  ];
}

/**
 * Assemble the templated markdown body (prototype buildIssueBody). Per-type
 * sections, an optional Environment list when diagnostics are attached, and the
 * "Filed from ByteTable" footer. Section headings are the reference's verbatim.
 */
export function buildIssueBody(
  type: BugTypeId,
  fields: BugFields,
  diags: Diagnostic[],
  includeDiag: boolean,
): string {
  const L: string[] = [];
  if (type === "bug") {
    L.push("### Description", (fields.desc || "_No description provided._").trim(), "");
    L.push("### Steps to reproduce", (fields.steps || "1. \n2. \n3. ").trim(), "");
    L.push("### Expected behavior", (fields.expected || "_…_").trim(), "");
    L.push("### Actual behavior", (fields.actual || "_…_").trim(), "");
    L.push(
      "### Severity",
      (BUG_SEVERITY.find((s) => s.id === fields.severity) ?? BUG_SEVERITY[1]!).label,
      "",
    );
  } else if (type === "feature") {
    L.push("### Problem", (fields.desc || "_What is missing or painful today?_").trim(), "");
    L.push("### Proposed solution", (fields.solution || "_…_").trim(), "");
  } else {
    L.push("### Question", (fields.desc || "_…_").trim(), "");
  }
  if (includeDiag) {
    L.push("### Environment", "", diagList(diags), "");
  }
  const reporter = normalizeHandle(fields.handle);
  L.push(
    reporter
      ? "<sub>Filed from ByteTable · Report an issue · reported by @" + reporter + "</sub>"
      : "<sub>Filed from ByteTable · Report an issue</sub>",
  );
  return L.join("\n");
}

/** The diagnostics as a markdown list, used both in the copyable body and as
 *  the value prefilled into the form's `environment` field. */
export function diagList(diags: Diagnostic[]): string {
  return diags.map((d) => "- **" + d.k + ":** " + d.v).join("\n");
}

/** The GitHub Issue Form template file each type routes to (mirrors the modal's
 *  fields 1:1 — see `.github/ISSUE_TEMPLATE/`). */
const TEMPLATE_FILE: Record<BugTypeId, string> = {
  bug: "bug_report.yml",
  feature: "feature_request.yml",
  question: "question.yml",
};

/**
 * Build the prefilled Issue Form URL:
 * `/issues/new?template=<file>.yml&title=<prefix+title>&<field-id>=<value>…`.
 *
 * Targeting `?template=` (not a blank `?body=`) is required because the repo
 * sets `blank_issues_enabled: false`, which redirects a blank prefill to the
 * template chooser and drops the query. Each param key is the form field's
 * `id`. Note: GitHub only prefills text `input`/`textarea` fields from the
 * query — `dropdown`/`checkboxes` are ignored — so every prefilled field
 * (including `severity`) must be a text field in the template. Labels and
 * the title prefix come from the template, so they are not passed here (the
 * title query still carries the user's text after the prefix). Empty optional
 * fields are omitted so the template's own `value:` defaults survive.
 */
export function issueUrl(
  type: BugTypeId,
  title: string,
  fields: BugFields,
  diags: Diagnostic[],
  includeDiag: boolean,
): string {
  const prefix = { bug: "[Bug]: ", feature: "[Feature]: ", question: "[Question]: " }[type];
  const p = new URLSearchParams();
  p.set("template", TEMPLATE_FILE[type]);
  p.set("title", prefix + title.trim());

  // Only carry non-empty fields so the form keeps its default `value:` blocks
  // (e.g. the "1. 2. 3." steps scaffold) when the user left a field blank.
  const put = (id: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) p.set(id, trimmed);
  };

  if (type === "bug") {
    put("description", fields.desc);
    put("steps", fields.steps);
    put("expected", fields.expected);
    put("actual", fields.actual);
    p.set(
      "severity",
      (BUG_SEVERITY.find((s) => s.id === fields.severity) ?? BUG_SEVERITY[1]!).label,
    );
  } else if (type === "feature") {
    put("problem", fields.desc);
    put("solution", fields.solution);
  } else {
    put("question", fields.desc);
  }

  if (includeDiag) put("environment", diagList(diags));
  const reporter = normalizeHandle(fields.handle);
  if (reporter) p.set("handle", "@" + reporter);

  return "https://github.com/" + REPORT_REPO + "/issues/new?" + p.toString();
}
