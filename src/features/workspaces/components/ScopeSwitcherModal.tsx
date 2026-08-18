// The scope list as a modal (M36) — the "icon" presentation of a sidebar's
// scope switcher, chosen in Settings › Behavior › Schema switcher.
//
// ONE component for three engines. A SQL schema, a Cassandra keyspace and a
// MongoDB database are the same control wearing different nouns (`scopeNoun`),
// so they get the same modal rather than three that drift apart. What each
// engine differs on is passed in: the row icon, whether scopes carry a table
// count, whether there is a create action, and whether the server has internal
// scopes worth grouping apart.
//
// It owns no data. Every action routes back to the sidebar that opened it —
// the one place that knows how to switch, create and refresh — so the modal and
// the popover it replaces can never disagree about what an action does.

import { useMemo, useState } from "react";

import { Btn } from "../../../shared/ui/Btn";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalTitle } from "../../../shared/ui/Modal";
import { ScopeSplitAction } from "./ScopeSplitAction";
import "./ScopeSwitcherModal.css";

/** One selectable scope. `count`/`system` are optional per engine. */
export interface ScopeItem {
  name: string;
  /** Tables/collections in it, when cheaply known. Omitted → no count shown. */
  count?: number | null;
  /** A server-internal scope: grouped apart, de-emphasised, opt-in. */
  system?: boolean;
}

/** The server's-own-scopes group, for engines that have one (SQL). */
export interface ScopeSystemGroup {
  show: boolean;
  onToggle: (next: boolean) => void;
  /** Explains what "system" means for this engine, on the checkbox's tooltip. */
  hint: string;
}

interface ScopeSwitcherModalProps {
  /**
   * What this engine calls a scope, lower-case and singular — "schema",
   * "keyspace", "database". Drives the title, the filter placeholder and the
   * empty state, so the modal never says "schema" to a Cassandra user.
   */
  noun: string;
  /** Row/title icon: the engine's own mark for a scope. */
  icon: string;
  items: ScopeItem[];
  /** The scope the sidebar is currently on. */
  current: string;
  /** Scopes already open as their own workspace (drives the split icon). */
  openedScopes: string[];
  /** Switch the sidebar to `scope`. The modal closes itself. */
  onSelect: (scope: string) => void;
  /** Open `scope` as its own workspace. The modal closes itself. */
  onOpenWorkspace: (scope: string) => void;
  /** Create action, when the engine offers one. Absent → no button. */
  onCreate?: () => void;
  /** System-scope group, when the engine has one. Absent → no group, no toggle. */
  system?: ScopeSystemGroup;
  onClose: () => void;
}

/** "schema" → "Schemas". Every noun this takes pluralises with a bare `s`. */
function title(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1) + "s";
}

export function ScopeSwitcherModal({
  noun,
  icon,
  items,
  current,
  openedScopes,
  onSelect,
  onOpenWorkspace,
  onCreate,
  system,
  onClose,
}: ScopeSwitcherModalProps) {
  const [q, setQ] = useState("");

  const { user, systemItems } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: ScopeItem) => !needle || s.name.toLowerCase().includes(needle);
    return {
      user: items.filter((s) => !s.system && match(s)),
      systemItems: items.filter((s) => s.system && match(s)),
    };
  }, [items, q]);

  const showSystem = system?.show ?? false;
  const total = user.length + (showSystem ? systemItems.length : 0);

  const row = (s: ScopeItem) => {
    const active = s.name === current;
    return (
      <button
        key={s.name}
        type="button"
        className={"ssm-row" + (active ? " active" : "") + (s.system ? " system" : "")}
        role="menuitemradio"
        aria-checked={active}
        onClick={() => {
          onSelect(s.name);
          onClose();
        }}
      >
        <Icon
          name={s.system ? "lock" : icon}
          size={15}
          style={{ color: active ? "var(--accent)" : "var(--text-faint)" }}
        />
        <span className="ssm-row-name">{s.name}</span>
        {s.count !== undefined ? (
          <span className="ssm-row-count">
            {s.count === null ? "—" : s.count + (s.count === 1 ? " table" : " tables")}
          </span>
        ) : null}
        {/* The tick sits BEFORE the split action, and keeps its slot when the
            row is not the active one — so the split icon is the last thing on
            every row and lines up in a straight column down the list. */}
        <span className="ssm-row-check">
          {active ? <Icon name="check" size={15} style={{ color: "var(--accent)" }} /> : null}
        </span>
        {/* The same split action the popover uses, so "open as its own
            workspace" means the same thing in both presentations. */}
        <ScopeSplitAction
          scope={s.name}
          opened={openedScopes.includes(s.name)}
          onOpen={(scope) => {
            onOpenWorkspace(scope);
            onClose();
          }}
        />
      </button>
    );
  };

  return (
    <Modal width={520} className="ssm-modal" label={"Switch " + noun} onClose={onClose}>
      <ModalTitle>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {/* Matches the sidebar button that opens this, so the modal visibly
              belongs to it. A SYSTEM row's icon is a lock instead, which marks
              a different thing: the server's own scope vs the user's. */}
          <Icon name={icon} size={17} style={{ color: "var(--accent)" }} /> {title(noun)}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {onCreate ? (
            <Btn
              className="ssm-create"
              icon="create_new_folder"
              variant="text"
              small
              onClick={() => {
                onClose();
                onCreate();
              }}
            >
              Create {noun}
            </Btn>
          ) : null}
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </span>
      </ModalTitle>

      <div className="ssm-search">
        <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
        <input
          autoFocus
          placeholder={"Filter " + noun + "s…"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
          aria-label={"Filter " + noun + "s"}
        />
        {q ? (
          <button type="button" className="ssm-search-clear" title="Clear" onClick={() => setQ("")}>
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </div>

      <div className="ssm-list" role="menu" aria-label={"Switch " + noun}>
        {user.map(row)}

        {/* The server's own scopes, opt-in and grouped after the user ones so
            the list never opens on `information_schema`. */}
        {system && showSystem && systemItems.length > 0 ? (
          <>
            <div className="ssm-group">System</div>
            {systemItems.map(row)}
          </>
        ) : null}

        {total === 0 ? (
          <div className="ssm-empty">
            {q ? "No " + noun + "s match “" + q + "”" : "This connection has no " + noun + "s."}
          </div>
        ) : null}
      </div>

      <div className="ssm-foot">
        {system ? (
          <button
            type="button"
            className="ssm-sys"
            role="checkbox"
            aria-checked={system.show}
            title={system.hint}
            onClick={() => system.onToggle(!system.show)}
          >
            <Icon name={system.show ? "check_box" : "check_box_outline_blank"} size={15} />
            <span>Show system {noun}s</span>
          </button>
        ) : (
          // Holds the left end so `space-between` still parks the hint at the
          // right when this engine has no system group (Cassandra, Mongo).
          <span />
        )}
        <span className="ssm-hint">
          <Icon name="open_in_new" size={13} /> open as its own workspace
        </span>
      </div>
    </Modal>
  );
}
