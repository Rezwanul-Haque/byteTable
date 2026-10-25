// The matrix cell's state menu (M39 Phase 2).
//
// This replaced a click-through cycle. The cycle was wrong in a way worth
// recording: with `none → granted → grantable → …`, a single stray click on an
// already-granted cell moved it to `grantable` — i.e. added WITH GRANT OPTION,
// letting that account hand the privilege to others. On a permissions screen
// the easy accident must never be the one that WIDENS access.
//
// An explicit menu fixes that: every state is one click away, the current one
// is marked, and states the engine cannot write are absent rather than
// offered-then-rejected.
//
// Portaled to <body> on the shared `.tabmenu` chrome, so it matches the tab
// context menu rather than introducing a second popup style.

import { useEffect } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../../../shared/ui/Icon";
import { useT } from "../../../shared/i18n/useT";
import type { StringKey } from "../../../shared/i18n";
import type { GrantCapabilities, PrivilegeState } from "../api";
import { blockedReason, editableStates } from "../edit";
import { STATE_GLYPH } from "../glyphs";
import "../../../shared/ui/TabMenu.css";

/** The cell the menu was opened on. */
export interface CellMenuTarget {
  x: number;
  y: number;
  object: string;
  privilege: string;
  /** The cell's state in the database — what re-picking returns it to. */
  from: PrivilegeState;
  /** The state shown right now, which is `from` unless a change is staged. */
  current: PrivilegeState;
  /** Access comes from a wider grant, not one naming this object. */
  wildcard: boolean;
  /** A broader grant also confers this privilege, underneath this cell. */
  coveredByWider: boolean;
  /** The role chain this grant arrives through; empty when it is direct. */
  via: string[];
}

const BLOCK_REASON: Record<NonNullable<ReturnType<typeof blockedReason>>, StringKey> = {
  wildcardNarrow: "priv.blocked.wildcardNarrow",
  widerGrantRemains: "priv.blocked.widerGrantRemains",
  inherited: "priv.blocked.inherited",
};

const STATE_LABEL: Record<PrivilegeState, StringKey> = {
  none: "priv.set.none",
  granted: "priv.set.granted",
  grantable: "priv.set.grantable",
  denied: "priv.set.denied",
};

export function CellMenu({
  target,
  capabilities,
  onChoose,
  onClose,
}: {
  target: CellMenuTarget;
  capabilities: GrantCapabilities;
  onChoose: (target: CellMenuTarget, to: PrivilegeState) => void;
  onClose: () => void;
}) {
  const tr = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const states = editableStates(capabilities);
  // Clamp so the menu stays on screen; it grows a row per state plus a header.
  const left = Math.min(target.x, window.innerWidth - 240);
  const top = Math.min(target.y, window.innerHeight - (states.length * 34 + 56));

  return createPortal(
    <>
      <div className="tabmenu-overlay" onMouseDown={onClose} onContextMenu={onClose} />
      <div className="tabmenu priv-cellmenu" style={{ left, top }} role="menu">
        <div className="priv-cellmenu-head">
          {target.privilege} · {target.object}
        </div>
        {states.map((state) => {
          const blocked = blockedReason(
            {
              from: target.from,
              to: state,
              wildcard: target.wildcard,
              coveredByWider: target.coveredByWider,
              inherited: target.via.length > 0,
            },
            capabilities,
          );
          const isCurrent = state === target.current;
          return (
            <button
              type="button"
              key={state}
              className={"tabmenu-item priv-cellmenu-item" + (isCurrent ? " on" : "")}
              role="menuitem"
              disabled={!!blocked}
              // A blocked item keeps its place and explains itself rather than
              // vanishing — a missing option reads as a bug, not a rule.
              title={
                blocked === "inherited"
                  ? tr("priv.blocked.inherited", { role: target.via[0] ?? "" })
                  : blocked
                    ? tr(BLOCK_REASON[blocked])
                    : undefined
              }
              onClick={() => onChoose(target, state)}
            >
              <span className={"priv-cellmenu-glyph " + state}>{STATE_GLYPH[state]}</span>
              <span>{tr(STATE_LABEL[state])}</span>
              {isCurrent ? <Icon name="check" size={14} /> : null}
              {blocked ? <Icon name="block" size={14} /> : null}
            </button>
          );
        })}
        {target.wildcard ? (
          <div className="priv-cellmenu-note">{tr("priv.cellmenu.wildcard")}</div>
        ) : target.via.length ? (
          <div className="priv-cellmenu-note">
            {tr("priv.cellmenu.inherited", { chain: target.via.join(" → ") })}
          </div>
        ) : target.coveredByWider ? (
          <div className="priv-cellmenu-note">{tr("priv.cellmenu.coveredByWider")}</div>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
