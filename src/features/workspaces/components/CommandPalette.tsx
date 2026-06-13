// Command palette — ported from the prototype's workspace.jsx
// `CommandPalette` (spec §3.9). MINIMAL per the task acceptance ("palette can
// ship with table-jump only"): the floor is jumping to a table; we also
// include schema switches and "New SQL query" since they are trivial given
// the store actions already exist.
//
// Included categories: tables in the current schema (from the introspection
// cache, with "N rows" hints), schema switches (when >1 schema), New SQL
// query. OMITTED this milestone: structures (M7), saved queries (M6 store),
// schema map command, close workspace — these arrive with their features.
//
// a11y: role=listbox + role=option with aria-activedescendant; arrows
// navigate, Enter/click select, hover selects, Esc/outside close. Focus
// goes to the input on open and returns to the opener on close (caller's
// concern — the keyboard hook in WorkspaceShell toggles `open`).

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../../../shared/ui/Icon";
import { Kbd } from "../../../shared/ui/Kbd";
import { tablesKey, useIntrospectionStore } from "../../introspection/state";
import { selectQueriesForConnection, useSavedQueriesStore } from "../../saved_queries/state";
import { useWorkspacesStore } from "../state";
import type { Workspace } from "../types";
import "./CommandPalette.css";

interface Command {
  id: string;
  icon: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  workspace: Workspace;
  onClose: () => void;
}

export function CommandPalette({ workspace, onClose }: CommandPaletteProps) {
  const openTableTab = useWorkspacesStore((state) => state.openTableTab);
  const openSqlTab = useWorkspacesStore((state) => state.openSqlTab);
  const openSqlTabWith = useWorkspacesStore((state) => state.openSqlTabWith);
  const patchWorkspaceUi = useWorkspacesStore((state) => state.patchWorkspaceUi);
  const tablesMap = useIntrospectionStore((state) => state.tables);
  const savedQueries = useSavedQueriesStore((state) => state.savedQueries);
  const loadSaved = useSavedQueriesStore((state) => state.load);

  // Warm the global saved-query store so palette items appear even if the user
  // has not opened a SQL tab yet (guarded inside the store; cheap to re-call).
  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const { handleId } = workspace;
  const schemaName =
    (workspace.ui.schemaName !== undefined &&
    workspace.schemas.some((s) => s.name === workspace.ui.schemaName)
      ? workspace.ui.schemaName
      : workspace.schemas[0]?.name) ?? "main";

  const commands = useMemo<Command[]>(() => {
    const tables = tablesMap[tablesKey(handleId, schemaName)]?.tables ?? [];
    const tableCmds: Command[] = tables.map((t) => ({
      id: "open-" + t.name,
      icon: "table",
      label: t.name,
      hint: t.approxRowCount === null ? undefined : t.approxRowCount.toLocaleString() + " rows",
      run: () => openTableTab(schemaName, t.name),
    }));
    const schemaCmds: Command[] =
      workspace.schemas.length > 1
        ? workspace.schemas
            .filter((s) => s.name !== schemaName)
            .map((s) => ({
              id: "schema-" + s.name,
              icon: "schema",
              label: "Switch schema: " + s.name,
              hint: s.tableCount === null ? undefined : s.tableCount + " tables",
              run: () => patchWorkspaceUi(workspace.id, { schemaName: s.name }),
            }))
        : [];
    const newSql: Command = {
      id: "new-sql",
      icon: "terminal",
      label: "New SQL query",
      hint: "⌘T",
      run: openSqlTab,
    };
    // Saved queries visible from this workspace (global + this-workspace-
    // attached). Selecting one opens a fresh SQL tab seeded with its SQL.
    const savedCmds: Command[] = selectQueriesForConnection(savedQueries, workspace.saved.id).map(
      (q) => ({
        id: "saved-" + q.id,
        icon: "bookmark",
        label: q.name,
        hint: "saved query",
        run: () => openSqlTabWith(q.sql),
      }),
    );
    return [...tableCmds, ...schemaCmds, newSql, ...savedCmds];
  }, [
    tablesMap,
    handleId,
    schemaName,
    workspace.schemas,
    workspace.id,
    workspace.saved.id,
    savedQueries,
    openTableTab,
    openSqlTab,
    openSqlTabWith,
    patchWorkspaceUi,
  ]);

  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      commands.filter(
        (c) =>
          trimmed === "" ||
          c.label.toLowerCase().includes(trimmed) ||
          (c.hint ?? "").toLowerCase().includes(trimmed),
      ),
    [commands, trimmed],
  );

  const sel = Math.min(idx, Math.max(0, filtered.length - 1));

  // Focus the input on mount.
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  // Keep the selected item in view as arrows move it.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[data-idx='" + sel + "']")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      const cmd = filtered[sel];
      if (cmd) {
        event.preventDefault();
        cmd.run();
        onClose();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="modal-scrim palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Command palette" aria-modal="true">
        <div className="palette-input-row">
          <Icon name="search" size={18} style={{ color: "var(--text-faint)" }} />
          <input
            ref={inputRef}
            placeholder="Jump to a table or command…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIdx(0);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={filtered[sel] ? "palette-item-" + sel : undefined}
            aria-label="Search commands"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            filtered.map((c, i) => (
              <div
                key={c.id}
                id={"palette-item-" + i}
                data-idx={i}
                className={"palette-item" + (i === sel ? " active" : "")}
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setIdx(i)}
                onClick={() => {
                  c.run();
                  onClose();
                }}
              >
                <Icon
                  name={c.icon}
                  size={16}
                  style={{ color: i === sel ? "var(--accent)" : "var(--text-faint)" }}
                />
                <span className="palette-label">{c.label}</span>
                {c.hint ? <span className="palette-hint">{c.hint}</span> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
