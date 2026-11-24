// A query notebook tab (M47) — ported from the prototype's notebook.jsx
// (NotebookTab). Notes, queries and their results in one column, saved as one
// Markdown file.
//
// The document lives in the notebooks store (keyed by this tab's id), so it
// survives being switched away from; runs go through `runner`, file work
// through `files`. This component is the header, the banners, and the cells or
// the File view.

import { maskOn, maskShow, maskSql, useMask } from "../../masking/state";
import { Fragment, useEffect, useMemo } from "react";

import { normalizeEnv } from "../../../shared/types";
import { useT } from "../../../shared/i18n/useT";
import { Btn } from "../../../shared/ui/Btn";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { SegSwitch } from "../../../shared/ui/SegSwitch";
import { useBtCmd } from "../../../shared/ui/btCmd";
import { useToast } from "../../../shared/ui/toastContext";
import { appErrorMessage } from "../../../shared/api/error";
import { columnsKey, tablesKey, useIntrospectionStore } from "../../introspection/state";
import { libraryForEngine } from "../../snippets/builtins";
import { selectSnippetsForEngine, useSnippetsStore } from "../../snippets/state";
import { useWorkspacesStore } from "../../workspaces/state";
import type { EditorSchema } from "../../workspaces/sqlCompletion";
import type { Tab, Workspace } from "../../workspaces/types";
import { isDataFileWorkspace } from "../../workspaces/types";
import { baseName, checkDisk, keepMine, reloadFromDisk, saveNotebook } from "../files";
import {
  blank,
  fileOf,
  fromMarkdown,
  MAX_SAVED_ROWS,
  newQuery,
  toMarkdown,
  uid,
  type Cell,
  type QueryCell,
} from "../format";
import { confirmWrite, runAll, runOne, stopCell, stopRunAll, type RunContext } from "../runner";
import { counts, isDirty, markdownOf, newDoc, useNotebooksStore } from "../state";
import { NbAdd } from "./NbAdd";
import { NbNote } from "./NbNote";
import { NbQuery } from "./NbQuery";
import "./NotebookTab.css";

type NotebookTabT = Extract<Tab, { kind: "notebook" }>;

/** How often an open notebook looks at its file for outside changes (B3). */
const DISK_POLL_MS = 2000;

export function NotebookTab({ workspace, tab }: { workspace: Workspace; tab: NotebookTabT }) {
  const t = useT();
  const toast = useToast();
  const doc = useNotebooksStore((s) => s.docs[tab.id]);
  const patch = useNotebooksStore((s) => s.patch);
  const patchNb = useNotebooksStore((s) => s.patchNb);
  const patchCell = useNotebooksStore((s) => s.patchCell);
  const setTabTitle = useWorkspacesStore((s) => s.setNotebookTabTitle);
  const openSqlTabWith = useWorkspacesStore((s) => s.openSqlTabWith);

  // A tab with no document (it should not happen — notebook tabs are not
  // restored across launches) gets an empty notebook rather than a blank pane.
  useEffect(() => {
    if (!doc) {
      useNotebooksStore
        .getState()
        .open(newDoc(tab.id, workspace.id, blank(workspace.saved.name, tab.schema, tab.title)));
    }
  }, [doc, tab.id, tab.schema, tab.title, workspace.id, workspace.saved.name]);

  const ctx: RunContext = {
    handleId: workspace.handleId,
    schema: tab.schema,
    readOnly: workspace.readOnly,
    prod: normalizeEnv(workspace.saved.env) === "production",
    connectionId: isDataFileWorkspace(workspace) ? null : workspace.saved.id,
  };

  // Autocomplete: the schema's tables and whatever columns are cached (E4).
  const tablesCache = useIntrospectionStore((s) => s.tables);
  const columnsCache = useIntrospectionStore((s) => s.columns);
  const loadTables = useIntrospectionStore((s) => s.loadTables);
  useEffect(() => {
    void loadTables(workspace.handleId, tab.schema);
  }, [loadTables, workspace.handleId, tab.schema]);
  const tableEntries = tablesCache[tablesKey(workspace.handleId, tab.schema)]?.tables;
  const editorSchema = useMemo<EditorSchema>(
    () => ({
      tables: (tableEntries ?? []).map((tb) => ({
        name: tb.name,
        columns: (
          columnsCache[columnsKey(workspace.handleId, tab.schema, tb.name)]?.columns ?? []
        ).map((c) => ({ name: c.name, pk: c.pk })),
      })),
    }),
    [tableEntries, columnsCache, workspace.handleId, tab.schema],
  );

  // Snippets in the completion list, as in a SQL tab: the user's library plus
  // the built-in starters for this engine. `t` is a dependency because the
  // built-ins' names are localized.
  const engine = workspace.info.engine;
  const allSnippets = useSnippetsStore((s) => s.snippets);
  const loadSnippets = useSnippetsStore((s) => s.load);
  useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);
  const editorSnippets = useMemo(
    () => libraryForEngine(selectSnippetsForEngine(allSnippets, engine), engine),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSnippets, engine, t],
  );

  // B3: look at the file on mount, on focus, and every couple of seconds.
  useEffect(() => {
    if (!doc?.path) return;
    void checkDisk(tab.id);
    const timer = window.setInterval(() => void checkDisk(tab.id), DISK_POLL_MS);
    const onFocus = () => void checkDisk(tab.id);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [doc?.path, tab.id]);

  // A new cell takes focus once, on mount; then the flag is spent.
  const fresh = doc?.fresh ?? null;
  useEffect(() => {
    if (fresh) patch(tab.id, () => ({ fresh: null }));
  }, [fresh, patch, tab.id]);

  const md = useMemo(() => (doc ? markdownOf(doc) : ""), [doc]);
  // Masking (M49): while it is on, the File view shows a masked copy and is
  // read-only. Save and Copy still use the real file (`md` / the draft).
  const maskKey = useMask();
  const masking = maskOn();
  const maskedMd = useMemo(
    () =>
      doc && masking
        ? toMarkdown(doc.nb, {
            results: doc.keep,
            mask: { value: (v, col) => maskShow(v, col)?.text ?? v, sql: (s) => maskSql(s) },
          })
        : "",
    // eslint-disable-next-line react-hooks/exhaustive-deps -- maskKey: re-mask on a change
    [doc, masking, maskKey],
  );
  const dirty = doc ? isDirty(doc) : false;
  const locked = doc?.newerVersion != null;

  const save = async (as = false) => {
    if (!doc) return;
    if (locked) {
      toast(t("notebook.newer.cannotSave"), "info");
      return;
    }
    try {
      const out = await saveNotebook(tab.id, { as });
      const path = useNotebooksStore.getState().docs[tab.id]?.path;
      if (out === "saved" && path) toast(t("notebook.saved", { name: baseName(path) }), "ok");
    } catch (err) {
      toast(appErrorMessage(err, t("notebook.saveFailed")), "err");
    }
  };
  useBtCmd("notebook-save", () => void save(false));
  useBtCmd("notebook-save-as", () => void save(true));
  // ⌘S saves the file (J2). Only the active tab is mounted, so this is it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save(e.shiftKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!doc) return null;
  const { nb } = doc;
  const elsewhere = nb.connection && nb.connection !== workspace.saved.name;
  const fileName = doc.path ? baseName(doc.path) : fileOf(nb.title);
  const { queries, current } = counts(nb);

  const setTitle = (title: string) => {
    patchNb(tab.id, () => ({ title }));
    setTabTitle(tab.id, title.trim() || t("notebook.untitled"));
  };

  const addAt = (index: number, type: "query" | "note") => {
    const cell: Cell = type === "note" ? { id: uid(), type: "note", text: "" } : newQuery();
    patch(tab.id, (d) => {
      const cells = d.nb.cells.slice();
      cells.splice(index, 0, cell);
      return { nb: { ...d.nb, cells }, fresh: cell.id, undo: null };
    });
  };
  const move = (index: number, by: number) =>
    patch(tab.id, (d) => {
      const to = index + by;
      if (to < 0 || to >= d.nb.cells.length) return {};
      const cells = d.nb.cells.slice();
      const [c] = cells.splice(index, 1);
      cells.splice(to, 0, c!);
      return { nb: { ...d.nb, cells } };
    });
  const remove = (index: number) =>
    patch(tab.id, (d) => {
      const cell = d.nb.cells[index];
      if (!cell) return {};
      return {
        nb: { ...d.nb, cells: d.nb.cells.filter((_, i) => i !== index) },
        undo: { cell, index },
      };
    });
  const restore = () =>
    patch(tab.id, (d) => {
      if (!d.undo) return {};
      const cells = d.nb.cells.slice();
      cells.splice(Math.min(d.undo.index, cells.length), 0, d.undo.cell);
      return { nb: { ...d.nb, cells }, undo: null };
    });

  const doRunAll = async () => {
    if (doc.runAll) {
      stopRunAll(tab.id);
      return;
    }
    const out = await runAll(tab.id, ctx);
    if (out.kind === "nothing") toast(t("notebook.runAll.nothing"), "info");
    else if (out.kind === "failed")
      toast(t("notebook.runAll.failed", { ran: out.ran, total: out.total }), "err");
    else if (out.kind === "stopped")
      toast(t("notebook.runAll.stopped", { ran: out.ran, total: out.total }), "info");
    else
      toast(
        out.skipped
          ? t("notebook.runAll.doneSkipped", {
              queries: t("notebook.queries", { count: out.ran }),
              skipped: out.skipped,
            })
          : t("notebook.runAll.done", { queries: t("notebook.queries", { count: out.ran }) }),
        "ok",
      );
  };

  // Jupyter's keys (J2). A query runs first; then:
  //   ⇧↩  the next cell takes focus — a query's editor, or a note — and past
  //       the last cell a new query is added, so ⇧↩ ⇧↩ ⇧↩ walks the document;
  //   ⌥↩  a new query cell is inserted right below and takes focus.
  const focusCell = (cellId: string) => {
    const el = document.querySelector<HTMLElement>(`[data-cell-id="${cellId}"]`);
    const target = el?.querySelector<HTMLElement>(".cm-content, .nb-note-view");
    target?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  };
  const runIfQuery = (cellId: string) => {
    const cell = doc.nb.cells.find((c) => c.id === cellId);
    if (cell?.type === "query") void runOne(tab.id, cellId, ctx);
  };
  const goNext = (cellId: string) => {
    runIfQuery(cellId);
    const cells = doc.nb.cells;
    const next = cells[cells.findIndex((c) => c.id === cellId) + 1];
    if (next) focusCell(next.id);
    else if (!locked) addAt(cells.length, "query");
  };
  const insertBelow = (cellId: string) => {
    runIfQuery(cellId);
    if (locked) return;
    addAt(doc.nb.cells.findIndex((c) => c.id === cellId) + 1, "query");
  };

  const copyFile = () => {
    void navigator.clipboard.writeText(doc.draft ?? md).then(
      () => toast(t("notebook.file.copied"), "ok"),
      () => toast(t("notebook.file.copyFailed"), "err"),
    );
  };
  const applyDraft = () => {
    if (doc.draft == null) return;
    const next = fromMarkdown(doc.draft);
    patch(tab.id, (d) => ({ nb: next, keep: next.hadResults || d.keep, draft: null, undo: null }));
    setTabTitle(tab.id, next.title);
    toast(t("notebook.file.applied", { cells: next.cells.length }), "ok");
  };

  let qn = 0;
  const undoStrip = (
    <div className="nb-undo" role="status">
      {t("notebook.deleted")}{" "}
      <button type="button" onClick={restore}>
        {t("notebook.undo")}
      </button>
    </div>
  );

  return (
    <div className="nb">
      <div className="nb-head">
        <Icon name="menu_book" size={18} style={{ color: "var(--accent)" }} />
        <input
          className="nb-title"
          value={nb.title}
          aria-label={t("notebook.titleAria")}
          placeholder={t("notebook.untitled")}
          readOnly={locked}
          onChange={(e) => setTitle(e.target.value)}
        />
        <span className="nb-file" title={doc.path ?? t("notebook.notSavedYet")}>
          {/* Just the file name — a full path is long and noisy here; it is
              in the tooltip. Before the first save, the name it will suggest. */}
          {fileName}
        </span>
        <span className={"nb-saved" + (dirty ? " dirty" : "")}>
          {dirty ? t("notebook.unsaved") : t("notebook.savedState")}
        </span>
        <div style={{ flex: 1 }} />
        <SegSwitch
          ariaLabel={t("notebook.view.aria")}
          value={doc.mode}
          onChange={(mode) => patch(tab.id, () => ({ mode }))}
          options={[
            { value: "cells", label: t("notebook.view.notebook"), icon: "article" },
            {
              value: "file",
              label: t("notebook.view.file"),
              icon: "code",
              title: t("notebook.view.fileTitle"),
            },
          ]}
        />
        <Btn
          small
          variant="tonal"
          icon={doc.runAll ? "stop" : "playlist_play"}
          onClick={() => void doRunAll()}
          disabled={!queries}
          title={doc.runAll ? t("notebook.runAll.stopTitle") : t("notebook.runAll.title")}
          aria-label={doc.runAll ? t("notebook.runAll.stopAria") : undefined}
        >
          {doc.runAll
            ? t("notebook.runAll.running", { done: doc.runAll.done, total: doc.runAll.total })
            : t("notebook.runAll.label")}
        </Btn>
        <Btn
          small
          variant={dirty && !locked ? "filled" : "tonal"}
          icon="save"
          onClick={() => void save(false)}
          disabled={!dirty || locked}
          title={t("notebook.saveTitle")}
        >
          {t("common.save")}
        </Btn>
      </div>

      <div className="nb-sub">
        <Icon name="dns" size={13} />
        <span>
          {t("notebook.runsOn.pre")} <b>{workspace.saved.name}</b> · {tab.schema}
        </span>
        <span className="dim">{t("notebook.runsOn.secret")}</span>
        <div style={{ flex: 1 }} />
        <label className="nb-keep" title={t("notebook.keep.title")}>
          <Checkbox
            checked={doc.keep}
            disabled={locked}
            onChange={(e) => patch(tab.id, () => ({ keep: e.target.checked }))}
          />
          <span>{t("notebook.keep.label")}</span>
        </label>
      </div>

      {locked ? (
        <div className="nb-banner" role="status">
          <Icon name="lock" size={16} />
          <span>{t("notebook.newer.banner", { version: doc.newerVersion ?? 0 })}</span>
        </div>
      ) : null}

      {doc.diskChanged != null ? (
        <div className="nb-banner" role="alert">
          <Icon name="sync_problem" size={16} />
          <span>{t("notebook.disk.changed", { name: fileName })}</span>
          <Btn small variant="text" onClick={() => keepMine(tab.id)}>
            {t("notebook.disk.keepMine")}
          </Btn>
          <Btn small variant="tonal" onClick={() => reloadFromDisk(tab.id)}>
            {t("notebook.disk.reload")}
          </Btn>
        </div>
      ) : null}

      {elsewhere ? (
        <div className="nb-banner" role="status">
          <Icon name="swap_horiz" size={16} />
          <span>
            {t("notebook.elsewhere.pre")} <b>{nb.connection}</b>
            {t("notebook.elsewhere.mid")} <b>{workspace.saved.name}</b>
            {t("notebook.elsewhere.post")}
          </span>
          {locked ? null : (
            <Btn
              small
              variant="text"
              onClick={() =>
                patchNb(tab.id, () => ({ connection: workspace.saved.name, schema: tab.schema }))
              }
            >
              {t("notebook.elsewhere.use", { name: workspace.saved.name })}
            </Btn>
          )}
        </div>
      ) : null}

      {doc.mode === "file" ? (
        <div className="nb-filepane">
          <div className="nb-file-bar">
            <Icon name="description" size={15} />
            <span className="nb-file-name">{fileName}</span>
            <span className="dim">
              {t("notebook.file.lines", { count: (doc.draft ?? md).split("\n").length })}
            </span>
            <div style={{ flex: 1 }} />
            {doc.draft != null && doc.draft !== md ? (
              <>
                <span className="nb-saved dirty">{t("notebook.file.edited")}</span>
                <Btn small variant="text" onClick={() => patch(tab.id, () => ({ draft: null }))}>
                  {t("notebook.file.discard")}
                </Btn>
                <Btn small variant="filled" icon="sync" onClick={applyDraft} disabled={locked}>
                  {t("notebook.file.apply")}
                </Btn>
              </>
            ) : null}
            <Btn small variant="tonal" icon="content_copy" onClick={copyFile}>
              {t("notebook.file.copy")}
            </Btn>
          </div>
          {masking ? (
            <div className="nb-file-masked" role="status">
              <Icon name="visibility_off" size={15} /> {t("mask.nbFile")}
            </div>
          ) : null}
          <div className="nb-file-legend">
            <span>
              <i className="k-note" /> {t("notebook.file.legendNotes")}
            </span>
            <span>
              <i className="k-sql" /> {t("notebook.file.legendSqlPre")} <code>```sql</code>{" "}
              {t("notebook.file.legendSqlPost")}
            </span>
            <span>
              <i className="k-res" />{" "}
              {doc.keep
                ? t("notebook.file.legendResults", { n: MAX_SAVED_ROWS })
                : t("notebook.file.legendNoResults")}
            </span>
          </div>
          <textarea
            className="nb-file-text"
            spellCheck={false}
            readOnly={locked || masking}
            aria-label={t("notebook.file.aria", { name: fileName })}
            value={masking ? maskedMd : (doc.draft ?? md)}
            onChange={(e) => patch(tab.id, () => ({ draft: e.target.value }))}
          />
        </div>
      ) : (
        <div className="nb-scroll">
          <div className="nb-doc">
            {nb.cells.map((c, i) => {
              const n = c.type === "query" ? ++qn : 0;
              const fresh = doc.fresh === c.id;
              return (
                <Fragment key={c.id}>
                  {doc.undo && doc.undo.index === i ? undoStrip : null}
                  {locked ? null : <NbAdd onAdd={(type) => addAt(i, type)} />}
                  <section
                    className={"nb-cell " + (c.type === "note" ? "is-note" : "is-query")}
                    aria-label={
                      c.type === "note" ? t("notebook.cell.note") : t("notebook.cell.query", { n })
                    }
                    data-cell-id={c.id}
                  >
                    {c.type === "note" ? (
                      <NbNote
                        text={c.text}
                        autoEdit={fresh}
                        readOnly={locked}
                        onChange={(text) => patchCell(tab.id, c.id, { text })}
                        onNext={() => goNext(c.id)}
                        onInsertBelow={() => insertBelow(c.id)}
                      />
                    ) : (
                      <NbQuery
                        cell={c}
                        n={n}
                        engine={workspace.info.engine}
                        schema={editorSchema}
                        snippets={editorSnippets}
                        readOnly={locked}
                        autoFocus={fresh}
                        onChange={(p: Partial<QueryCell>) => patchCell(tab.id, c.id, p)}
                        onRun={() => void runOne(tab.id, c.id, ctx)}
                        onRunNext={() => goNext(c.id)}
                        onRunInsert={() => insertBelow(c.id)}
                        onStop={() => stopCell(tab.id, c.id)}
                        onConfirm={() => void confirmWrite(tab.id, c.id, ctx)}
                        onOpenSql={() => openSqlTabWith(c.sql)}
                      />
                    )}
                    {locked ? null : (
                      <div className="nb-tools">
                        <IconBtn
                          icon="arrow_upward"
                          size={14}
                          title={t("notebook.tools.up")}
                          aria-label={t("notebook.tools.up")}
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                        />
                        <IconBtn
                          icon="arrow_downward"
                          size={14}
                          title={t("notebook.tools.down")}
                          aria-label={t("notebook.tools.down")}
                          disabled={i === nb.cells.length - 1}
                          onClick={() => move(i, 1)}
                        />
                        {c.type === "query" ? (
                          <IconBtn
                            icon="open_in_new"
                            size={14}
                            title={t("notebook.tools.openSql")}
                            aria-label={t("notebook.tools.openSql")}
                            onClick={() => openSqlTabWith(c.sql)}
                          />
                        ) : null}
                        <IconBtn
                          icon="delete"
                          size={14}
                          danger
                          title={t("notebook.tools.delete")}
                          aria-label={t("notebook.tools.delete")}
                          onClick={() => remove(i)}
                        />
                      </div>
                    )}
                  </section>
                </Fragment>
              );
            })}
            {doc.undo && doc.undo.index >= nb.cells.length ? undoStrip : null}
            {locked ? null : <NbAdd always onAdd={(type) => addAt(nb.cells.length, type)} />}
            <div className="nb-foot">
              {t("notebook.foot", {
                queries: t("notebook.queries", { count: queries }),
                current,
              })}{" "}
              · {doc.keep ? t("notebook.foot.kept") : t("notebook.foot.notKept")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
