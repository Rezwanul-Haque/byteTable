// Connect screen — ported from the prototype's connect.jsx ConnectScreen
// (spec §3.2), now wired to the real backend (M2): the card list is the
// saved-connection registry, clicking a card runs a real `connection_open`
// (the spinner shows actual latency, the prototype's simulated 650ms delay
// is gone), "Open SQLite file…" opens a native file dialog, and "New
// connection" opens the NewConnectionModal (conditionally mounted, so its
// form state resets on every open, per the prototype).

import { useEffect, useRef, useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { BrandMark } from "../../../shared/ui/BrandMark";
import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { EnvTag } from "../../../shared/ui/EnvTag";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useContextMenu } from "../../../shared/ui/useContextMenu";
import { useToast } from "../../../shared/ui/toastContext";
import { useT } from "../../../shared/i18n/useT";
import { tildify, useHomeDir } from "../../../shared/homeDir";
import {
  connectionDelete,
  connectionDetail,
  connectionListUnsupported,
  type SavedConnection,
  type UnsupportedConnection,
} from "../../connections/api";
import { NewConnectionModal } from "../../connections/components/NewConnectionModal";
import { pickSqliteFile } from "../../connections/dialog";
import { useConnectionsStore } from "../../connections/state";
import { OpenDataFileSheet } from "../../data_file/components/OpenDataFileSheet";
import { useOpenDataFile } from "../../data_file/open";
import { CompareSchemasModal } from "../../schema_diff/components/CompareSchemasModal";
import { useConnectAndOpen, useOpenSqliteFile } from "../connect";
// The "Open file" popover borrows `.schema-pop` from the sidebar (M35 Task 7),
// so its rules must be loaded even when no workspace has ever been opened.
import "./Sidebar.css";
import "./ConnectScreen.css";

// Sentinel for `connecting` while the file-open flow runs — saved-connection
// ids are UUIDs (or "" pre-save), so this can never collide with a card.
const FILE_OPEN_ID = "__open-sqlite-file__";

const OPENED_TOAST_SUFFIX = "” opened — right-click its tile to rename or recolor";

/** The pseudo-group holding connections with no project. */
const UNGROUPED = "Ungrouped";

/** How far the pointer must travel before a press becomes a drag rather than a
 *  click. Below this the card still opens its workspace as it always did. */
const DRAG_THRESHOLD_PX = 5;

/** A card being dragged onto another project's header. `over` is the group
 *  currently under the pointer (null when there is none, or when it is the
 *  card's own group — dropping there is a no-op). */
interface CardDrag {
  connection: SavedConnection;
  from: string;
  x: number;
  y: number;
  over: string | null;
}

export function ConnectScreen() {
  const t = useT();
  const home = useHomeDir();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  /** The compare-only Schema Diff modal (M28) — structure only, never applies. */
  const [showCompare, setShowCompare] = useState(false);
  // The saved connection being edited (its pencil clicked), or null. Opens the
  // same modal in edit mode.
  const [editConn, setEditConn] = useState<SavedConnection | null>(null);
  // Project grouping + filtering (prototype connect.jsx v2).
  const [filter, setFilter] = useState("");
  const [projFilter, setProjFilter] = useState<string>("all");
  const [projOpen, setProjOpen] = useState(false);
  // M35: the "Open file" popover, and the data-file sheet it opens. One
  // right-aligned button with a menu, not two text buttons — those overflowed
  // the panel and competed with "New connection".
  const [fileMenu, setFileMenu] = useState(false);
  const [dataFileOpen, setDataFileOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // Non-null only while a card is being dragged between project groups.
  const [drag, setDrag] = useState<CardDrag | null>(null);
  // Set when a drag actually started, so the click the browser fires on
  // pointerup does not also open the workspace. Read and cleared by the card's
  // onClick, which always runs immediately after.
  const draggedRef = useRef(false);
  // Mirrors `drag` for the pointer handlers. The commit on pointerup MUST read
  // the target from here rather than from inside a setState updater: React
  // StrictMode double-invokes updaters in development, so a side effect placed
  // there would move the connection twice.
  const dragRef = useRef<CardDrag | null>(null);
  const savedConnections = useConnectionsStore((state) => state.savedConnections);
  const saveConnection = useConnectionsStore((state) => state.save);
  const loaded = useConnectionsStore((state) => state.loaded);
  const loadError = useConnectionsStore((state) => state.loadError);
  const load = useConnectionsStore((state) => state.load);
  const removeConnection = useConnectionsStore((state) => state.remove);
  const duplicateConnection = useConnectionsStore((state) => state.duplicate);
  const connectAndOpen = useConnectAndOpen();
  const openSqliteFile = useOpenSqliteFile();
  const openDataFile = useOpenDataFile();
  const toast = useToast();

  // Registry entries this build can't use (unknown engine from another build):
  // shown struck-out below the real connections, openable only to a warning,
  // deletable. Kept in local state (not the connections store, which is typed to
  // known engines) and refreshed alongside the main list.
  const [unsupported, setUnsupported] = useState<UnsupportedConnection[]>([]);
  const refreshUnsupported = () => {
    void connectionListUnsupported()
      .then(setUnsupported)
      .catch(() => setUnsupported([]));
  };

  // Refresh the registry on every mount: cheap (local JSON read) and keeps
  // the list current after saves/deletes made while the screen was away.
  useEffect(() => {
    void load();
    refreshUnsupported();
  }, [load]);

  // Dismiss the "Open file" menu on any click outside it. The trigger stops
  // propagation, so its own click never reaches this.
  useEffect(() => {
    if (!fileMenu) return;
    const close = () => setFileMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [fileMenu]);

  // Delete an unsupported entry (its struck-out card's trash button). Goes
  // straight through the delete command (the store only tracks known engines),
  // then refreshes the struck-out list.
  const removeUnsupported = async (u: UnsupportedConnection) => {
    try {
      await connectionDelete(u.id);
    } catch (error) {
      toast(
        isAppErrorPayload(error) ? error.message : "Removing connections requires the desktop app",
        "err",
      );
      return;
    }
    refreshUnsupported();
    toast("Removed connection “" + u.name + "”", "ok");
  };

  // Remove a saved connection (the card's trash button) — drops the registry
  // entry + its keychain secrets via the store.
  const removeConn = async (conn: SavedConnection) => {
    try {
      await removeConnection(conn.id);
    } catch (error) {
      toast(
        isAppErrorPayload(error) ? error.message : "Removing connections requires the desktop app",
        "err",
      );
      return;
    }
    toast("Removed connection “" + conn.name + "”", "ok");
  };

  const connect = async (conn: SavedConnection) => {
    setConnecting(conn.id);
    // Failures are already toasted inside the connect flow (falsy = handled).
    const opened = await connectAndOpen(conn);
    if (opened) toast("Workspace “" + conn.name + OPENED_TOAST_SUFFIX, "ok");
    setConnecting(null);
  };

  const openFile = async () => {
    let path: string | null = null;
    try {
      path = await pickSqliteFile();
    } catch (error) {
      if (isAppErrorPayload(error)) {
        // The desktop shell is there but the dialog itself failed.
        toast(error.message, "err");
      } else {
        // Plain browser dev: the dialog plugin needs the Tauri shell.
        toast("Native file dialog requires the desktop app", "info");
      }
      return;
    }
    if (path === null) return; // user cancelled
    setConnecting(FILE_OPEN_ID);
    // Failures are already toasted inside the connect flow (falsy = handled).
    const name = await openSqliteFile(path);
    if (name) toast("Workspace “" + name + OPENED_TOAST_SUFFIX, "ok");
    setConnecting(null);
  };

  // Copy a connection into the same project. The backend does the work — name
  // ("Copy of …", numbered when taken), fresh id, and the keychain secrets
  // copied across so the duplicate connects without retyping the password.
  const duplicateConn = async (conn: SavedConnection) => {
    let copy: SavedConnection;
    try {
      copy = await duplicateConnection(conn.id);
    } catch (error) {
      toast(
        isAppErrorPayload(error)
          ? error.message
          : "Duplicating connections requires the desktop app",
        "err",
      );
      return;
    }
    toast("Created “" + copy.name + "”", "ok");
  };

  // Right-click menu on a connection card. Same actions as the hover icons,
  // plus Duplicate, which has no hover affordance of its own.
  const cardMenu = useContextMenu<SavedConnection>((c) => [
    { label: "Edit connection", icon: "edit", onSelect: () => setEditConn(c) },
    { label: "Duplicate", icon: "content_copy", onSelect: () => void duplicateConn(c) },
    { label: "Delete", icon: "delete", danger: true, onSelect: () => void removeConn(c) },
  ]);

  // ---- project grouping + filtering ------------------------------------
  const projectOf = (c: SavedConnection) => c.project || UNGROUPED;
  const allProjects = [...new Set(savedConnections.map(projectOf))];
  const q = filter.trim().toLowerCase();
  const matches = (c: SavedConnection) =>
    !q ||
    c.name.toLowerCase().includes(q) ||
    connectionDetail(c.params).toLowerCase().includes(q) ||
    c.env.toLowerCase().includes(q) ||
    c.engine.toLowerCase().includes(q) ||
    projectOf(c).toLowerCase().includes(q);
  const shown = savedConnections.filter(
    (c) => (projFilter === "all" || projectOf(c) === projFilter) && matches(c),
  );
  // Group by project; "Ungrouped" sinks to the end, the rest alphabetical.
  const groups: Record<string, SavedConnection[]> = {};
  for (const c of shown) (groups[projectOf(c)] ??= []).push(c);
  const groupKeys = Object.keys(groups).sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return a.localeCompare(b);
  });
  // Within a project: production → staging → dev.
  const ENV_ORDER: SavedConnection["env"][] = ["production", "staging", "dev"];
  for (const k of groupKeys) {
    groups[k]!.sort((a, b) => {
      const ia = ENV_ORDER.indexOf(a.env);
      const ib = ENV_ORDER.indexOf(b.env);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }
  // ---- drag a card into another project --------------------------------
  //
  // Pointer events, NOT the HTML5 drag-and-drop API: the repo already drags
  // this way (SchemaMap), and Tauri's window `dragDropEnabled` defaults to
  // true, so the webview intercepts OS-level drag/drop — a well-known way for
  // HTML5 DnD to misbehave inside a Tauri window. Pointer events sidestep it
  // and behave the same on all three platforms.
  const moveToProject = async (c: SavedConnection, target: string) => {
    // "Ungrouped" is the pseudo-group for "no project at all".
    const project = target === UNGROUPED ? undefined : target;
    try {
      // No secrets argument: the backend leaves the keychain untouched when
      // none are supplied, so re-saving to move a card cannot disturb the
      // stored password / SSH secret.
      await saveConnection({ ...c, project });
    } catch (error) {
      if (isAppErrorPayload(error)) toast(error.message, "err");
      else toast("Moving connections requires the desktop app", "info");
      return;
    }
    // Expand the destination so the card is visibly *there* — more convincing
    // than a toast alone, and it orients you after the list regroups.
    setOpenGroup(target);
    toast("Moved “" + c.name + "” to " + target, "ok");
  };

  /** Set both the rendered drag state and the ref the handlers read. */
  const setDragState = (next: CardDrag | null | ((d: CardDrag | null) => CardDrag | null)) => {
    const value = typeof next === "function" ? next(dragRef.current) : next;
    dragRef.current = value;
    setDrag(value);
  };

  const onCardPointerDown = (e: React.PointerEvent, c: SavedConnection) => {
    // Left button only, and never mid-connect (the cards are disabled then).
    if (e.button !== 0 || connecting !== null) return;
    // Clear any stale suppression: a drag cancelled with Escape and released
    // off-card leaves no trailing click to swallow, and the flag would
    // otherwise eat the next genuine click.
    draggedRef.current = false;
    const origin = { x: e.clientX, y: e.clientY };
    const from = projectOf(c);
    let started = false;
    const card = e.currentTarget as HTMLElement;

    const move = (ev: PointerEvent) => {
      if (!started) {
        // Below the threshold this is still a click, so click-to-connect keeps
        // working exactly as before.
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD_PX) return;
        started = true;
        draggedRef.current = true;
        card.setPointerCapture(ev.pointerId);
        setDragState({ connection: c, from, x: ev.clientX, y: ev.clientY, over: null });
        return;
      }
      // Pointer capture stops `pointerenter` firing on the headers, so the drop
      // target is hit-tested by hand on every move.
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const over = el?.closest<HTMLElement>("[data-proj-drop]")?.dataset.projDrop ?? null;
      setDragState((d) =>
        d ? { ...d, x: ev.clientX, y: ev.clientY, over: over === from ? null : over } : d,
      );
    };

    const finish = (ev: PointerEvent, commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey);
      if (!started) return;
      card.releasePointerCapture?.(ev.pointerId);
      // Read the target BEFORE clearing, and commit outside any state updater.
      const target = dragRef.current;
      setDragState(null);
      if (commit && target?.over) void moveToProject(target.connection, target.over);
    };
    const up = (ev: PointerEvent) => finish(ev, true);
    const cancel = (ev: PointerEvent) => finish(ev, false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !started) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey);
      setDragState(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey);
  };

  // Default-open the first group; while searching, every matching group opens.
  // While dragging, keep the source group open so the card does not vanish
  // from under the pointer when the accordion would otherwise switch.
  const effectiveOpen = q ? null : (drag?.from ?? openGroup ?? groupKeys[0]);
  // Show the filter once there's more than one connection to sift through.
  const showSearch = savedConnections.length > 1;
  const hasConnections = savedConnections.length > 0;

  return (
    // Frameless window: data-tauri-drag-region on the screen container makes
    // the empty chrome around the panel (including the top padding zone) a
    // window-drag area — Tauri only starts a drag when the mousedown target
    // itself carries the attribute, so the panel and its controls stay
    // interactive. Window controls (min/max/close buttons) are intentionally
    // NOT in the design; macOS keyboard close (⌘W / ⌘Q) works, and
    // cross-platform window controls are tracked for a later milestone.
    <div className="connect-screen" data-tauri-drag-region>
      <div className="connect-panel">
        <div className="connect-brand">
          <BrandMark size={28} blink />
          <div>
            <h1>
              Byte<span className="connect-brand-accent">Table</span>
            </h1>
            <p>{t("connect.tagline")}</p>
          </div>
        </div>

        <div className="connect-list-label">
          <span>{t("connect.openWorkspace")}</span>
          {hasConnections ? (
            <span className="connect-list-count">{savedConnections.length}</span>
          ) : null}
          <span style={{ flex: 1 }} />
          {allProjects.length > 1 ? (
            <div className="proj-filter">
              <button
                type="button"
                className="proj-filter-btn"
                onClick={() => setProjOpen((o) => !o)}
                onBlur={() => setTimeout(() => setProjOpen(false), 120)}
              >
                <Icon name="folder" size={13} />
                <span>{projFilter === "all" ? t("connect.allProjects") : projFilter}</span>
                <Icon name="expand_more" size={14} style={{ color: "var(--text-faint)" }} />
              </button>
              {projOpen ? (
                <div className="proj-pop">
                  <button
                    type="button"
                    className={"proj-pop-item" + (projFilter === "all" ? " on" : "")}
                    onClick={() => {
                      setProjFilter("all");
                      setProjOpen(false);
                    }}
                  >
                    {t("connect.allProjects")}{" "}
                    <span className="proj-pop-n">{savedConnections.length}</span>
                  </button>
                  {allProjects.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={"proj-pop-item" + (projFilter === p ? " on" : "")}
                      onClick={() => {
                        setProjFilter(p);
                        setProjOpen(false);
                      }}
                    >
                      {p}{" "}
                      <span className="proj-pop-n">
                        {savedConnections.filter((c) => projectOf(c) === p).length}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {showSearch ? (
          <div className="connect-search">
            <Icon name="search" size={15} style={{ color: "var(--text-faint)" }} />
            <input
              placeholder={t("connect.filter")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
            {filter ? (
              <IconBtn icon="close" size={13} title="Clear" onClick={() => setFilter("")} />
            ) : null}
          </div>
        ) : null}
        {loaded && loadError !== null ? (
          // §5-style inline error: the backend's human sentence, where the
          // list would have been.
          <div className="connect-load-error">{loadError}</div>
        ) : loaded && !hasConnections ? (
          <div className="connect-empty">
            No saved connections yet — open a SQLite file below to get started.
          </div>
        ) : (
          <div className="connect-list">
            {groupKeys.map((proj) => {
              const isOpen = q ? true : effectiveOpen === proj;
              return (
                <div className={"proj-acc" + (isOpen ? " open" : "")} key={proj}>
                  <button
                    type="button"
                    // Hit-tested by `document.elementFromPoint` during a drag —
                    // pointer capture stops pointerenter reaching the headers.
                    data-proj-drop={proj}
                    className={
                      "proj-acc-head" +
                      (drag && drag.from !== proj ? " droppable" : "") +
                      (drag?.over === proj ? " drop-over" : "")
                    }
                    onClick={() => setOpenGroup(isOpen && !q ? "__none__" : proj)}
                  >
                    <Icon
                      name={isOpen ? "expand_more" : "chevron_right"}
                      size={16}
                      style={{ color: "var(--text-faint)" }}
                    />
                    <Icon
                      name={proj === UNGROUPED ? "folder_off" : "folder"}
                      size={14}
                      style={{ color: isOpen ? "var(--accent)" : "var(--text-dim)" }}
                    />
                    <span className="proj-group-name">{proj}</span>
                    <span className="connect-group-n">{groups[proj]!.length}</span>
                  </button>
                  {isOpen ? (
                    <div className="proj-acc-body">
                      {groups[proj]!.map((c) => (
                        // Wrapper so the edit affordance is a sibling of the card
                        // button (a <button> can't nest another button).
                        <div
                          key={c.id}
                          className="connect-card-wrap"
                          onContextMenu={(e) => cardMenu.open(e, c)}
                        >
                          <button
                            type="button"
                            className={
                              "connect-card" + (drag?.connection.id === c.id ? " dragging" : "")
                            }
                            onPointerDown={(e) => onCardPointerDown(e, c)}
                            onClick={() => {
                              // A drag just ended — swallow its trailing click.
                              if (draggedRef.current) {
                                draggedRef.current = false;
                                return;
                              }
                              void connect(c);
                            }}
                            disabled={connecting !== null}
                          >
                            <EngineBadge engine={c.engine} size={34} />
                            <div className="connect-card-info">
                              <div className="connect-card-name">
                                {c.name}
                                <EnvTag env={c.env} />
                              </div>
                              <div className="connect-card-detail">
                                {c.params.engine === "sqlite"
                                  ? tildify(c.params.path, home)
                                  : connectionDetail(c.params)}
                              </div>
                            </div>
                            {connecting === c.id ? (
                              <span className="spinner" />
                            ) : (
                              <Icon name="arrow_forward" size={18} className="connect-arrow" />
                            )}
                          </button>
                          <div className="connect-card-actions">
                            <IconBtn
                              icon="edit"
                              size={15}
                              title="Edit connection"
                              disabled={connecting !== null}
                              onClick={() => setEditConn(c)}
                            />
                            <IconBtn
                              icon="delete"
                              size={15}
                              danger
                              title="Remove connection"
                              disabled={connecting !== null}
                              onClick={() => void removeConn(c)}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {hasConnections && shown.length === 0 ? (
              <div className="connect-empty">No connections match “{filter}”</div>
            ) : null}
            {unsupported.length > 0 ? (
              <div className="connect-unsupported">
                <div className="connect-unsupported-head">
                  <Icon name="warning" size={13} />
                  Unavailable in this version
                </div>
                {unsupported.map((u) => (
                  <div key={u.id} className="connect-card-wrap">
                    <button
                      type="button"
                      className="connect-card unsupported"
                      title={u.reason}
                      onClick={() => toast(u.reason, "info")}
                    >
                      <span className="unsupported-badge" title={u.engine}>
                        {u.engine.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="connect-card-info">
                        <div className="connect-card-name">
                          <span className="connect-card-name-struck">{u.name}</span>
                          <span className="unsupported-tag">{u.engine}</span>
                        </div>
                        <div className="connect-card-detail">
                          Unsupported engine — click for details
                        </div>
                      </div>
                      <Icon name="error" size={17} className="unsupported-icon" />
                    </button>
                    <div className="connect-card-actions">
                      <IconBtn
                        icon="delete"
                        size={15}
                        danger
                        title="Remove connection"
                        disabled={connecting !== null}
                        onClick={() => void removeUnsupported(u)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}

        <div className="connect-actions">
          <Btn
            icon="add"
            variant="tonal"
            disabled={connecting !== null}
            onClick={() => setShowNew(true)}
          >
            {t("connect.new")}
          </Btn>
          <Btn
            icon="difference"
            variant="text"
            disabled={connecting !== null}
            onClick={() => setShowCompare(true)}
          >
            {t("connect.compare")}
          </Btn>
          {/* Spinner + Open file are ONE slot, so the row keeps three evenly
              spaced controls while a file is opening. */}
          <div className="connect-actions-end">
            {connecting === FILE_OPEN_ID ? <span className="spinner" /> : null}
            {/* M35: an "Open file" button with a small menu.
              `stopPropagation` on the trigger, or the very click that opens the
              menu also reaches the outside-click handler and closes it again in
              the same tick. */}
            <div className="conn-openfile">
              <button
                type="button"
                className={"conn-openfile-btn" + (fileMenu ? " open" : "")}
                disabled={connecting !== null}
                title="Open a database or data file"
                onClick={(e) => {
                  e.stopPropagation();
                  setFileMenu((o) => !o);
                }}
              >
                <Icon name="drive_folder_upload" size={17} />
                <span>{t("connect.openFileMenu")}</span>
                <Icon name="expand_less" size={14} style={{ opacity: 0.6 }} />
              </button>
              {fileMenu ? (
                <div className="schema-pop conn-openfile-pop">
                  <button
                    type="button"
                    className="schema-pop-item"
                    onClick={() => {
                      setFileMenu(false);
                      void openFile();
                    }}
                  >
                    <Icon name="folder_open" size={14} style={{ color: "var(--text-faint)" }} />
                    <span className="conn-openfile-label">{t("connect.openFile")}</span>
                    <span className="conn-openfile-ext">.db .sqlite</span>
                  </button>
                  <button
                    type="button"
                    className="schema-pop-item"
                    onClick={() => {
                      setFileMenu(false);
                      setDataFileOpen(true);
                    }}
                  >
                    <Icon name="table_view" size={14} style={{ color: "var(--text-faint)" }} />
                    <span className="conn-openfile-label">{t("menu.file.openCsv")}</span>
                    <span className="conn-openfile-ext">.csv .tsv</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="connect-footnote">
        SQLite · MySQL · PostgreSQL · SQL Server · Redis · DynamoDB · MongoDB · Cassandra ·
        ClickHouse · Typesense — more engines coming. Your credentials never leave this machine.
      </div>

      {cardMenu.element}

      {/* The card following the cursor mid-drag. Fixed-positioned and
          pointer-events:none so it never becomes its own hit-test target. */}
      {drag ? (
        <div className="connect-drag-pill" style={{ left: drag.x, top: drag.y }}>
          <EngineBadge engine={drag.connection.engine} size={18} />
          <span className="connect-drag-name">{drag.connection.name}</span>
          <span className="connect-drag-to">
            {drag.over ? "→ " + drag.over : "drop on a project"}
          </span>
        </div>
      ) : null}

      {showCompare ? <CompareSchemasModal onClose={() => setShowCompare(false)} /> : null}

      {showNew || editConn ? (
        <NewConnectionModal
          edit={editConn ?? undefined}
          onClose={() => {
            setShowNew(false);
            setEditConn(null);
          }}
        />
      ) : null}

      {dataFileOpen ? (
        <OpenDataFileSheet
          onClose={() => setDataFileOpen(false)}
          onOpen={(file) => {
            setDataFileOpen(false);
            void openDataFile(file).then((name) => {
              if (name) toast("Opened “" + name + "” — editable, and queryable with SQL", "ok");
            });
          }}
        />
      ) : null}
    </div>
  );
}
