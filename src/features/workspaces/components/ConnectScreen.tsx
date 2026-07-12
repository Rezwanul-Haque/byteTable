// Connect screen — ported from the prototype's connect.jsx ConnectScreen
// (spec §3.2), now wired to the real backend (M2): the card list is the
// saved-connection registry, clicking a card runs a real `connection_open`
// (the spinner shows actual latency, the prototype's simulated 650ms delay
// is gone), "Open SQLite file…" opens a native file dialog, and "New
// connection" opens the NewConnectionModal (conditionally mounted, so its
// form state resets on every open, per the prototype).

import { useEffect, useState } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { BrandMark } from "../../../shared/ui/BrandMark";
import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { EnvTag } from "../../../shared/ui/EnvTag";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { useToast } from "../../../shared/ui/toastContext";
import { tildify, useHomeDir } from "../../../shared/homeDir";
import { connectionDetail, type SavedConnection } from "../../connections/api";
import { NewConnectionModal } from "../../connections/components/NewConnectionModal";
import { pickSqliteFile } from "../../connections/dialog";
import { useConnectionsStore } from "../../connections/state";
import { useConnectAndOpen, useOpenSqliteFile } from "../connect";
import "./ConnectScreen.css";

// Sentinel for `connecting` while the file-open flow runs — saved-connection
// ids are UUIDs (or "" pre-save), so this can never collide with a card.
const FILE_OPEN_ID = "__open-sqlite-file__";

const OPENED_TOAST_SUFFIX = "” opened — right-click its tile to rename or recolor";

export function ConnectScreen() {
  const home = useHomeDir();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  // The saved connection being edited (its pencil clicked), or null. Opens the
  // same modal in edit mode.
  const [editConn, setEditConn] = useState<SavedConnection | null>(null);
  // Project grouping + filtering (prototype connect.jsx v2).
  const [filter, setFilter] = useState("");
  const [projFilter, setProjFilter] = useState<string>("all");
  const [projOpen, setProjOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const savedConnections = useConnectionsStore((state) => state.savedConnections);
  const loaded = useConnectionsStore((state) => state.loaded);
  const loadError = useConnectionsStore((state) => state.loadError);
  const load = useConnectionsStore((state) => state.load);
  const removeConnection = useConnectionsStore((state) => state.remove);
  const connectAndOpen = useConnectAndOpen();
  const openSqliteFile = useOpenSqliteFile();
  const toast = useToast();

  // Refresh the registry on every mount: cheap (local JSON read) and keeps
  // the list current after saves/deletes made while the screen was away.
  useEffect(() => {
    void load();
  }, [load]);

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

  // ---- project grouping + filtering ------------------------------------
  const projectOf = (c: SavedConnection) => c.project || "Ungrouped";
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
    if (a === "Ungrouped") return 1;
    if (b === "Ungrouped") return -1;
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
  // Default-open the first group; while searching, every matching group opens.
  const effectiveOpen = q ? null : (openGroup ?? groupKeys[0]);
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
            <p>Local-first database client · free forever</p>
          </div>
        </div>

        <div className="connect-list-label">
          <span>Open a workspace</span>
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
                <span>{projFilter === "all" ? "All projects" : projFilter}</span>
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
                    All projects <span className="proj-pop-n">{savedConnections.length}</span>
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
              placeholder="Filter connections…"
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
                    className="proj-acc-head"
                    onClick={() => setOpenGroup(isOpen && !q ? "__none__" : proj)}
                  >
                    <Icon
                      name={isOpen ? "expand_more" : "chevron_right"}
                      size={16}
                      style={{ color: "var(--text-faint)" }}
                    />
                    <Icon
                      name={proj === "Ungrouped" ? "folder_off" : "folder"}
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
                        <div key={c.id} className="connect-card-wrap">
                          <button
                            type="button"
                            className="connect-card"
                            onClick={() => void connect(c)}
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
          </div>
        )}

        <div className="connect-actions">
          <Btn
            icon="add"
            variant="tonal"
            disabled={connecting !== null}
            onClick={() => setShowNew(true)}
          >
            New connection
          </Btn>
          <Btn
            icon="folder_open"
            variant="text"
            disabled={connecting !== null}
            onClick={() => void openFile()}
          >
            Open SQLite file…
          </Btn>
          {connecting === FILE_OPEN_ID ? <span className="spinner" /> : null}
        </div>
      </div>

      <div className="connect-footnote">
        SQLite · MySQL · PostgreSQL · SQL Server · Redis · DynamoDB · MongoDB · Cassandra — more
        engines coming. Your credentials never leave this machine.
      </div>

      {showNew || editConn ? (
        <NewConnectionModal
          edit={editConn ?? undefined}
          onClose={() => {
            setShowNew(false);
            setEditConn(null);
          }}
        />
      ) : null}
    </div>
  );
}
