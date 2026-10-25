// Query-parameter UI for the SQL editor: the inline bar under the toolbar, the
// prompt-on-run dialog, and the declaration editor in the save popover.
//
// The parameter LIST always comes from the buffer via `detectParams` — it is
// never stored — so editing the SQL cannot leave a stale row behind. What IS
// stored are the values (on the tab, so they survive a tab switch) and the
// declarations (on the saved query, so a report query carries its own types,
// labels and defaults). The pure side of all that lives in `../sqlParams`.
//
// Three surfaces share one field renderer, so a parameter looks and behaves the
// same wherever it is filled in:
//   ParamBar      — the always-visible row of inputs under the toolbar
//   ParamPrompt   — the modal a run shows when a value is missing (or on request)
//   ParamDeclare  — the save-popover section where types/defaults/choices are set

import { useEffect, useMemo, useRef, useState } from "react";

import type { StringKey } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import type { Engine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { Select, type SelectOption } from "../../../shared/ui/Select";
import {
  applyParams,
  effectiveValues,
  findDef,
  kindNeedsValue,
  mergeDefs,
  missingParams,
  paramError,
  paramKey,
  paramToken,
  PARAM_KINDS,
  type DetectedParam,
  type ParamDef,
  type ParamKind,
} from "../sqlParams";
import { previewHtml } from "../sqlPreview";
import "./QueryParams.css";

/** Display name per kind. */
const KIND_LABEL: Record<ParamKind, StringKey> = {
  text: "ws.params.kindText",
  number: "ws.params.kindNumber",
  boolean: "ws.params.kindBoolean",
  date: "ws.params.kindDate",
  list: "ws.params.kindList",
  null: "ws.params.kindNull",
  raw: "ws.params.kindRaw",
};

/** Message per validation code (the pure module returns codes, not text). */
const ERROR_LABEL: Record<"notNumber" | "notBoolean", StringKey> = {
  notNumber: "ws.params.errNotNumber",
  notBoolean: "ws.params.errNotBoolean",
};

/** Kinds whose values are free text, so a fixed choice list makes sense. */
const CHOOSABLE_KINDS: ParamKind[] = ["text", "number", "date"];

/** `values` with one name replaced. */
function withValue(
  values: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  return { ...values, [name]: value };
}

// ---- one parameter's value input -----------------------------------------
// The control follows the declaration: a dropdown for declared choices and for
// booleans (closed sets, where free text only invites typos), a date picker for
// dates, a static chip for NULL (which takes no value), and a text input
// otherwise. Numbers stay a TEXT input on purpose — `type="number"` silently
// swallows what it cannot parse, hiding the very typo the inline error exists
// to show.
function ParamValueInput({
  param,
  def,
  value,
  onChange,
  onSubmit,
  inputRef,
}: {
  param: DetectedParam;
  def: ParamDef | undefined;
  /** The EFFECTIVE value — entered, else the declared default. */
  value: string;
  onChange: (value: string) => void;
  /** Enter in a text input (the dialog's "run now"). */
  onSubmit?: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const t = useT();
  const kind = def?.kind ?? "text";
  const ariaLabel = t("ws.params.valueFor", { name: paramToken(param) });

  if (!kindNeedsValue(kind)) {
    return (
      <span className="qp-null" title={t("ws.params.kindNull")}>
        NULL
      </span>
    );
  }

  const choices = def?.choices ?? [];
  if (choices.length > 0 || kind === "boolean") {
    const options: SelectOption[] =
      choices.length > 0
        ? choices.map((c) => ({ value: c, label: c }))
        : [
            { value: "true", label: t("ws.params.true") },
            { value: "false", label: t("ws.params.false") },
          ];
    // With nothing chosen yet, offer an EMPTY option and select it, so the
    // control shows "value…" rather than displaying the first option while the
    // stored value is still blank — which would read as filled-in to the user
    // and as missing to the run.
    if (value === "") options.unshift({ value: "", label: t("ws.params.value") });
    // A value outside the list (an edited declaration, a restored older value)
    // is offered as its own option instead of snapping to the first one.
    else if (!options.some((o) => o.value === value)) options.unshift({ value, label: value });
    return (
      <Select
        value={value}
        options={options}
        onChange={onChange}
        aria-label={ariaLabel}
        className="qp-select"
      />
    );
  }

  const error = paramError(kind, value);
  const invalid = value !== "" && error !== null;
  return (
    <span className="qp-input-wrap">
      <input
        ref={inputRef}
        className={"qp-input" + (invalid ? " invalid" : "")}
        type={kind === "date" ? "date" : "text"}
        inputMode={kind === "number" ? "decimal" : undefined}
        value={value}
        placeholder={t("ws.params.value")}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {invalid && error ? <span className="qp-err">{t(ERROR_LABEL[error])}</span> : null}
    </span>
  );
}

/** `:name` (or `?`) plus its declared label, as shown beside every input. */
function ParamLabel({ param, def }: { param: DetectedParam; def: ParamDef | undefined }) {
  const token = paramToken(param);
  const label = def?.label?.trim();
  return (
    <span className="qp-name" title={label ? `${label} — ${token}` : token}>
      <span className="qp-token">{token}</span>
      {label ? <span className="qp-label">{label}</span> : null}
    </span>
  );
}

/** The resolved-SQL block both the bar and the dialog show. */
function ResolvedSql({ sql }: { sql: string }) {
  return <pre className="qp-preview-sql" dangerouslySetInnerHTML={{ __html: previewHtml(sql) }} />;
}

// ---- the inline bar ------------------------------------------------------
/**
 * The parameter row under the SQL toolbar, rendered only while the buffer has
 * parameters — an ordinary query's editor is untouched.
 *
 * Collapsible, with two things one click away: the resolved SQL (the one thing
 * a substitution model owes the user is the ability to see exactly what will
 * run before it runs) and the declaration editor, which is here rather than
 * buried in the save popover so types and defaults can be set on a buffer that
 * has never been saved.
 */
export function ParamBar({
  params,
  defs,
  values,
  engine,
  sql,
  onChange,
  onDefsChange,
}: {
  params: DetectedParam[];
  defs: ParamDef[];
  values: Record<string, string>;
  engine: Engine;
  /** The buffer, for the resolved-SQL preview. */
  sql: string;
  onChange: (values: Record<string, string>) => void;
  onDefsChange: (defs: ParamDef[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [preview, setPreview] = useState(false);
  const [declaring, setDeclaring] = useState(false);
  const effective = effectiveValues(params, defs, values);
  const resolved = useMemo(
    () => (preview ? applyParams(sql, values, defs, engine) : ""),
    [preview, sql, values, defs, engine],
  );

  if (params.length === 0) return null;

  return (
    <div className="qp-bar" role="group" aria-label={t("ws.params.bar")}>
      <div className="qp-bar-head">
        <button
          type="button"
          className="qp-toggle"
          onClick={() => setOpen((o) => !o)}
          title={open ? t("ws.params.hide") : t("ws.params.show")}
          aria-expanded={open}
        >
          <Icon name={open ? "expand_more" : "chevron_right"} size={15} />
          <Icon name="tune" size={14} style={{ color: "var(--accent)" }} />
          <span className="qp-bar-title">{t("ws.params.title")}</span>
          <span className="qp-bar-count">{t("ws.params.count", { count: params.length })}</span>
        </button>
        <div style={{ flex: 1 }} />
        <IconBtn
          icon="edit_note"
          size={14}
          active={declaring}
          title={t("ws.params.editTitle")}
          onClick={() => {
            setDeclaring((d) => !d);
            setOpen(true);
          }}
        />
        <IconBtn
          icon="code"
          size={14}
          active={preview}
          title={preview ? t("ws.params.previewHide") : t("ws.params.previewShow")}
          onClick={() => setPreview((p) => !p)}
        />
      </div>
      {open ? (
        <div className="qp-fields">
          {params.map((param) => {
            const def = findDef(defs, param.name);
            return (
              <div className="qp-field" key={paramKey(param)}>
                <ParamLabel param={param} def={def} />
                <ParamValueInput
                  param={param}
                  def={def}
                  value={effective[param.name] ?? ""}
                  onChange={(v) => onChange(withValue(values, param.name, v))}
                />
              </div>
            );
          })}
        </div>
      ) : null}
      {open && declaring ? (
        <div className="qp-declare-wrap">
          <ParamDeclare params={params} defs={defs} onChange={onDefsChange} />
        </div>
      ) : null}
      {preview ? (
        <div className="qp-preview">
          <div className="qp-preview-title">{t("ws.params.previewTitle")}</div>
          <ResolvedSql sql={resolved} />
        </div>
      ) : null}
    </div>
  );
}

// ---- the prompt-on-run dialog --------------------------------------------
/**
 * The modal a run puts up when a parameter has no value, and the one the "Run
 * with parameters…" action opens on demand.
 *
 * Deliberately NOT shown on every run: a query whose values are all filled in
 * (or defaulted) runs straight away, because a dialog between ⌘↵ and a result
 * is exactly the friction that stops people using parameters at all. It appears
 * when it has something to ask.
 *
 * Edits stay local until Run, so a dialog opened by accident changes nothing.
 * Focus goes to the first field still missing a value — the one the user came
 * here for — and moves on as each is filled.
 */
export function ParamPrompt({
  params,
  defs,
  values,
  engine,
  sql,
  onRun,
  onClose,
}: {
  params: DetectedParam[];
  defs: ParamDef[];
  values: Record<string, string>;
  engine: Engine;
  sql: string;
  /** Run with these values; the caller persists them too. */
  onRun: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const t = useT();
  // Seeded from the EFFECTIVE values, so declared defaults arrive as real
  // content the user can accept with one Enter or type straight over.
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    effectiveValues(params, defs, values),
  );
  const focusRef = useRef<HTMLInputElement | null>(null);
  const missing = missingParams(params, defs, draft);
  const firstMissing = missing[0];

  // Keyed to the name rather than run once on mount, so filling one gap moves
  // focus to the next.
  useEffect(() => {
    focusRef.current?.focus();
  }, [firstMissing]);

  const submit = () => {
    if (missing.length > 0) return;
    onRun(draft);
  };

  return (
    <Modal onClose={onClose} label={t("ws.params.promptTitle")} width={440}>
      <ModalTitle>{t("ws.params.promptTitle")}</ModalTitle>
      <div className="qp-prompt-sub">
        {missing.length > 0 ? t("ws.params.promptMissing") : t("ws.params.promptReady")}
      </div>
      <div className="qp-prompt-fields">
        {params.map((param) => {
          const def = findDef(defs, param.name);
          return (
            <div className="qp-prompt-field" key={paramKey(param)}>
              <ParamLabel param={param} def={def} />
              <ParamValueInput
                param={param}
                def={def}
                value={draft[param.name] ?? ""}
                onChange={(v) => setDraft((d) => withValue(d, param.name, v))}
                onSubmit={submit}
                inputRef={param.name === firstMissing ? focusRef : undefined}
              />
            </div>
          );
        })}
      </div>
      <details className="qp-prompt-preview">
        <summary>{t("ws.params.previewTitle")}</summary>
        <ResolvedSql sql={applyParams(sql, draft, defs, engine)} />
      </details>
      <ModalActions>
        <Btn variant="text" small onClick={onClose}>
          {t("common.cancel")}
        </Btn>
        <Btn variant="filled" small onClick={submit} disabled={missing.length > 0}>
          {t("ws.params.promptRun")}
        </Btn>
      </ModalActions>
    </Modal>
  );
}

// ---- the declaration editor ----------------------------------------------
/**
 * Turns detected placeholders into a declared interface: a type, a label, a
 * default and — for the free-text kinds — a fixed set of choices. This is what
 * makes a saved query a tool rather than a bookmark.
 *
 * Rendered inside `ParamBar` behind its edit toggle. Only DETECTED parameters
 * get a row, while declarations for names not currently in the buffer are
 * preserved (see `mergeDefs`).
 */
function ParamDeclare({
  params,
  defs,
  onChange,
}: {
  params: DetectedParam[];
  defs: ParamDef[];
  onChange: (defs: ParamDef[]) => void;
}) {
  const t = useT();
  const kindOptions = useMemo<SelectOption<ParamKind>[]>(
    () => PARAM_KINDS.map((k) => ({ value: k, label: t(KIND_LABEL[k]) })),
    [t],
  );

  if (params.length === 0) return null;

  const patch = (name: string, change: Partial<ParamDef>) =>
    onChange(mergeDefs(defs, name, change));

  return (
    <div className="qp-declare">
      <div className="qp-declare-title">
        <span>{t("ws.params.title")}</span>
        <span className="qp-declare-note">{t("ws.params.declared")}</span>
      </div>
      {params.map((param) => {
        const def = findDef(defs, param.name);
        const kind = def?.kind ?? "text";
        const token = paramToken(param);
        return (
          <div className="qp-declare-row" key={paramKey(param)}>
            <div className="qp-declare-head">
              <span className="qp-token">{token}</span>
              <Select
                value={kind}
                options={kindOptions}
                onChange={(k) => patch(param.name, { kind: k })}
                aria-label={t("ws.params.kindFor", { name: token })}
                className="qp-select qp-select-kind"
                mono={false}
              />
            </div>
            <input
              className="qp-input"
              value={def?.label ?? ""}
              placeholder={t("ws.params.label")}
              aria-label={t("ws.params.labelFor", { name: token })}
              spellCheck={false}
              onChange={(e) => patch(param.name, { label: e.target.value })}
            />
            {kindNeedsValue(kind) ? (
              <input
                className="qp-input"
                value={def?.default ?? ""}
                placeholder={t("ws.params.default")}
                aria-label={t("ws.params.defaultFor", { name: token })}
                spellCheck={false}
                onChange={(e) => patch(param.name, { default: e.target.value })}
              />
            ) : null}
            {CHOOSABLE_KINDS.includes(kind) ? (
              <input
                className="qp-input"
                value={(def?.choices ?? []).join(", ")}
                placeholder={t("ws.params.choices")}
                aria-label={t("ws.params.choicesFor", { name: token })}
                title={t("ws.params.choicesHint")}
                spellCheck={false}
                onChange={(e) =>
                  patch(param.name, {
                    choices: e.target.value
                      .split(",")
                      .map((c) => c.trim())
                      .filter((c) => c !== ""),
                  })
                }
              />
            ) : null}
            {kind === "raw" ? (
              <div className="qp-declare-hint">{t("ws.params.kindRawHint")}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
