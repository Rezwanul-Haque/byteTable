// Query drawers — the two right-side sliding panels of the SQL surface:
// SAVED QUERIES (global store, browse / search / load / delete) and the
// per-tab QUERY HISTORY. Both were born inside SqlEditorTab; the saved-queries
// drawer moved out when its opener moved to the tab strip (TabBar), so it can
// be opened WITHOUT a query tab — it is hosted by WorkspaceContent, which
// decides where a loaded query lands (the active SQL tab, or a fresh one).
//
// The history drawer stays with the SQL tab (its data is that tab's runs), but
// shares this module because it shares the drawer's markup + styling.
//
// Both panels are absolutely positioned, so the host must be a positioning
// context — see QueryDrawers.css.

import { useEffect, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { type SavedQuery } from "../../saved_queries/api";
import { selectQueriesForConnection, useSavedQueriesStore } from "../../saved_queries/state";
import { previewHtml } from "../sqlPreview";
import type { SqlHistoryEntry } from "../types";
import "./QueryDrawers.css";

/** Esc closes an open drawer (matches the popovers these replaced). */
function useEscClose(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
}

// ---- saved-queries side drawer (browse / search / load / delete) ----------
// Searches saved queries by name OR SQL content, shows each with a full,
// multi-line, syntax-highlighted SQL preview, loads on click, and deletes via a
// hover trash icon. The per-row scope chip (global / this-workspace) preserves
// this app's workspace-attachment feature.
//
// Connected to the global saved-query store itself (rather than taking a list):
// its openers are spread across the tab strip and the query tab, and none of
// them should have to own the store wiring. The caller only says where a loaded
// query goes.
export function SavedQueriesDrawer({
  open,
  connectionId,
  onClose,
  onLoad,
}: {
  open: boolean;
  /** Saved connection of the host workspace — picks up its attached queries on
   *  top of the global ones. */
  connectionId: string;
  onClose: () => void;
  onLoad: (q: SavedQuery) => void;
}) {
  const toast = useToast();
  const savedQueries = useSavedQueriesStore((s) => s.savedQueries);
  const loadSaved = useSavedQueriesStore((s) => s.load);
  const removeQuery = useSavedQueriesStore((s) => s.remove);
  const [q, setQ] = useState("");
  useEscClose(open, onClose);

  // Load the global saved-query store once on first mount (guarded inside the
  // store: a settled load short-circuits, and re-calling is cheap).
  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const queries = selectQueriesForConnection(savedQueries, connectionId);
  const ql = q.trim().toLowerCase();
  const list = ql
    ? queries.filter((x) => x.name.toLowerCase().includes(ql) || x.sql.toLowerCase().includes(ql))
    : queries;

  return (
    <>
      <div className={"drawer-scrim" + (open ? " show" : "")} onClick={onClose} />
      <aside className={"sq-drawer" + (open ? " open" : "")} aria-hidden={!open}>
        <div className="sq-drawer-head">
          <span className="sq-drawer-title">
            <Icon name="bookmarks" size={16} style={{ color: "var(--accent)" }} /> Saved queries
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>
        <div className="sq-drawer-sub">Shared across all workspaces</div>
        <div className="sq-search">
          <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
          <input
            placeholder="Search name or SQL…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
          />
          {q ? <IconBtn icon="close" size={13} title="Clear" onClick={() => setQ("")} /> : null}
        </div>
        <div className="sq-list">
          {list.length === 0 ? (
            <div className="sq-empty">
              {queries.length === 0
                ? "Nothing saved yet — write a query and use the bookmark button."
                : `No saved queries match “${q}”.`}
            </div>
          ) : (
            list.map((item) => {
              const scoped = item.connectionId != null;
              return (
                <div key={item.id} className="sq-item" onClick={() => onLoad(item)}>
                  <div className="sq-item-head">
                    <Icon name="bookmark" size={14} style={{ color: "var(--accent)" }} />
                    <span className="sq-item-name">{item.name}</span>
                    <span className="saved-scope" title={scoped ? "This workspace" : "Global"}>
                      {scoped ? "this workspace" : "global"}
                    </span>
                    <button
                      type="button"
                      className="sq-item-del"
                      title="Delete"
                      aria-label={"Delete " + item.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeQuery(item.id).catch((err: unknown) =>
                          toast(appErrorMessage(err, "Could not delete query."), "err"),
                        );
                      }}
                    >
                      <Icon name="delete" size={14} />
                    </button>
                  </div>
                  <pre
                    className="sq-item-sql"
                    dangerouslySetInnerHTML={{ __html: previewHtml(item.sql) }}
                  />
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}

// ---- query-history side drawer (this tab) ---------------------------------
// Shows the recent runs for one SQL tab with a status indicator (accent check /
// red error), a result badge (row count or "failed"), and a full highlighted
// SQL preview. `onOpenSaved` adds a saved-queries opener above the list, so the
// query tab still reaches that drawer now the toolbar icon lives on the tab
// strip.
export function HistoryDrawer({
  open,
  history,
  onClose,
  onLoad,
  onOpenSaved,
}: {
  open: boolean;
  history: SqlHistoryEntry[];
  onClose: () => void;
  onLoad: (h: SqlHistoryEntry) => void;
  onOpenSaved?: () => void;
}) {
  useEscClose(open, onClose);

  return (
    <>
      <div className={"drawer-scrim" + (open ? " show" : "")} onClick={onClose} />
      <aside className={"sq-drawer" + (open ? " open" : "")} aria-hidden={!open}>
        <div className="sq-drawer-head">
          <span className="sq-drawer-title">
            <Icon name="history" size={16} style={{ color: "var(--accent)" }} /> Query history
          </span>
          <IconBtn icon="close" onClick={onClose} title="Close" />
        </div>
        <div className="sq-drawer-sub">Recent queries · this tab</div>
        {onOpenSaved ? (
          <button type="button" className="sq-drawer-link" onClick={onOpenSaved}>
            <Icon name="bookmarks" size={15} style={{ color: "var(--accent)" }} />
            <span>Saved queries</span>
            <Icon name="chevron_right" size={15} style={{ color: "var(--text-faint)" }} />
          </button>
        ) : null}
        <div className="sq-list">
          {history.length === 0 ? (
            <div className="sq-empty">Nothing yet — run a query and it shows up here.</div>
          ) : (
            history.map((h, i) => (
              <div key={i} className="sq-item" onClick={() => onLoad(h)}>
                <div className="sq-item-head">
                  <Icon
                    name={h.ok ? "check_circle" : "error"}
                    size={14}
                    style={{ color: h.ok ? "var(--accent)" : "#e06c75" }}
                  />
                  <span className="sq-item-name">
                    {h.ok
                      ? h.rowCount !== undefined
                        ? `${h.rowCount} row${h.rowCount === 1 ? "" : "s"}`
                        : "Query OK"
                      : "failed"}
                  </span>
                </div>
                <pre
                  className="sq-item-sql"
                  dangerouslySetInnerHTML={{ __html: previewHtml(h.sql) }}
                />
              </div>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
