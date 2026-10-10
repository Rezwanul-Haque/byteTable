// FK awareness for the key-cell editors (binary + UUID). A foreign key is the
// one kind of key the editor must NOT invent: its value has to be a key that
// already exists in the parent table. So the editors drop their "Generate"
// control for an FK column and show this note instead — the reference target,
// plus a live "is this key actually there?" lookup of what is in the input.
//
// The lookup is the same `row_lookup` call the FK peek popover makes (one
// indexed `WHERE refColumn = value` with the value BOUND — binary binds as raw
// bytes), debounced so typing a key does not fire one per keystroke. Without a
// `handleId` (the data-file inspector has no connection) only the reference is
// shown.

import { useEffect, useState } from "react";

import type { CellValue, FkRef } from "../../../../shared/api/engine";
import { rowLookup } from "../../../../shared/api/engine";
import { appErrorMessage } from "../../../../shared/api/error";
import { Icon } from "../../../../shared/ui/Icon";

/** Debounce before the existence lookup fires (one keystroke pause). */
const LOOKUP_DELAY_MS = 350;

/** The outcome of one lookup. "Checking" is not a state here — it is derived:
 *  the result carries the value it is FOR, so a value with no result yet is
 *  in flight (which keeps the effect free of synchronous setState). */
type CheckResult =
  | { kind: "found"; count: number }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function FkTargetNote({
  handleId,
  refSchema,
  fk,
  value,
  binary,
}: {
  /** Omit to show the reference without checking it (no connection at hand). */
  handleId?: string;
  /** Schema of the referenced table (the source table's own, as the FK peek). */
  refSchema: string;
  fk: FkRef;
  /** The value the editor would save right now; null when the input is empty
   *  or invalid, which checks nothing. */
  value: CellValue;
  /** True when the referenced column is binary, so the value binds as bytes. */
  binary?: boolean;
}) {
  const target = fk.table + (fk.column ? "." + fk.column : "");
  // Lookups are keyed by the value's text so a result can be matched to the
  // value it describes (and a re-typed value re-uses nothing stale).
  const valueKey = value === null ? null : String(value);
  const checkable = !!handleId && !!fk.column && valueKey !== null;
  const [result, setResult] = useState<{ key: string; result: CheckResult } | null>(null);

  useEffect(() => {
    if (!handleId || !fk.column || valueKey === null) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void rowLookup(handleId, {
        schema: refSchema,
        table: fk.table,
        column: fk.column,
        value: valueKey,
        binary,
      }).then(
        (res) => {
          if (!alive) return;
          setResult({
            key: valueKey,
            result: res.row ? { kind: "found", count: res.matchCount } : { kind: "missing" },
          });
        },
        (err: unknown) => {
          if (!alive) return;
          setResult({
            key: valueKey,
            result: { kind: "error", message: appErrorMessage(err, "Lookup failed.") },
          });
        },
      );
    }, LOOKUP_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [handleId, refSchema, fk.table, fk.column, valueKey, binary]);

  // Checkable with no result for THIS value yet → the lookup is pending.
  const state = checkable && result?.key === valueKey ? result.result : null;

  return (
    <div className="fk-target-note">
      <Icon name="link" size={13} style={{ color: "var(--accent)" }} />
      <span className="fk-target-ref">
        References <code>{target}</code>
      </span>
      {!checkable ? null : state === null ? (
        <span className="fk-target-state">checking…</span>
      ) : (
        <span className={"fk-target-state" + (state.kind === "found" ? " ok" : " err")}>
          {state.kind === "found" ? (
            <>
              <Icon name="check_circle" size={12} /> key exists
              {state.count > 1 ? " (" + state.count + " rows)" : ""}
            </>
          ) : state.kind === "missing" ? (
            <>
              <Icon name="error" size={12} /> no such row in {fk.table}
            </>
          ) : (
            <>
              <Icon name="error" size={12} /> {state.message}
            </>
          )}
        </span>
      )}
    </div>
  );
}
