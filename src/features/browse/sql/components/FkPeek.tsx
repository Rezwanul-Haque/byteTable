// FK peek popover (M10 §3.5). Opened when an FK cell link is clicked: looks up
// the referenced row (`rowLookup`) and shows it in a 300px popover positioned
// near the clicked cell — title `refTable` + "where refColumn = value", a zebra
// field list (≤7 fields, per the prototype), a match-count badge when >1, and
// an "Open in {refTable}" button that opens/focuses that table tab with its
// filter seeded to `refColumn = value` (so the opened grid shows the row(s)).
//
// Markup + behavior ported from the prototype's grid.jsx FK peek; CSS is the
// byte-exact `.fk-*` / `.dg-popover` / `.dg-pop-*` rules from ByteTable.html.
// Outside-click / Esc close, role=dialog, anchored + viewport-clamped.

import { useEffect, useRef, useState } from "react";

import type { CellValue, RowLookup } from "../../../../shared/api/engine";
import { rowLookup } from "../../../../shared/api/engine";
import { appErrorMessage } from "../../../../shared/api/error";
import { CopyButton } from "../../../../shared/ui/CopyButton";
import { Icon } from "../../../../shared/ui/Icon";
import { useT } from "../../../../shared/i18n/useT";
import { binaryClipboardText, formatBinary, isBinaryType } from "../../shared/binaryCell";
import { CellContent } from "../../shared/components/GridCell";
import "./Popovers.css";

/** Max referenced-row fields shown in the peek list (prototype truncation). */
const MAX_FIELDS = 7;

/**
 * The copy buttons offered for one peeked field. Every value here is shown
 * TRUNCATED (a 300px popover), so the clipboard is the only way to get a whole
 * one out — and for a binary key both forms are wanted: the UUID a human reads
 * and quotes, and the `0x`-hex the column actually stores, which is what a
 * hand-written `WHERE id = …` needs. A large-blob placeholder ("[N bytes]") is
 * not a value and gets no button.
 */
function copyActions(
  value: CellValue,
  type: string | undefined,
): { label: string; text: string; icon?: string }[] {
  if (value === null || value === undefined) return [];
  if (isBinaryType(type)) {
    const actions: { label: string; text: string; icon?: string }[] = [];
    const repr = formatBinary(value, type);
    if (repr?.kind === "uuid") actions.push({ label: "Copy UUID", text: repr.text });
    const hex = binaryClipboardText(value);
    if (/^0x[0-9a-f]+$/i.test(hex))
      actions.push({ label: "Copy stored bytes (0x-hex)", text: hex, icon: "tag" });
    return actions;
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text === "" ? [] : [{ label: "Copy value", text }];
}

export interface FkPeekAnchor {
  /** The clicked cell's bounding rect (drives positioning). */
  rect: DOMRect;
  /** The schema of the referenced table (same as the source for SQLite). */
  refSchema: string;
  /** The referenced table (column.fk.table). */
  refTable: string;
  /** The referenced column (column.fk.column) — the lookup/seed key. */
  refColumn: string;
  /** The FK cell's value (the key looked up + seeded). */
  value: CellValue;
  /** True when the key is a binary column — the value binds as raw bytes so the
   *  lookup (and the seeded filter) match a binary key. */
  binary?: boolean;
}

/** Clamp a popover of `width`×`height` near `rect` to the viewport. */
function popoverPos(rect: DOMRect, width: number, height: number): { left: number; top: number } {
  const x = Math.min(rect.left, window.innerWidth - width - 12);
  let y = rect.bottom + 6;
  if (y + height > window.innerHeight - 8) y = Math.max(8, rect.top - height - 6);
  return { left: Math.max(8, x), top: y };
}

export function FkPeek({
  handleId,
  anchor,
  onClose,
  onOpenInTable,
}: {
  handleId: string;
  anchor: FkPeekAnchor;
  onClose: () => void;
  /** Open the referenced table tab seeded with `refColumn = value`. */
  onOpenInTable: (anchor: FkPeekAnchor) => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<RowLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const t = useT();

  const { refSchema, refTable, refColumn, value, binary } = anchor;

  // Look up the referenced row. A fresh anchor (new click) re-fetches; a stale
  // response is dropped via the alive flag.
  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setResult(null);
      setError(null);
      try {
        const r = await rowLookup(handleId, {
          schema: refSchema,
          table: refTable,
          column: refColumn,
          value,
          binary,
        });
        if (!alive) return;
        setResult(r);
        setLoading(false);
      } catch (err: unknown) {
        if (!alive) return;
        setError(appErrorMessage(err, t("grid.lookupFail")));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [handleId, refSchema, refTable, refColumn, value, binary, t]);

  // Outside-click / Esc close (Rail/Sidebar pattern). The anchoring cell lives
  // outside this popover, so any mousedown not inside the popover closes it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current && popRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const pos = popoverPos(anchor.rect, 300, 240);
  const row = result?.row ?? null;
  const cols = result?.columns ?? [];
  const matchCount = result?.matchCount ?? 0;

  return (
    <div
      ref={popRef}
      className="dg-popover fk-peek"
      style={pos}
      role="dialog"
      aria-label={t("grid.referencedRowIn", { table: refTable })}
    >
      <div className="dg-pop-title">
        <Icon name="link" size={14} style={{ color: "var(--accent)" }} />
        <span className="dg-pop-mono">{refTable}</span>
        <span className="dg-pop-dim">
          {t("grid.whereCond", { column: refColumn, value: String(value) })}
        </span>
        {matchCount > 1 ? (
          <span className="fk-matchcount">{t("grid.matchOneOf", { count: matchCount })}</span>
        ) : null}
      </div>

      {loading ? (
        <div className="dg-pop-loading">
          <span className="dg-pop-spinner" />
          <span className="dg-pop-dim">{t("grid.lookingUp")}</span>
        </div>
      ) : error ? (
        <div className="dg-pop-empty">{error}</div>
      ) : row ? (
        <div className="fk-fields">
          {cols.slice(0, MAX_FIELDS).map((c, i) => {
            const cell = row[i] ?? null;
            const actions = copyActions(cell, c.typeHint);
            return (
              <div className="fk-field" key={c.name}>
                <span className="fk-field-name" title={c.name}>
                  {c.name}
                </span>
                <span className="fk-field-val">
                  <CellContent value={cell} column={c.name} type={c.typeHint} />
                </span>
                {actions.length > 0 ? (
                  <span className="fk-copies">
                    {actions.map((a) => (
                      <CopyButton
                        key={a.label}
                        className="fk-copy"
                        label={a.label}
                        text={a.text}
                        icon={a.icon}
                      />
                    ))}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="dg-pop-empty">{t("grid.noMatchingRow")}</div>
      )}

      <button type="button" className="fk-open-btn" onClick={() => onOpenInTable(anchor)}>
        <Icon name="open_in_new" size={13} /> {t("grid.openIn", { table: refTable })}
      </button>
    </div>
  );
}
