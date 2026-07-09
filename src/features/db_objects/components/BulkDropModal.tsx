// Bulk drop-confirm modal for the Object Explorer (M22). Mirrors
// ObjectDropModal's chrome + prod gate, but for N selected objects: a per-class
// tally, a preview of up to 6 `DROP …;` statements, and — on a production
// connection — a `drop <N>` type-to-arm gate. Portaled to document.body (the
// Explorer lives inside a transformed tab container).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import type { Engine, Env } from "../../../shared/types";
import type { DbObjectKind } from "../api";
import { dropPrefix } from "../ddl";
import { OBJ_SECTIONS } from "../kinds";

export interface BulkDropRow {
  kind: DbObjectKind;
  name: string;
  detail: string | null;
}

const PREVIEW_MAX = 6;

export function BulkDropModal({
  engine,
  env,
  envColor,
  schema,
  rows,
  busy,
  onConfirm,
  onClose,
}: {
  engine: Engine;
  env: Env;
  envColor: string;
  schema: string;
  rows: BulkDropRow[];
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const isProd = env === "production";
  const word = `drop ${rows.length}`;
  const armed = (!isProd || typed.trim().toLowerCase() === word) && !busy;

  // Per-class tally (e.g. "3 views · 2 functions").
  const tally = new Map<DbObjectKind, number>();
  for (const r of rows) tally.set(r.kind, (tally.get(r.kind) ?? 0) + 1);

  const preview = rows
    .slice(0, PREVIEW_MAX)
    .map((r) => dropPrefix(engine, r.kind, schema, r.name, r.detail))
    .join("\n");
  const overflow = rows.length - Math.min(rows.length, PREVIEW_MAX);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal truncate-modal" role="dialog" aria-modal="true">
        <div className="modal-title">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Icon name="warning" size={18} style={{ color: "var(--danger)" }} /> Drop {rows.length}{" "}
            object{rows.length === 1 ? "" : "s"}
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>
        <div className="truncate-body">
          <p>
            This permanently drops {rows.length} object{rows.length === 1 ? "" : "s"} from{" "}
            <code>{schema}</code>. This cannot be undone.
          </p>
          <div className="oe-drop-tally">
            {[...tally.entries()].map(([kind, n]) => (
              <span key={kind} className="oe-drop-chip">
                {n} {OBJ_SECTIONS[kind].group.toLowerCase()}
              </span>
            ))}
          </div>
          <pre className="truncate-sql obj-drop-sql">
            {preview}
            {overflow > 0 ? `\n-- …and ${overflow} more` : ""}
          </pre>
          {isProd ? (
            <div className="truncate-prod">
              <div
                className="truncate-prod-tag"
                style={{
                  color: envColor,
                  borderColor: envColor + "66",
                  background: envColor + "14",
                }}
              >
                <Icon name="public" size={13} /> production
              </div>
              <label>
                Type <b>{word}</b> to confirm
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={word}
                  spellCheck={false}
                  autoFocus
                />
              </label>
            </div>
          ) : null}
        </div>
        <div className="modal-actions">
          <div style={{ flex: 1 }} />
          <Btn variant="text" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            variant="filled"
            icon={busy ? "hourglass_top" : "delete_forever"}
            className="obj-drop-confirm"
            disabled={!armed}
            onClick={() => armed && onConfirm()}
          >
            Drop {rows.length}
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}
