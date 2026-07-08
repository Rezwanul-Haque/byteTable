// The schemaless DynamoDB item grid (M17 §17.2): attribute-union columns with
// keys first, nested maps/lists shown compactly (click any row to open the item
// editor). Ported from the prototype's `DynamoItemGrid` in `dynamo.jsx`.
//
// PERFORMANCE: a Dynamo partition can return 100+ items each with ~100
// attributes, i.e. ~10k cells. A plain <table> rendering every cell froze the
// UI (huge DOM, blank paint regions, and a full re-reconcile on every parent
// state change). So this is a div-based CSS-grid with ROW VIRTUALISATION
// (TanStack) — only the visible rows mount — mirroring the SQL DataGrid. That
// also keeps re-renders cheap (only ~20 rows reconcile), so button clicks stay
// responsive while a large result is on screen.

import { useEffect, useMemo, useRef } from "react";

import { useVirtualizer } from "@tanstack/react-virtual";

import { Icon } from "../../../shared/ui/Icon";
import { useToast } from "../../../shared/ui/toastContext";
import type { DynamoItem, KeySchema } from "../api";
import { attributeUnion, dynamoFmt } from "../helpers";

/** The raw, copyable text of a cell value (objects → JSON, null → empty). */
function copyText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Fixed row height (px) handed to the virtualizer — single-line ellipsised
 *  cells, matching the prototype's row metrics. */
const ROW_H = 30;
/** DOM rows kept beyond the viewport (smooth fast-scroll). */
const ROW_OVERSCAN = 12;

// Column-width estimate (no per-cell measuring: sample a few rows and clamp).
const CHAR_PX = 7;
const PAD_PX = 26;
const COL_MIN_PX = 90;
const COL_MAX_PX = 360;
/** Column overscan for the horizontal virtualizer; above the threshold the
 *  column axis is windowed too (a wide item no longer renders every attribute). */
const COL_OVERSCAN = 3;
const COL_VIRT_THRESHOLD = 30;
/** Minimum row-number gutter width (px). Grows with the digit count below so a
 *  large row number isn't clipped. */
const ROWNUM_PX = 40;
/** Per-digit width of the row number + gutter padding — used to size the gutter. */
const ROWNUM_DIGIT_PX = 7.5;
const ROWNUM_PAD_PX = 14;
const CHECK_PX = 34;
const WIDTH_SAMPLE_ROWS = 40;

interface DynamoItemGridProps {
  items: DynamoItem[];
  keySchema: KeySchema;
  onOpenItem?: (item: DynamoItem) => void;
  /** Row indices currently selected. Presence of `onToggleRow` enables the
   *  checkbox column. */
  selected?: Set<number>;
  onToggleRow?: (index: number) => void;
  onToggleAll?: () => void;
}

export function DynamoItemGrid({
  items,
  keySchema,
  onOpenItem,
  selected,
  onToggleRow,
  onToggleAll,
}: DynamoItemGridProps) {
  const toast = useToast();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const copy = (v: unknown) =>
    void navigator.clipboard.writeText(copyText(v)).then(
      () => toast("Copied to clipboard", "ok"),
      () => toast("Couldn't copy to clipboard", "err"),
    );

  // Keys first, then the remaining attributes in first-seen order. Keys are only
  // shown when actually present in the returned items — a projection that omits
  // PK/SK must not render empty key columns.
  const ordered = useMemo(() => {
    const cols = attributeUnion(items);
    return [keySchema.pk, keySchema.sk]
      .filter((c): c is string => !!c && cols.includes(c))
      .concat(cols.filter((c) => c !== keySchema.pk && c !== keySchema.sk).sort());
  }, [items, keySchema.pk, keySchema.sk]);

  const selectable = !!onToggleRow;

  // Per-column fixed px width (estimated from the header + a sample of cell
  // lengths). Shared by the CSS grid tracks and the horizontal virtualizer.
  const colWidths = useMemo(
    () =>
      ordered.map((c) => {
        let maxLen = c.length;
        for (let i = 0; i < items.length && i < WIDTH_SAMPLE_ROWS; i++) {
          const len = copyText(items[i]?.[c]).length;
          if (len > maxLen) maxLen = len;
        }
        return Math.round(Math.min(COL_MAX_PX, Math.max(COL_MIN_PX, maxLen * CHAR_PX + PAD_PX)));
      }),
    [ordered, items],
  );

  // Row-number gutter sized to the largest row number (see the browse DataGrid).
  const rownumPx = useMemo(() => {
    const digits = Math.max(2, String(Math.max(1, items.length)).length);
    return Math.max(ROWNUM_PX, Math.ceil(digits * ROWNUM_DIGIT_PX + ROWNUM_PAD_PX));
  }, [items.length]);

  // Column (horizontal) virtualization: a wide item (100+ attributes) renders
  // only the columns in view, bracketed by pad tracks summing the off-screen
  // columns' widths so the canvas width and row tracks stay identical. Below the
  // threshold every column renders (windowing gains nothing).
  const virtualizeCols = ordered.length > COL_VIRT_THRESHOLD;
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: ordered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colWidths[i] ?? COL_MIN_PX,
    overscan: COL_OVERSCAN,
  });
  const colWidthSig = colWidths.join(",");
  useEffect(() => {
    colVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colWidthSig]);

  const colItems = colVirtualizer.getVirtualItems();
  let padL = 0;
  let padR = 0;
  let winIdx = ordered.map((_, i) => i);
  if (virtualizeCols && colItems.length > 0) {
    const last = colItems[colItems.length - 1]!;
    padL = colItems[0]!.start;
    padR = colVirtualizer.getTotalSize() - (last.start + last.size);
    winIdx = colItems.map((vi) => vi.index);
  }

  // Grid track template: [checkbox] + row-number gutter + [pad] + visible tracks
  // + [pad].
  const gridCols = useMemo(() => {
    const lead = (selectable ? CHECK_PX + "px " : "") + rownumPx + "px";
    const tracks = winIdx.map((i) => colWidths[i] + "px").join(" ");
    if (!virtualizeCols) return lead + " " + tracks;
    return lead + " " + padL + "px " + tracks + " " + padR + "px";
  }, [selectable, rownumPx, colWidths, winIdx, virtualizeCols, padL, padR]);

  // The virtualizer's results are consumed inline in render only (never passed
  // to a memoized child), so the compiler's "cannot memoize" caution is moot.
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: ROW_OVERSCAN,
  });

  if (!items.length) return <div className="ddb-grid-empty">No items</div>;

  const sel = selected ?? new Set<number>();
  const allSelected = selectable && items.length > 0 && sel.size === items.length;
  const someSelected = selectable && sel.size > 0 && !allSelected;
  const totalHeight = rowVirtualizer.getTotalSize();

  return (
    <div className="ddb-vg-wrap" ref={scrollRef}>
      <div className="ddb-vg-canvas" style={{ "--ddb-vg-cols": gridCols } as React.CSSProperties}>
        {/* Sticky header row. */}
        <div className="ddb-vg-row ddb-vg-header">
          {selectable ? (
            <div className="ddb-vg-check-c">
              <input
                type="checkbox"
                className="ddb-dg-check"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={onToggleAll}
                aria-label="Select all rows"
              />
            </div>
          ) : null}
          <div className="ddb-vg-rownum ddb-vg-rownum-h">#</div>
          {virtualizeCols ? <div className="ddb-vg-pad" aria-hidden /> : null}
          {winIdx.map((ci) => {
            const c = ordered[ci]!;
            return (
              <div key={c} className="ddb-vg-th" title={c}>
                {c === keySchema.pk ? (
                  <span className="ddb-key-badge pk">PK</span>
                ) : c === keySchema.sk ? (
                  <span className="ddb-key-badge sk">SK</span>
                ) : null}
                <span className="ddb-vg-colname">{c}</span>
              </div>
            );
          })}
          {virtualizeCols ? <div className="ddb-vg-pad" aria-hidden /> : null}
        </div>

        {/* Virtualised body: only visible rows mount. */}
        <div style={{ height: totalHeight, position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vr) => {
            const ri = vr.index;
            const it = items[ri];
            if (!it) return null;
            return (
              <div
                key={ri}
                className={"ddb-vg-row ddb-vg-body-row" + (sel.has(ri) ? " selected" : "")}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  height: vr.size,
                  transform: `translateY(${vr.start}px)`,
                }}
                onClick={() => onOpenItem?.(it)}
                role={onOpenItem ? "button" : undefined}
              >
                {selectable ? (
                  <div className="ddb-vg-check-c" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="ddb-dg-check"
                      checked={sel.has(ri)}
                      onChange={() => onToggleRow?.(ri)}
                      aria-label={`Select row ${ri + 1}`}
                    />
                  </div>
                ) : null}
                <div className="ddb-vg-rownum">{ri + 1}</div>
                {virtualizeCols ? <div className="ddb-vg-pad" aria-hidden /> : null}
                {winIdx.map((ci) => {
                  const c = ordered[ci]!;
                  const v = it[c];
                  const disp = dynamoFmt(v);
                  const isObj = typeof v === "object" && v !== null;
                  return (
                    <div key={c} className="ddb-vg-cell" title={isObj ? JSON.stringify(v) : ""}>
                      {disp === null ? (
                        <span className="ddb-cell-null">—</span>
                      ) : isObj ? (
                        <span className="ddb-json-chip">
                          <Icon name="data_object" size={10} /> {disp}
                        </span>
                      ) : typeof v === "number" ? (
                        <span className="ddb-cell-num">{disp}</span>
                      ) : typeof v === "boolean" ? (
                        <span className={v ? "ddb-cell-true" : "ddb-cell-false"}>{disp}</span>
                      ) : (
                        <span className="ddb-cell-text">{disp}</span>
                      )}
                      {/* Hover copy — copies the raw value (off the row-open click). */}
                      <button
                        type="button"
                        className="ddb-cell-copy"
                        title="Copy value"
                        aria-label={"Copy " + c + " value"}
                        onClick={(e) => {
                          e.stopPropagation();
                          copy(v);
                        }}
                      >
                        <Icon name="content_copy" size={12} />
                      </button>
                    </div>
                  );
                })}
                {virtualizeCols ? <div className="ddb-vg-pad" aria-hidden /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
