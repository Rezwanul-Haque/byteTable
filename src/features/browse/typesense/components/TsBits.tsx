// Small shared pieces of the Typesense workspace: the field-type tag, the
// boolean flag glyph, and the two empty states every admin-gated view needs.

import { Icon } from "../../../../shared/ui/Icon";
import { typeColor } from "../format";

/** A Typesense field type, tinted by family (prototype `TsTypeTag`). */
export function TsTypeTag({ type }: { type: string }) {
  return (
    <span className="ts-type" style={{ color: typeColor(type) }}>
      {type}
    </span>
  );
}

/** A schema boolean: a check when on, a dash when off (never an empty cell —
 *  "off" and "unknown" must not look alike). */
export function TsFlag({ on }: { on: boolean }) {
  return on ? (
    <Icon name="check" size={14} style={{ color: "var(--accent)" }} />
  ) : (
    <span className="ts-off">—</span>
  );
}

/**
 * The "admin key required" state (MILESTONE_30 Task 1). A search-only key gets a
 * 401 from `/collections`, `/keys` and the curation endpoints — that is the
 * *designed* outcome, not a failure, so these views explain the scope instead of
 * showing an error toast.
 */
export function TsAdminRequired({ what }: { what: string }) {
  return (
    <div className="ts-empty">
      <Icon name="key_off" size={26} style={{ color: "var(--text-faint)" }} />
      <p>An admin API key is required to view {what}.</p>
      <span className="ts-empty-hint">
        This workspace is connected with a search-only key. Typesense scopes keys by action and
        collection; reconnect with an admin key to use this view.
      </span>
    </div>
  );
}

/** A generic error state for a view whose load genuinely failed. */
export function TsError({ message }: { message: string }) {
  return (
    <div className="ts-empty">
      <Icon name="error" size={26} style={{ color: "var(--danger)" }} />
      <p>{message}</p>
    </div>
  );
}

/** A neutral "still loading" state, so a slow node doesn't render as empty. */
export function TsLoading({ what }: { what: string }) {
  return (
    <div className="ts-empty">
      <Icon name="hourglass_empty" size={24} style={{ color: "var(--text-faint)" }} />
      <span className="ts-empty-hint">Loading {what}…</span>
    </div>
  );
}
