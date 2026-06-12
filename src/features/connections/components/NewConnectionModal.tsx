// New-connection modal — ported from the prototype's connect.jsx
// NewConnectionModal (spec §3.2): engine picker (3 cards), General / SSH
// tunnel section tabs (server engines only), SQLite file variant, and a
// Test connection / Save footer, all on the shared Modal primitive
// (scrim/Esc/focus handling).
//
// What is real in M2: SQLite end-to-end — Browse opens the native dialog,
// Test connection runs the backend's `connection_test`, Save writes the
// registry. The MySQL/PostgreSQL forms are design-complete and Save works
// (the registry stores them), but Test — and later open — answer with the
// backend's honest Unsupported sentence ("MySQL connections arrive in a
// later milestone."), rendered inline like any other test failure. The SSH
// tunnel section is likewise present per design but inert: ConnectionParams
// has no tunnel fields until M12, so nothing from it is persisted.
//
// This component is part of the slice's public surface alongside api.ts /
// state.ts — the workspaces connect screen mounts it directly (the modal is
// a connections concern; the screen that hosts it is not).

import { useId, useRef, useState, type KeyboardEvent } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import type { Engine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import { connectionTest, type ConnectionParams } from "../api";
import { pickPrivateKeyFile, pickSqliteFile } from "../dialog";
import { useConnectionsStore } from "../state";
import "./NewConnectionModal.css";

// Picker cards in the prototype's ENGINE_META order (labels match the badge).
const ENGINES: { engine: Engine; label: string }[] = [
  { engine: "sqlite", label: "SQLite" },
  { engine: "mysql", label: "MySQL" },
  { engine: "postgres", label: "PostgreSQL" },
];

const DEFAULT_PORTS: Partial<Record<Engine, string>> = { postgres: "5432", mysql: "3306" };

/**
 * Footer status: idle → testing (spinner) → "Connection OK · <version>" or
 * an inline §5-style error sentence (backend message or local validation).
 */
type TestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "ok"; serverVersion: string }
  | { phase: "err"; message: string };

const IDLE: TestState = { phase: "idle" };

interface NewConnectionModalProps {
  onClose: () => void;
}

export function NewConnectionModal({ onClose }: NewConnectionModalProps) {
  // Prototype defaults: postgres pre-selected, General section, port 5432.
  const [engine, setEngine] = useState<Engine>("postgres");
  const [section, setSection] = useState<"general" | "tunnel">("general");
  const [name, setName] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("5432");
  // True once the user edited the port — switching engines then keeps it
  // instead of auto-filling the new engine's default.
  const [portTouched, setPortTouched] = useState(false);
  const [db, setDb] = useState("");
  const [user, setUser] = useState("");
  const [file, setFile] = useState("");
  const [tls, setTls] = useState("prefer");
  // SSH tunnel — design-complete but inert until M12 (see module note):
  // these values are never part of the saved params.
  const [useSsh, setUseSsh] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUser, setSshUser] = useState("");
  const [sshAuth, setSshAuth] = useState<"key" | "password" | "agent">("key");
  const [sshKey, setSshKey] = useState("~/.ssh/id_ed25519");
  const [testState, setTestState] = useState<TestState>(IDLE);
  const [saving, setSaving] = useState(false);

  const saveConnection = useConnectionsStore((state) => state.save);
  const toast = useToast();
  const sshToggleId = useId();

  // ARIA tabs wiring (tab ↔ tabpanel) plus refs for arrow-key focus moves.
  const tabsBaseId = useId();
  const generalTabId = tabsBaseId + "-tab-general";
  const tunnelTabId = tabsBaseId + "-tab-tunnel";
  const generalPanelId = tabsBaseId + "-panel-general";
  const tunnelPanelId = tabsBaseId + "-panel-tunnel";
  const generalTabRef = useRef<HTMLButtonElement>(null);
  const tunnelTabRef = useRef<HTMLButtonElement>(null);

  // Left/Right arrows move between the two tabs (selection follows focus,
  // per the ARIA tabs pattern); with exactly two tabs both arrows toggle.
  const onTablistKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = section === "general" ? "tunnel" : "general";
    setSection(next);
    (next === "general" ? generalTabRef : tunnelTabRef).current?.focus();
  };

  const isFileBased = engine === "sqlite";

  // Any form edit invalidates a previous test verdict (and clears a stale
  // validation error) — a green "Connection OK" must describe the current
  // values, not the ones that were tested.
  const edit = (apply: () => void) => {
    apply();
    setTestState(IDLE);
  };

  const pickEngine = (next: Engine) => {
    setEngine(next);
    setTestState(IDLE);
    setSection("general");
    const defaultPort = DEFAULT_PORTS[next];
    if (defaultPort !== undefined && !portTouched) setPort(defaultPort);
  };

  /**
   * Validate the current form into wire params, or a §5-style sentence
   * naming the first missing field (the prototype had no validation; the
   * required-field set comes from the M2 task spec).
   */
  const buildParams = (): { params: ConnectionParams } | { error: string } => {
    if (engine === "sqlite") {
      if (!file.trim()) return { error: "Database file is required" };
      return { params: { engine: "sqlite", path: file.trim() } };
    }
    if (!host.trim()) return { error: "Host is required" };
    const portNumber = Number(port.trim());
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return { error: "Port must be a number between 1 and 65535" };
    }
    if (!db.trim()) return { error: "Database is required" };
    if (!user.trim()) return { error: "User is required" };
    return {
      params: {
        engine,
        host: host.trim(),
        port: portNumber,
        database: db.trim(),
        user: user.trim(),
        // The wire type carries a boolean until M12 brings real server
        // connections with full TLS-mode support; only "disable" means off.
        tls: tls !== "disable",
      },
    };
  };

  const test = async () => {
    const built = buildParams();
    if ("error" in built) {
      setTestState({ phase: "err", message: built.error });
      return;
    }
    setTestState({ phase: "testing" });
    try {
      const info = await connectionTest(built.params);
      setTestState({ phase: "ok", serverVersion: info.serverVersion });
    } catch (error) {
      if (isAppErrorPayload(error)) {
        // Real backend verdict — exact message, inline per spec §5. For
        // mysql/postgres this is the honest Unsupported sentence.
        setTestState({ phase: "err", message: error.message });
      } else {
        // Plain browser dev: no Tauri IPC at all.
        setTestState(IDLE);
        toast("Test connection requires the desktop app", "info");
      }
    }
  };

  const save = async () => {
    if (!name.trim()) {
      setTestState({ phase: "err", message: "Name is required" });
      return;
    }
    const built = buildParams();
    if ("error" in built) {
      setTestState({ phase: "err", message: built.error });
      return;
    }
    setSaving(true);
    try {
      // The prototype modal has no environment field, so new connections
      // default to env "local" (the EnvTag on the card reflects it).
      await saveConnection({
        id: "",
        name: name.trim(),
        engine,
        params: built.params,
        env: "local",
      });
    } catch (error) {
      if (isAppErrorPayload(error)) toast(error.message, "err");
      else toast("Saving connections requires the desktop app", "info");
      setSaving(false);
      return;
    }
    toast("Connection “" + name.trim() + "” saved", "ok");
    onClose();
  };

  const browseDatabaseFile = async () => {
    try {
      const path = await pickSqliteFile();
      if (path !== null) edit(() => setFile(path));
    } catch (error) {
      if (isAppErrorPayload(error)) toast(error.message, "err");
      else toast("Native file dialog requires the desktop app", "info");
    }
  };

  const browseKeyFile = async () => {
    try {
      const path = await pickPrivateKeyFile();
      if (path !== null) setSshKey(path);
    } catch (error) {
      if (isAppErrorPayload(error)) toast(error.message, "err");
      else toast("Native file dialog requires the desktop app", "info");
    }
  };

  return (
    <Modal label="New connection" onClose={onClose}>
      <ModalTitle>
        <span>New connection</span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </ModalTitle>

      <div className="engine-picker" role="radiogroup" aria-label="Database engine">
        {ENGINES.map((e) => (
          <button
            key={e.engine}
            type="button"
            role="radio"
            aria-checked={engine === e.engine}
            className={"engine-choice" + (engine === e.engine ? " active" : "")}
            onClick={() => pickEngine(e.engine)}
          >
            <EngineBadge engine={e.engine} size={28} />
            <span>{e.label}</span>
          </button>
        ))}
      </div>

      {!isFileBased ? (
        <div
          className="modal-tabs"
          role="tablist"
          aria-label="Server connection settings"
          onKeyDown={onTablistKeyDown}
        >
          <button
            ref={generalTabRef}
            type="button"
            role="tab"
            id={generalTabId}
            aria-selected={section === "general"}
            aria-controls={generalPanelId}
            tabIndex={section === "general" ? 0 : -1}
            className={"modal-tab" + (section === "general" ? " active" : "")}
            onClick={() => setSection("general")}
          >
            General
          </button>
          <button
            ref={tunnelTabRef}
            type="button"
            role="tab"
            id={tunnelTabId}
            aria-selected={section === "tunnel"}
            aria-controls={tunnelPanelId}
            tabIndex={section === "tunnel" ? 0 : -1}
            className={"modal-tab" + (section === "tunnel" ? " active" : "")}
            onClick={() => setSection("tunnel")}
          >
            SSH tunnel {useSsh ? <span className="modal-tab-dot" /> : null}
          </button>
        </div>
      ) : null}

      {isFileBased ? (
        <div className="form-grid">
          <label>
            Name
            <input
              value={name}
              onChange={(e) => edit(() => setName(e.target.value))}
              placeholder="my_database"
              spellCheck={false}
            />
          </label>
          <label className="span-2">
            Database file
            <div className="file-row">
              <input
                value={file}
                onChange={(e) => edit(() => setFile(e.target.value))}
                placeholder="~/path/to/database.db"
                spellCheck={false}
              />
              <Btn variant="tonal" small onClick={() => void browseDatabaseFile()}>
                Browse…
              </Btn>
            </div>
          </label>
          <div className="span-2 form-note">
            <Icon name="hard_drive" size={14} /> SQLite is a local file — no network, tunnel, or TLS
            needed.
          </div>
        </div>
      ) : (
        // Both server panels stay mounted; the inactive one is hidden via the
        // `hidden` attribute so the uncontrolled password inputs keep their
        // values across General ↔ SSH switches (the Modal focus trap already
        // skips hidden elements via getClientRects()).
        <>
          <div
            className="form-grid"
            role="tabpanel"
            id={generalPanelId}
            aria-labelledby={generalTabId}
            hidden={section !== "general"}
          >
            <label>
              Name
              <input
                value={name}
                onChange={(e) => edit(() => setName(e.target.value))}
                placeholder="my_database"
                spellCheck={false}
              />
            </label>
            <label>
              TLS mode
              <select
                value={tls}
                onChange={(e) => edit(() => setTls(e.target.value))}
                className="form-select"
              >
                <option value="disable">disable</option>
                <option value="prefer">prefer</option>
                <option value="require">require</option>
                <option value="verify-full">verify-full</option>
              </select>
            </label>
            <label>
              Host
              <input
                value={host}
                onChange={(e) => edit(() => setHost(e.target.value))}
                spellCheck={false}
              />
            </label>
            <label>
              Port
              <input
                value={port}
                onChange={(e) =>
                  edit(() => {
                    setPort(e.target.value);
                    setPortTouched(true);
                  })
                }
                spellCheck={false}
              />
            </label>
            <label>
              Database
              <input
                value={db}
                onChange={(e) => edit(() => setDb(e.target.value))}
                placeholder={engine === "postgres" ? "postgres" : "mysql"}
                spellCheck={false}
              />
            </label>
            <label>
              User
              <input
                value={user}
                onChange={(e) => edit(() => setUser(e.target.value))}
                placeholder={engine === "postgres" ? "postgres" : "root"}
                spellCheck={false}
              />
            </label>
            {/* Present per design but intentionally uncontrolled and never
              persisted — ConnectionParams has no password field by design;
              secrets go to the OS keychain in M12. */}
            <label className="span-2">
              Password
              <input type="password" placeholder="••••••••" />
            </label>
          </div>
          <div
            className="form-grid"
            role="tabpanel"
            id={tunnelPanelId}
            aria-labelledby={tunnelTabId}
            hidden={section !== "tunnel"}
          >
            <div className="span-2 ssh-toggle-row">
              <label className="switch-label" htmlFor={sshToggleId}>
                <input
                  id={sshToggleId}
                  type="checkbox"
                  checked={useSsh}
                  onChange={(e) => setUseSsh(e.target.checked)}
                  className="switch-input"
                />
                <span className={"switch" + (useSsh ? " on" : "")}>
                  <span className="switch-knob" />
                </span>
                Connect through an SSH tunnel
              </label>
            </div>
            {useSsh ? (
              <>
                <label>
                  SSH host
                  <input
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder="bastion.example.com"
                    spellCheck={false}
                  />
                </label>
                <label>
                  SSH port
                  <input
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <label>
                  SSH user
                  <input
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="deploy"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Auth method
                  <select
                    value={sshAuth}
                    onChange={(e) => setSshAuth(e.target.value as typeof sshAuth)}
                    className="form-select"
                  >
                    <option value="key">Private key</option>
                    <option value="password">Password</option>
                    <option value="agent">SSH agent</option>
                  </select>
                </label>
                {sshAuth === "key" ? (
                  <label className="span-2">
                    Private key
                    <div className="file-row">
                      <input
                        value={sshKey}
                        onChange={(e) => setSshKey(e.target.value)}
                        spellCheck={false}
                      />
                      <Btn variant="tonal" small onClick={() => void browseKeyFile()}>
                        Browse…
                      </Btn>
                    </div>
                  </label>
                ) : sshAuth === "password" ? (
                  // Uncontrolled + never persisted, same as the database
                  // password above (keychain in M12).
                  <label className="span-2">
                    SSH password
                    <input type="password" placeholder="••••••••" />
                  </label>
                ) : (
                  <div className="span-2 form-note">
                    <Icon name="key" size={14} /> Keys are read from your local ssh-agent. Nothing
                    is stored.
                  </div>
                )}
                <div className="span-2 form-note">
                  <Icon name="vpn_lock" size={14} /> The tunnel is opened locally:{" "}
                  {sshUser || "user"}@{sshHost || "bastion"} → {host}:{port}
                </div>
              </>
            ) : (
              <div className="span-2 form-note">
                <Icon name="info" size={14} /> Enable this when the database is only reachable
                through a bastion / jump host.
              </div>
            )}
          </div>
        </>
      )}

      <ModalActions>
        <div className="test-result" aria-live="polite">
          {testState.phase === "testing" ? (
            <>
              <span className="spinner" /> Testing…
            </>
          ) : null}
          {testState.phase === "ok" ? (
            <>
              <Icon name="check_circle" size={15} style={{ color: "var(--accent)" }} /> Connection
              OK · {testState.serverVersion}
            </>
          ) : null}
          {testState.phase === "err" ? (
            <span className="test-result-err">{testState.message}</span>
          ) : null}
        </div>
        <Btn variant="text" disabled={testState.phase === "testing"} onClick={() => void test()}>
          Test connection
        </Btn>
        <Btn variant="filled" disabled={saving} onClick={() => void save()}>
          Save
        </Btn>
      </ModalActions>
    </Modal>
  );
}
