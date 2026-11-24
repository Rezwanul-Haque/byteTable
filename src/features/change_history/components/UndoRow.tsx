// One row of "What undo does to each row" (M48 E5), ported from the
// prototype's UndoRow.

import { useT } from "../../../shared/i18n/useT";
import { Icon } from "../../../shared/ui/Icon";
import type { CellValue } from "../../../shared/api/engine";
import type { Change, Verdict } from "../api";
import { MaskedText } from "../../masking/components/MaskedText";
import { maskShow } from "../../masking/state";
import { shown } from "../model";

function Val({ v, col, strike }: { v: CellValue | undefined; col: string; strike?: boolean }) {
  const isNull = v === null || v === undefined;
  // Masking (M49): the one entry point, by this value's column.
  const masked = maskShow(v, col);
  if (masked) {
    return (
      <span className={"ul-val" + (strike ? " strike" : "")}>
        <MaskedText text={masked.text} />
      </span>
    );
  }
  return (
    <span
      className={"ul-val" + (isNull ? " null" : "") + (strike ? " strike" : "")}
      title={shown(v)}
    >
      {shown(v)}
    </span>
  );
}

/** A value as text for a line of prose (masked when sensitive). */
const said = (v: unknown, col: string) => maskShow(v, col)?.text ?? shown(v);

const ICON = { ok: "check_circle", conflict: "block", noop: "remove_done" } as const;

export function UndoRow({
  change: c,
  verdict: v,
  redo,
}: {
  change: Change;
  verdict: Verdict;
  redo: boolean;
}) {
  const t = useT();
  const at = (row: CellValue[] | null, col: string) => {
    const i = c.columns.indexOf(col);
    return i >= 0 && row ? row[i] : null;
  };
  // For redo the row moves from `before` to `after` again.
  const from = redo ? c.before : c.after;
  const to = redo ? c.after : c.before;
  const icon = v.state === "done" ? (redo ? "radio_button_unchecked" : "undo") : ICON[v.state];
  const what =
    v.state === "done"
      ? t(redo ? "history.row.notUndone" : "history.row.alreadyBack")
      : c.kind === "insert"
        ? t(redo ? "history.row.addAgain" : "history.row.delete")
        : c.kind === "delete"
          ? t(redo ? "history.row.deleteAgain" : "history.row.addBack")
          : t(redo ? "history.row.changeAgain" : "history.row.setBack");
  const row = c.before ?? c.after ?? [];
  const preview = c.columns
    .slice(0, 4)
    .map((col, i) => col + ": " + said(row[i], col))
    .join(" · ");
  return (
    <div className={"ul-row " + v.state}>
      <Icon name={icon} size={15} />
      <div className="ul-row-main">
        <div className="ul-row-head">
          <span className="ul-row-key">
            {c.table} · {c.pk.map((k, i) => k + " " + said(c.key[i], k)).join(", ")}
          </span>
          <span className="ul-row-what">{what}</span>
        </div>
        {c.kind === "update" ? (
          <div className="ul-cols">
            {c.cols.map((col) => (
              <div key={col} className="ul-col">
                <span className="ul-col-name">{col}</span>
                <Val v={at(from, col)} col={col} strike />
                <Icon name="arrow_forward" size={12} />
                <Val v={at(to, col)} col={col} />
              </div>
            ))}
          </div>
        ) : (
          <div className="ul-preview">{preview}</div>
        )}
        {v.state === "conflict" || v.state === "noop" ? (
          <div className="ul-why">
            <b>{t(v.state === "conflict" ? "history.why.skipped" : "history.why.nothing")} </b>
            {v.why ? t(`history.why.${v.why}`, { table: c.table }) : null}
            {(v.now ?? []).map((d) => (
              <span key={d.col}>
                {" "}
                {t("history.why.driftPre")} <code>{d.col}</code> {t("history.why.driftNow")}{" "}
                <code>{said(d.now, d.col)}</code>
                {t("history.why.driftWas")} <code>{said(d.was, d.col)}</code>.
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
