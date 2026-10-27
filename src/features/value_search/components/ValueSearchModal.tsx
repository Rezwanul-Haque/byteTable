// Search-all-tables modal. One modal owns the whole flow:
//
//   type a value → sweep every table (hits land live) → summary
//
// The debugging tool for an unfamiliar schema: paste an email, an id or a
// fragment and find out which tables and columns hold it. Reads only.
//
// The `i` hint beside the field is load-bearing, not decoration: this is a full
// table scan of every table in scope, which is a materially expensive thing to
// start by accident on a production connection. It is stated before the user
// commits, and the sweep stays cancellable while it runs.

import { useRef } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { Icon } from "../../../shared/ui/Icon";
import { InfoHint } from "../../../shared/ui/InfoHint";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useT } from "../../../shared/i18n/useT";
import type { CellValue } from "../../../shared/api/engine";
import type { MatchMode, TableHit } from "../api";
import { useValueSearchStore } from "../state";
import "./ValueSearchModal.css";

/** Longest cell rendering kept in the preview grid before an ellipsis. */
const CELL_CLAMP = 140;

function fmt(n: number): string {
  return n.toLocaleString();
}

/** One cell as display text. `null` is rendered by the caller as a NULL chip. */
function cellText(v: CellValue): string {
  const s = String(v);
  return s.length > CELL_CLAMP ? s.slice(0, CELL_CLAMP) + "…" : s;
}

/** Does this cell hold the needle? Mirrors the backend's case-insensitive check. */
function cellHit(v: CellValue, needle: string, mode: MatchMode): boolean {
  if (v === null) return false;
  const text = String(v).toLowerCase();
  const want = needle.trim().toLowerCase();
  return mode === "exact" ? text === want : text.includes(want);
}

/** Mount once at the app shell; renders only when the store is open. */
export function ValueSearchModal() {
  const {
    open,
    schema,
    scopeToSchema,
    needle,
    mode,
    includeSystemSchemas,
    status,
    hits,
    current,
    summary,
    error,
    setNeedle,
    setMode,
    setScopeToSchema,
    setIncludeSystemSchemas,
    run,
    cancel,
    close,
  } = useValueSearchStore();

  const inputRef = useRef<HTMLInputElement | null>(null);
  const t = useT();

  const running = status === "running";
  const armed = needle.trim().length > 0 && !running;

  if (!open) return null;

  return (
    <Modal
      onClose={close}
      label={t("vs.title")}
      width={760}
      className="vs-modal"
      initialFocusRef={inputRef}
    >
      <ModalTitle>
        <Icon name="travel_explore" /> {t("vs.title")}
        <InfoHint text={t("vs.scanHint")} />
      </ModalTitle>

      {/* Step 1: the needle */}
      <div className="vs-query">
        <input
          ref={inputRef}
          className="vs-input"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && armed) void run();
          }}
          placeholder={t("vs.placeholder")}
          spellCheck="false"
          autoComplete="off"
          aria-label={t("vs.placeholder")}
          disabled={running}
        />
        <div className="vs-modes">
          {(["contains", "exact"] as const).map((m) => (
            <Btn
              key={m}
              small
              variant={mode === m ? "filled" : "tonal"}
              onClick={() => setMode(m)}
              disabled={running}
              title={t(m === "contains" ? "vs.modeContainsTitle" : "vs.modeExactTitle")}
            >
              {t(m === "contains" ? "vs.modeContains" : "vs.modeExact")}
            </Btn>
          ))}
        </div>
      </div>

      <div className="vs-scope">
        {schema ? (
          <label className="vs-check">
            <Checkbox
              checked={scopeToSchema}
              onChange={(e) => setScopeToSchema(e.target.checked)}
              disabled={running}
            />
            {t("vs.scopeSchema", { schema })}
          </label>
        ) : null}
        <label className="vs-check">
          <Checkbox
            checked={includeSystemSchemas}
            onChange={(e) => setIncludeSystemSchemas(e.target.checked)}
            disabled={running || (scopeToSchema && schema !== null)}
          />
          {t("vs.includeSystem")}
        </label>
      </div>

      {/* The warning is stated inline as well as in the `i` bubble: the bubble
          is discoverable, this is unmissable. */}
      <p className="vs-scan-note">
        <Icon name="info" size={14} /> {t("vs.scanNote")}
      </p>

      {/* Step 2: live progress */}
      {running ? (
        <div className="vs-progress" role="status">
          <div className="vs-bar">
            <div
              className="vs-bar-fill"
              style={{
                width:
                  current && current.total > 0 ? `${(current.done / current.total) * 100}%` : 0,
              }}
            />
          </div>
          <span className="vs-progress-text">
            {current
              ? t("vs.scanning", {
                  table: `${current.schema}.${current.table}`,
                  done: fmt(current.done),
                  total: fmt(current.total),
                })
              : t("vs.starting")}
          </span>
        </div>
      ) : null}

      {/* Step 3: hits, streamed in arrival order (smallest tables first) */}
      {hits.length > 0 ? (
        <div className="vs-results">
          {hits.map((hit) => (
            <HitCard key={`${hit.schema}.${hit.table}`} hit={hit} needle={needle} mode={mode} />
          ))}
        </div>
      ) : null}

      {status === "done" && hits.length === 0 ? (
        <p className="vs-empty">
          <Icon name="search_off" size={16} /> {t("vs.noResults")}
        </p>
      ) : null}

      {/* Step 4: summary */}
      {status === "done" && summary ? (
        <div className="vs-summary">
          <p>
            <Icon
              name={summary.cancelled ? "cancel" : "check_circle"}
              size={15}
              className="vs-summary-icon"
            />{" "}
            {summary.cancelled ? t("vs.cancelledPrefix") : null}
            {t("vs.summaryLine", {
              scanned: fmt(summary.tablesScanned),
              total: fmt(summary.tablesTotal),
              seconds: (summary.elapsedMs / 1000).toFixed(1),
              hits: fmt(summary.hits.length),
            })}
          </p>
          {summary.stoppedEarly ? (
            <p className="vs-note">{t("vs.stoppedEarly", { count: fmt(summary.hits.length) })}</p>
          ) : null}
          {summary.tablesSkipped > 0 ? (
            <p className="vs-note">{t("vs.skipped", { count: fmt(summary.tablesSkipped) })}</p>
          ) : null}
          {summary.errors.length > 0 ? (
            <details className="vs-errors">
              <summary>
                <Icon name="warning" size={14} />{" "}
                {t("vs.errorsHeading", { count: fmt(summary.errors.length) })}
              </summary>
              <ul>
                {summary.errors.map((e) => (
                  <li key={`${e.schema}.${e.table}`}>
                    <b>
                      {e.schema}.{e.table}
                    </b>{" "}
                    — {e.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {status === "error" && error ? <p className="vs-error">{error}</p> : null}

      <ModalActions>
        {running ? (
          <Btn variant="tonal" icon="stop" onClick={() => void cancel()}>
            {t("common.cancel")}
          </Btn>
        ) : (
          <Btn variant="text" onClick={close}>
            {status === "done" ? t("common.close") : t("common.cancel")}
          </Btn>
        )}
        <Btn variant="filled" icon="search" onClick={() => void run()} disabled={!armed}>
          {t("vs.search")}
        </Btn>
      </ModalActions>
    </Modal>
  );
}

/** One matching table: where it is, how many rows matched, and a sample. */
function HitCard({ hit, needle, mode }: { hit: TableHit; needle: string; mode: MatchMode }) {
  const t = useT();
  return (
    <details className="vs-hit" open={hit.rows.length <= 5}>
      <summary>
        <Icon name="table" size={15} />
        <span className="vs-hit-name">
          {hit.schema}.<b>{hit.table}</b>
        </span>
        {hit.matchedColumns.length > 0 ? (
          <span className="vs-hit-cols">
            {t("vs.matchedIn")} {hit.matchedColumns.join(", ")}
          </span>
        ) : null}
        <span className="vs-hit-count">
          {hit.totalMatches === null
            ? t("vs.someMatches", { count: fmt(hit.rows.length) })
            : t("vs.matchCount", { count: fmt(hit.totalMatches) })}
        </span>
      </summary>
      <div className="vs-hit-grid">
        <table>
          <thead>
            <tr>
              {hit.columns.map((c) => (
                <th
                  key={c.name}
                  className={hit.matchedColumns.includes(c.name) ? "vs-col-hit" : undefined}
                >
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hit.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className={cellHit(cell, needle, mode) ? "vs-cell-hit" : undefined}>
                    {cell === null ? <span className="vs-null">NULL</span> : cellText(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hit.truncated ? (
        <p className="vs-hit-more">
          {t("vs.showingOf", {
            shown: fmt(hit.rows.length),
            total: fmt(hit.totalMatches ?? hit.rows.length),
          })}
        </p>
      ) : null}
    </details>
  );
}
