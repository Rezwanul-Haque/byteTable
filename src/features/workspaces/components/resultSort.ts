// Client-side sort for the SQL-results grid (SqlResultGrid). Pure + free of
// React so the ordering rules can be reasoned about (and exercised) on their
// own, like formatSql.ts / sqlStatement.ts next door.
//
// WHY client-side: unlike the browse DataGrid — which pushes ORDER BY into the
// query and re-pages from the backend — a query result is one materialized
// batch already in memory. Sorting it is a reorder, not a re-run, so it sorts
// exactly what the query RETURNED (with a backend row_limit in play, that is
// the returned page, not the whole table).

import type { CellValue, SortDirection, SortSpec } from "../../../shared/api/engine";

/** Sort state cycles asc → desc → none (null) on repeated header clicks —
 *  identical to the browse DataGrid's `cycleSort`. */
export function cycleSort(current: SortSpec | null, column: string): SortSpec | null {
  if (!current || current.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

/** A cell value as text: objects → JSON (the same form the CSV export writes),
 *  everything else its string form. */
function cellText(value: CellValue): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Natural-order collator for the text comparison path: `item2` sorts before
 *  `item10`, and big integers a driver handed back as strings still order
 *  numerically. Built once — a collator per comparison is slow. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Order two NON-NULL cell values (nulls are handled by `sortedOrder`, which
 * sinks them regardless of direction). Same-typed numbers/booleans compare by
 * value; anything else compares as text.
 */
export function compareValues(a: CellValue, b: CellValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return COLLATOR.compare(cellText(a), cellText(b));
}

/**
 * Display order for `rows` as indexes INTO `rows` — the result itself is never
 * reordered, so row selection (keyed by the original index) and the measured
 * column widths survive a sort untouched.
 *
 * NULLs sink to the bottom in BOTH directions ("no value" is neither smaller
 * nor larger than a value, and burying them beats leading with them), and ties
 * keep the query's original order, so the sort is stable.
 */
export function sortedOrder(
  rows: readonly CellValue[][],
  colIndex: number,
  direction: SortDirection,
): number[] {
  const idx = rows.map((_, i) => i);
  if (colIndex < 0) return idx;
  const dir = direction === "asc" ? 1 : -1;
  return idx.sort((ra, rb) => {
    const a = rows[ra]![colIndex] ?? null;
    const b = rows[rb]![colIndex] ?? null;
    if (a === null || b === null) {
      if (a === null && b === null) return ra - rb;
      return a === null ? 1 : -1;
    }
    const c = compareValues(a, b);
    return c !== 0 ? c * dir : ra - rb;
  });
}
