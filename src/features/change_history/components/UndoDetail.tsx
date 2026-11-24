// The right side of the Change history tab (M48 E): what ran, the verdict,
// what undo does to each row, the exact statements, and the action bar.
// Ported from the prototype's UndoDetail.

import { maskShow, maskSql, useMask } from "../../masking/state";
import { useEffect, useState } from "react";

import { fmtNumber } from "../../../shared/i18n";
import { useT } from "../../../shared/i18n/useT";
import { normalizeEnv } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { useReadOnly } from "../../../shared/ui/readOnlyContext";
import { useToast } from "../../../shared/ui/toastContext";
import { highlightSql } from "../../browse/shared/highlightSql";
import { useWorkspacesStore } from "../../workspaces/state";
import type { Workspace } from "../../workspaces/types";
import { historyApply, historyCheck, historyGet, type CheckView, type Entry } from "../api";
import { actionLabel, dayOf, sourceLabel, statusOf, timeOf, titleOf, verdictOf } from "../model";
import { useHistoryStore } from "../state";
import { UndoRow } from "./UndoRow";

/** Rows drawn in "What undo does to each row"; the rest are counted. */
const SHOW_ROWS = 50;

const summaryOf = (e: Entry) => ({
  ...e,
  inserted: e.changes.filter((c) => c.kind === "insert").length,
  updated: e.changes.filter((c) => c.kind === "update").length,
  deleted: e.changes.filter((c) => c.kind === "delete").length,
  changes: e.changes.length,
  undone: e.undone.length,
  tables: [...new Set([...e.changes.map((c) => c.table), ...e.tables])],
});

export function UndoDetail({ workspace, id }: { workspace: Workspace; id: string }) {
  const t = useT();
  const toast = useToast();
  const readOnly = useReadOnly();
  const version = useHistoryStore((s) => s.version);
  const bump = useHistoryStore((s) => s.bump);
  const openSqlTabWith = useWorkspacesStore((s) => s.openSqlTabWith);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [view, setView] = useState<CheckView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [arm, setArm] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [busy, setBusy] = useState(false);
  const isProd = normalizeEnv(workspace.saved.env) === "production";
  // Masking (M49): one subscription for the detail; values read on render.
  useMask();

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const e = await historyGet(id);
        if (!live) return;
        setEntry(e);
        setError(null);
        const v = e && !e.cant ? await historyCheck(workspace.handleId, id) : null;
        if (live) setView(v);
      } catch (err) {
        if (live) setError(String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [id, version, workspace.handleId]);

  if (error) return <div className="ul-detail ul-d-error">{error}</div>;
  if (!entry) return <div className="ul-detail" />;

  const summary = summaryOf(entry);
  // The SQL shown is masked by literal: the entry's own sensitive values (found
  // by their columns), plus anything that looks sensitive by itself. Copy,
  // "Open in a SQL tab" and the undo itself use the real text.
  const known = new Map<string, string>();
  for (const c of entry.changes) {
    for (const row of [c.before, c.after]) {
      c.columns.forEach((col, i) => {
        const v = row?.[i];
        const m = typeof v === "string" ? maskShow(v, col) : null;
        if (m && typeof v === "string") known.set(v, m.text);
      });
    }
  }
  const status = statusOf(summary);
  const verdict = verdictOf(entry, view);
  const verdicts = view?.verdicts ?? [];
  const ok = verdicts.filter((v) => v.state === "ok").length;
  const noop = verdicts.filter((v) => v.state === "noop").length;
  const redo = !!view?.redo;

  const go = async () => {
    if (!view) return;
    if (isProd && !arm) {
      setArm(true);
      return;
    }
    setBusy(true);
    try {
      const out = await historyApply(
        workspace.handleId,
        id,
        view.verdicts.map((v) => v.state),
      );
      setArm(false);
      if (out.changed) {
        toast(t("history.toast.changed"), "err");
      } else {
        const rows = t("history.rows", { count: out.applied });
        const msg = t(redo ? "history.toast.redone" : "history.toast.undone", { rows });
        toast(
          out.skipped ? msg + t("history.toast.skipped", { n: fmtNumber(out.skipped) }) : msg,
          "ok",
        );
      }
      bump();
    } catch (err) {
      toast(String(err), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ul-detail">
      <div className="ul-d-head">
        <h3>{titleOf(summary)}</h3>
        <div className="ul-d-meta">
          <span>
            {dayOf(entry.at)}, {timeOf(entry.at)}
          </span>
          <span>·</span>
          <span>{sourceLabel(entry.source)}</span>
          <span>·</span>
          <span className="mono">
            {workspace.saved.name} · {entry.schemaName}
          </span>
          {status === "undone" ? (
            <span className="ul-badge undone">{t("history.badge.undone")}</span>
          ) : status === "partial" ? (
            <span className="ul-badge partial">{t("history.badge.partial")}</span>
          ) : null}
        </div>
      </div>

      {entry.sql ? (
        <div className="ul-block">
          <div className="ul-block-h">{t("history.detail.ran")}</div>
          <pre
            className="ul-sql"
            dangerouslySetInnerHTML={{ __html: highlightSql(maskSql(entry.sql, known)) }}
          />
        </div>
      ) : null}

      <div className={"ul-verdict " + verdict.tone} role="status">
        <Icon name={verdict.icon} size={17} />
        <span>{verdict.text}</span>
      </div>

      {entry.sideEffects && !entry.cant ? (
        <div className="ul-verdict warn">
          <Icon name="account_tree" size={17} />
          <span>{t("history.detail.sideEffects")}</span>
        </div>
      ) : null}

      {verdicts.length ? (
        <div className="ul-block">
          <div className="ul-block-h">
            {t(redo ? "history.detail.redoRows" : "history.detail.undoRows")}
            <span>
              {verdicts.length > SHOW_ROWS
                ? t("history.detail.firstOf", {
                    n: SHOW_ROWS,
                    total: fmtNumber(verdicts.length),
                  })
                : t("history.rows", { count: verdicts.length })}
            </span>
          </div>
          <div className="ul-rows">
            {verdicts.slice(0, SHOW_ROWS).map((v) => {
              const c = entry.changes[v.i];
              return c ? <UndoRow key={v.i} change={c} verdict={v} redo={redo} /> : null;
            })}
          </div>
        </div>
      ) : null}

      {view?.statements.length ? (
        <div className="ul-block">
          <button
            type="button"
            className="ul-disc"
            aria-expanded={showSql}
            onClick={() => setShowSql(!showSql)}
          >
            <Icon name={showSql ? "expand_more" : "chevron_right"} size={16} />{" "}
            {t("history.detail.statements")}{" "}
            <span>{t("history.detail.statementCount", { count: view.statements.length })}</span>
          </button>
          {showSql ? (
            <>
              <pre
                className="ul-sql"
                dangerouslySetInnerHTML={{ __html: highlightSql(maskSql(view.sql, known)) }}
              />
              <div className="ul-sql-actions">
                <Btn
                  small
                  variant="text"
                  icon="content_copy"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(view.sql)
                      .then(() => toast(t("history.toast.copied"), "ok"))
                      .catch(() => undefined);
                  }}
                >
                  {t("history.detail.copy")}
                </Btn>
                <Btn
                  small
                  variant="text"
                  icon="open_in_new"
                  onClick={() => openSqlTabWith(view.sql)}
                >
                  {t("history.detail.openSql")}
                </Btn>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {entry.history.length ? (
        <div className="ul-block">
          <div className="ul-block-h">{t("history.detail.activity")}</div>
          <ul className="ul-hist">
            {entry.history.map((h, i) => (
              <li key={i}>
                {t(h.what === "undo" ? "history.activity.undo" : "history.activity.redo", {
                  day: dayOf(h.at).toLowerCase(),
                  time: timeOf(h.at),
                  rows: t("history.rows", { count: h.rows }),
                })}
                {h.skipped ? t("history.toast.skipped", { n: fmtNumber(h.skipped) }) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!entry.cant && view ? (
        <div className="ul-actions">
          <span className="ul-actions-note">
            {readOnly ? (
              <>
                <Icon name="lock" size={14} /> {t("history.detail.readOnly")}
              </>
            ) : ok ? (
              t(redo ? "history.detail.oneTxnRedo" : "history.detail.oneTxn") +
              (noop ? " " + t("history.detail.alreadyBack", { n: fmtNumber(noop) }) : "")
            ) : null}
          </span>
          {arm ? (
            <Btn small variant="text" onClick={() => setArm(false)}>
              {t("history.cancel")}
            </Btn>
          ) : null}
          <Btn
            small
            variant={arm ? "tonal" : "filled"}
            className={arm ? "btn-danger" : undefined}
            icon={arm ? "warning" : redo ? "redo" : "undo"}
            disabled={!ok || readOnly || busy}
            onClick={() => void go()}
          >
            {arm
              ? t(redo ? "history.action.armRedo" : "history.action.armUndo")
              : actionLabel(view)}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
