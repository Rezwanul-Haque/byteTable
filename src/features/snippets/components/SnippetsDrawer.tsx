// Snippet library drawer — browse / search / insert / create / edit / delete
// the user's reusable SQL fragments.
//
// Shares the right-side drawer markup and styling with the saved-queries and
// history drawers (`.sq-*`, defined in workspaces/components/QueryDrawers.css),
// because it is the same affordance in the same slot: a list that slides over
// the tab body from the tab strip. Its own CSS covers only the editor form,
// which those drawers have no equivalent of.
//
// Connected to the global snippet store itself (rather than taking a list), so
// no opener has to own the store wiring. The caller only says what "insert"
// means — WorkspaceContent routes it to the active SQL tab's editor.

import { useEffect, useMemo, useState } from "react";

import { appErrorMessage } from "../../../shared/api/error";
import { useT } from "../../../shared/i18n/useT";
import type { Engine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { ENGINE_META } from "../../../shared/ui/engineMeta";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Select, type SelectOption } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import { previewHtml } from "../../workspaces/sqlPreview";
import type { Snippet } from "../api";
import { isBuiltinSnippet, libraryForEngine } from "../builtins";
import { selectSnippetsForEngine, useSnippetsStore } from "../state";
import "./SnippetsDrawer.css";

/**
 * Engines a snippet can be restricted to: the ones with a SQL editor to insert
 * it into. The NoSQL engines (Redis, DynamoDB, MongoDB, Typesense) have their
 * own query shells rather than the SQL tab, so offering them here would promise
 * something that cannot happen.
 */
const SNIPPET_ENGINES: Engine[] = [
  "postgres",
  "mysql",
  "sqlite",
  "mssql",
  "clickhouse",
  "cassandra",
];

/** The form's working copy of a snippet. `id` empty = creating a new one. */
interface Draft {
  id: string;
  name: string;
  abbreviation: string;
  body: string;
  /** "" = all engines. */
  engine: string;
  savedAt: number;
}

const EMPTY_DRAFT: Draft = { id: "", name: "", abbreviation: "", body: "", engine: "", savedAt: 0 };

function draftOf(snippet: Snippet): Draft {
  return {
    id: snippet.id,
    name: snippet.name,
    abbreviation: snippet.abbreviation ?? "",
    body: snippet.body,
    engine: snippet.engine ?? "",
    savedAt: snippet.savedAt,
  };
}

export function SnippetsDrawer({
  open,
  engine,
  onClose,
  onInsert,
}: {
  open: boolean;
  /** Engine of the host workspace — picks up its restricted snippets on top of
   *  the unrestricted ones. */
  engine: Engine;
  onClose: () => void;
  /** Insert a snippet's body at the cursor. */
  onInsert: (snippet: Snippet) => void;
}) {
  const t = useT();
  const toast = useToast();
  const snippets = useSnippetsStore((s) => s.snippets);
  const loadError = useSnippetsStore((s) => s.loadError);
  const loadSnippets = useSnippetsStore((s) => s.load);
  const saveSnippet = useSnippetsStore((s) => s.save);
  const removeSnippet = useSnippetsStore((s) => s.remove);
  const [q, setQ] = useState("");
  // The editor form, or null while browsing. A draft with an empty id is a new
  // snippet; otherwise it is editing that entry in place.
  const [draft, setDraft] = useState<Draft | null>(null);

  // Load the global library once on first mount (guarded inside the store: a
  // settled load short-circuits, so re-calling is cheap).
  useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);

  // Esc closes the form first, then the drawer — so backing out of an edit does
  // not also dismiss the list behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (draft) setDraft(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, draft, onClose]);

  // The user's snippets for this engine, then the built-in starters. Both are
  // searched the same way; `t` is a dependency because a built-in's NAME is
  // localized, so a language switch has to re-derive them.
  const library = useMemo(
    () => libraryForEngine(selectSnippetsForEngine(snippets, engine), engine),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snippets, engine, t],
  );
  const ql = q.trim().toLowerCase();
  const list = ql
    ? library.filter(
        (s) =>
          s.name.toLowerCase().includes(ql) ||
          (s.abbreviation ?? "").toLowerCase().includes(ql) ||
          s.body.toLowerCase().includes(ql),
      )
    : library;

  const mine = list.filter((s) => !isBuiltinSnippet(s));
  const starters = list.filter(isBuiltinSnippet);
  const bothSections = mine.length > 0 && starters.length > 0;
  const sections = [
    { titleKey: "ws.snip.yours" as const, items: mine },
    { titleKey: "ws.snip.starters" as const, items: starters },
  ];

  const engineOptions: SelectOption[] = [
    { value: "", label: t("ws.snip.engineAll") },
    ...SNIPPET_ENGINES.map((e) => ({ value: e, label: ENGINE_META[e].label })),
  ];

  const commit = () => {
    if (!draft) return;
    void saveSnippet({
      id: draft.id === "" ? undefined : draft.id,
      savedAt: draft.id === "" ? undefined : draft.savedAt,
      name: draft.name,
      abbreviation: draft.abbreviation,
      body: draft.body,
      engine: draft.engine === "" ? null : (draft.engine as Engine),
    })
      .then((stored) => {
        setDraft(null);
        toast(t("ws.snip.saved", { name: stored.name }), "ok");
      })
      .catch((err: unknown) => toast(appErrorMessage(err, t("ws.snip.saveFail")), "err"));
  };

  return (
    <>
      <div className={"drawer-scrim" + (open ? " show" : "")} onClick={onClose} />
      <aside className={"sq-drawer" + (open ? " open" : "")} aria-hidden={!open}>
        <div className="sq-drawer-head">
          <span className="sq-drawer-title">
            <Icon name="bolt" size={16} style={{ color: "var(--accent)" }} /> {t("ws.snip.manage")}
          </span>
          <IconBtn icon="close" onClick={onClose} title={t("common.close")} />
        </div>
        <div className="sq-drawer-sub">{t("ws.snip.sub")}</div>

        {draft ? (
          <div className="snip-form">
            <label className="snip-field">
              <span className="snip-label">{t("ws.snip.name")}</span>
              <input
                className="snip-input"
                value={draft.name}
                placeholder={t("ws.snip.namePlaceholder")}
                autoFocus
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="snip-field">
              <span className="snip-label">{t("ws.snip.abbr")}</span>
              <input
                className="snip-input"
                value={draft.abbreviation}
                placeholder={t("ws.snip.abbrPlaceholder")}
                title={t("ws.snip.abbrHint")}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, abbreviation: e.target.value })}
              />
              <span className="snip-hint">{t("ws.snip.abbrHint")}</span>
            </label>
            <label className="snip-field">
              <span className="snip-label">{t("ws.snip.body")}</span>
              <textarea
                className="snip-input snip-body"
                value={draft.body}
                placeholder={t("ws.snip.bodyPlaceholder")}
                rows={7}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
              <span className="snip-hint">{t("ws.snip.bodyHint")}</span>
            </label>
            <div className="snip-field">
              <span className="snip-label">{t("ws.snip.engine")}</span>
              <Select
                value={draft.engine}
                options={engineOptions}
                onChange={(v) => setDraft({ ...draft, engine: v })}
                aria-label={t("ws.snip.engine")}
                className="snip-select"
                mono={false}
              />
              <span className="snip-hint">{t("ws.snip.engineHint")}</span>
            </div>
            <div className="snip-form-actions">
              <Btn variant="text" small onClick={() => setDraft(null)}>
                {t("common.cancel")}
              </Btn>
              <Btn
                variant="filled"
                small
                onClick={commit}
                disabled={draft.name.trim() === "" || draft.body.trim() === ""}
              >
                {t("common.save")}
              </Btn>
            </div>
          </div>
        ) : (
          <>
            <div className="sq-search">
              <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
              <input
                placeholder={t("ws.snip.search")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                spellCheck={false}
              />
              {q ? (
                <IconBtn
                  icon="close"
                  size={13}
                  title={t("ws.sql.clear")}
                  onClick={() => setQ("")}
                />
              ) : null}
            </div>
            {/* The drawers' shared nav-row look (`.sq-drawer-link`, in
                QueryDrawers.css) — identical to the history drawer's "Saved
                queries" link. Same slot, same affordance, so it reads the same. */}
            <button
              type="button"
              className="sq-drawer-link"
              onClick={() => setDraft({ ...EMPTY_DRAFT })}
            >
              <Icon name="add" size={15} style={{ color: "var(--accent)" }} />
              <span>{t("ws.snip.new")}</span>
              <Icon name="chevron_right" size={15} style={{ color: "var(--text-faint)" }} />
            </button>
            <div className="sq-list">
              {loadError ? (
                <div className="sq-empty">{loadError}</div>
              ) : list.length === 0 ? (
                <div className="sq-empty">
                  {library.length === 0 ? t("ws.snip.empty") : t("ws.snip.noMatch", { query: q })}
                </div>
              ) : (
                sections.map(({ titleKey, items }) =>
                  items.length === 0 ? null : (
                    <div key={titleKey} className="snip-section">
                      {/* Headed only when both groups are on screen: with just
                          one, a single header labels nothing. */}
                      {bothSections ? <div className="snip-group">{t(titleKey)}</div> : null}
                      {items.map((item) => {
                        const builtin = isBuiltinSnippet(item);
                        return (
                          <div
                            key={item.id}
                            className="sq-item"
                            onClick={() => onInsert(item)}
                            title={t("ws.snip.insert")}
                          >
                            <div className="sq-item-head">
                              <Icon name="bolt" size={14} style={{ color: "var(--accent)" }} />
                              <span className="sq-item-name">{item.name}</span>
                              {item.abbreviation ? (
                                <span className="snip-abbr">{item.abbreviation}</span>
                              ) : null}
                              {/* A built-in says so instead of showing its
                                  engine: it is ALWAYS this engine's, so the
                                  engine chip would be noise on every row. */}
                              {builtin ? (
                                <span className="saved-scope" title={t("ws.snip.builtinTitle")}>
                                  {t("ws.snip.builtin")}
                                </span>
                              ) : item.engine ? (
                                <span
                                  className="saved-scope"
                                  title={ENGINE_META[item.engine].label}
                                >
                                  {ENGINE_META[item.engine].label}
                                </span>
                              ) : null}
                              {/* Built-ins are not the user's rows to edit or
                                  lose — writing your own is one click away. */}
                              {builtin ? null : (
                                <>
                                  <button
                                    type="button"
                                    className="sq-item-del"
                                    title={t("ws.snip.edit")}
                                    aria-label={t("ws.snip.edit")}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDraft(draftOf(item));
                                    }}
                                  >
                                    <Icon name="edit" size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    className="sq-item-del"
                                    title={t("common.delete")}
                                    aria-label={t("ws.snip.deleteAria", { name: item.name })}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void removeSnippet(item.id).catch((err: unknown) =>
                                        toast(appErrorMessage(err, t("ws.snip.deleteFail")), "err"),
                                      );
                                    }}
                                  >
                                    <Icon name="delete" size={14} />
                                  </button>
                                </>
                              )}
                            </div>
                            <pre
                              className="sq-item-sql"
                              dangerouslySetInnerHTML={{ __html: previewHtml(item.body) }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ),
                )
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
