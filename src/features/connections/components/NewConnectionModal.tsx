// New-connection modal — ported from the prototype's connect.jsx
// NewConnectionModal (spec §3.2): engine picker (3 cards), General / SSH
// tunnel section tabs (server engines only), SQLite file variant, and a
// Test connection / Save footer, all on the shared Modal primitive
// (scrim/Esc/focus handling).
//
// M12 Task 3 made the server forms fully real: the typed password (and SSH
// key passphrase / bastion password) are sent transiently to test/open and
// persisted to the OS keychain on Save (never to the registry file); the TLS
// dropdown carries its granular mode (`disable`/`prefer`/`require`/
// `verify-full`) through to the params; and the SSH tunnel section wires real
// `ssh` config (host/port/user + key/password/agent auth) so a connection can
// be reached through a bastion.
//
// State: a single `useReducer` (the M2 backlog refactor). Every params-relevant
// field edit resets the test verdict to idle in ONE place (the reducer's
// default case), with an explicit opt-out list of actions that must NOT reset
// it (switching the section tab, the verdict transitions themselves, the
// saving flag). Secrets live in the reducer too but are NEVER part of the saved
// params — they travel separately to the backend.
//
// This component is part of the slice's public surface alongside api.ts /
// state.ts — the workspaces connect screen mounts it directly (the modal is
// a connections concern; the screen that hosts it is not).

import { useId, useReducer, useRef, type KeyboardEvent } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import type { Engine } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { useToast } from "../../../shared/ui/toastContext";
import {
  connectionTest,
  type ConnectionParams,
  type SshAuth,
  type SshConfig,
  type TlsMode,
} from "../api";
import { pickPrivateKeyFile, pickSqliteFile } from "../dialog";
import { useConnectionsStore } from "../state";
import "./NewConnectionModal.css";

// Picker cards in the prototype's ENGINE_META order (labels match the badge).
// Redis (M13, REDIS_SPEC §1) is the 4th choice — the picker grid is 4-up.
const ENGINES: { engine: Engine; label: string }[] = [
  { engine: "sqlite", label: "SQLite" },
  { engine: "mysql", label: "MySQL" },
  { engine: "postgres", label: "PostgreSQL" },
  { engine: "redis", label: "Redis" },
];

const DEFAULT_PORTS: Partial<Record<Engine, string>> = {
  postgres: "5432",
  mysql: "3306",
  redis: "6379",
};

const TLS_MODES: TlsMode[] = ["disable", "prefer", "require", "verify-full"];
type SshAuthMethod = SshAuth["method"];

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

// -- Reducer ----------------------------------------------------------------

interface FormState {
  engine: Engine;
  section: "general" | "tunnel";
  name: string;
  host: string;
  port: string;
  // True once the user edited the port — switching engines then keeps it.
  portTouched: boolean;
  db: string;
  user: string;
  file: string;
  tls: TlsMode;
  // Transient secrets — sent to the backend, never part of saved params.
  password: string;
  // SSH tunnel.
  useSsh: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: SshAuthMethod;
  sshKey: string;
  sshPassword: string;
  // Footer.
  test: TestState;
  saving: boolean;
}

const INITIAL: FormState = {
  engine: "postgres",
  section: "general",
  name: "",
  host: "localhost",
  port: "5432",
  portTouched: false,
  db: "",
  user: "",
  file: "",
  tls: "prefer",
  password: "",
  useSsh: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuth: "key",
  sshKey: "~/.ssh/id_ed25519",
  sshPassword: "",
  test: IDLE,
  saving: false,
};

type Action =
  // A single generic field edit. Listed in the reducer's default branch, so it
  // ALWAYS resets the test verdict (a green "OK" must describe current values).
  | { type: "field"; patch: Partial<FormState> }
  // Edits that must NOT reset the verdict (the explicit opt-out list).
  | { type: "section"; section: FormState["section"] }
  | { type: "saving"; saving: boolean }
  | { type: "test"; test: TestState }
  // Engine switch: resets section + auto-fills the default port when untouched.
  | { type: "engine"; engine: Engine };

function reducer(state: FormState, action: Action): FormState {
  switch (action.type) {
    // -- opt-out list: these do NOT reset the test verdict ------------------
    case "section":
      return { ...state, section: action.section };
    case "saving":
      return { ...state, saving: action.saving };
    case "test":
      return { ...state, test: action.test };
    case "engine": {
      const defaultPort = DEFAULT_PORTS[action.engine];
      return {
        ...state,
        engine: action.engine,
        section: "general",
        port: defaultPort !== undefined && !state.portTouched ? defaultPort : state.port,
        test: IDLE,
      };
    }
    // -- everything else is a params-relevant edit → reset the verdict ------
    case "field":
      return { ...state, ...action.patch, test: IDLE };
  }
}

interface NewConnectionModalProps {
  onClose: () => void;
}

export function NewConnectionModal({ onClose }: NewConnectionModalProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const {
    engine,
    section,
    name,
    host,
    port,
    db,
    user,
    file,
    tls,
    password,
    useSsh,
    sshHost,
    sshPort,
    sshUser,
    sshAuth,
    sshKey,
    sshPassword,
    test: testState,
    saving,
  } = state;

  const saveConnection = useConnectionsStore((s) => s.save);
  const toast = useToast();
  const sshToggleId = useId();

  // Convenience: a params-relevant field edit (resets the verdict).
  const field = (patch: Partial<FormState>) => dispatch({ type: "field", patch });

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
    dispatch({ type: "section", section: next });
    (next === "general" ? generalTabRef : tunnelTabRef).current?.focus();
  };

  const isFileBased = engine === "sqlite";
  // Redis (REDIS_SPEC §1): a numbered logical db (0–15) in place of a relational
  // database name, and an optional ACL user (the Redis `default` user otherwise).
  const isRedis = engine === "redis";

  const pickEngine = (next: Engine) => dispatch({ type: "engine", engine: next });

  /**
   * Build the SSH config for the params (no secrets — those travel separately),
   * or a §5-style sentence naming the first missing SSH field. Only called for
   * server engines with the tunnel enabled.
   */
  const buildSsh = (): { ssh: SshConfig } | { error: string } => {
    if (!sshHost.trim()) return { error: "SSH host is required" };
    const sshPortNumber = Number(sshPort.trim());
    if (!Number.isInteger(sshPortNumber) || sshPortNumber < 1 || sshPortNumber > 65535) {
      return { error: "SSH port must be a number between 1 and 65535" };
    }
    if (!sshUser.trim()) return { error: "SSH user is required" };
    let auth: SshAuth;
    if (sshAuth === "key") {
      if (!sshKey.trim()) return { error: "SSH private key path is required" };
      auth = { method: "key", keyPath: sshKey.trim() };
    } else if (sshAuth === "password") {
      auth = { method: "password" };
    } else {
      auth = { method: "agent" };
    }
    return {
      ssh: { host: sshHost.trim(), port: sshPortNumber, user: sshUser.trim(), auth },
    };
  };

  /**
   * Validate the current form into wire params, or a §5-style sentence naming
   * the first missing field.
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

    let ssh: SshConfig | undefined;
    if (useSsh) {
      const built = buildSsh();
      if ("error" in built) return { error: built.error };
      ssh = built.ssh;
    }

    // Redis (M13) is key-value, not relational: `db` is the numbered logical
    // db index (0–15) rather than a database name, and the ACL user is
    // optional. The dedicated Redis form fields land with the renderer slice
    // (Tasks 2–4); this branch keeps the params shape type-correct meanwhile.
    if (engine === "redis") {
      const dbIndex = Number(db.trim() || "0");
      if (!Number.isInteger(dbIndex) || dbIndex < 0 || dbIndex > 15) {
        return { error: "DB index must be a number between 0 and 15" };
      }
      return {
        params: {
          engine: "redis",
          host: host.trim(),
          port: portNumber,
          dbIndex,
          ...(user.trim() ? { user: user.trim() } : {}),
          tlsMode: tls,
          ...(ssh ? { ssh } : {}),
        },
      };
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
        tlsMode: tls,
        ...(ssh ? { ssh } : {}),
      },
    };
  };

  /** The transient secrets to send with test/save (empty strings → omitted). */
  const secrets = (): { password?: string; sshSecret?: string } => ({
    password: password || undefined,
    // The SSH secret only applies when tunnelling with password/key auth.
    sshSecret: useSsh && sshAuth === "password" ? sshPassword || undefined : undefined,
  });

  const test = async () => {
    const built = buildParams();
    if ("error" in built) {
      dispatch({ type: "test", test: { phase: "err", message: built.error } });
      return;
    }
    dispatch({ type: "test", test: { phase: "testing" } });
    try {
      const info = await connectionTest(built.params, secrets());
      dispatch({ type: "test", test: { phase: "ok", serverVersion: info.serverVersion } });
    } catch (error) {
      if (isAppErrorPayload(error)) {
        // Real backend verdict — exact message, inline per spec §5.
        dispatch({ type: "test", test: { phase: "err", message: error.message } });
      } else {
        // Plain browser dev: no Tauri IPC at all.
        dispatch({ type: "test", test: IDLE });
        toast("Test connection requires the desktop app", "info");
      }
    }
  };

  const save = async () => {
    if (!name.trim()) {
      dispatch({ type: "test", test: { phase: "err", message: "Name is required" } });
      return;
    }
    const built = buildParams();
    if ("error" in built) {
      dispatch({ type: "test", test: { phase: "err", message: built.error } });
      return;
    }
    dispatch({ type: "saving", saving: true });
    try {
      // The prototype modal has no environment field, so new connections
      // default to env "local" (the EnvTag on the card reflects it). Secrets
      // travel to the OS keychain via the store, never to the registry file.
      await saveConnection(
        {
          id: "",
          name: name.trim(),
          engine,
          params: built.params,
          env: "local",
        },
        secrets(),
      );
    } catch (error) {
      if (isAppErrorPayload(error)) toast(error.message, "err");
      else toast("Saving connections requires the desktop app", "info");
      dispatch({ type: "saving", saving: false });
      return;
    }
    toast("Connection “" + name.trim() + "” saved", "ok");
    onClose();
  };

  const browseDatabaseFile = async () => {
    try {
      const path = await pickSqliteFile();
      if (path !== null) field({ file: path });
    } catch (error) {
      if (isAppErrorPayload(error)) toast(error.message, "err");
      else toast("Native file dialog requires the desktop app", "info");
    }
  };

  const browseKeyFile = async () => {
    try {
      const path = await pickPrivateKeyFile();
      // The key path is a params field (it is stored), so reset the verdict.
      if (path !== null) field({ sshKey: path });
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
            onClick={() => dispatch({ type: "section", section: "general" })}
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
            onClick={() => dispatch({ type: "section", section: "tunnel" })}
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
              onChange={(e) => field({ name: e.target.value })}
              placeholder="my_database"
              spellCheck={false}
            />
          </label>
          <label className="span-2">
            Database file
            <div className="file-row">
              <input
                value={file}
                onChange={(e) => field({ file: e.target.value })}
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
        // `hidden` attribute so the controlled inputs keep focus/values across
        // General ↔ SSH switches (the Modal focus trap skips hidden elements).
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
                onChange={(e) => field({ name: e.target.value })}
                placeholder="my_database"
                spellCheck={false}
              />
            </label>
            <label>
              TLS mode
              <select
                value={tls}
                onChange={(e) => field({ tls: e.target.value as TlsMode })}
                className="form-select"
              >
                {TLS_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Host
              <input
                value={host}
                onChange={(e) => field({ host: e.target.value })}
                spellCheck={false}
              />
            </label>
            <label>
              Port
              <input
                value={port}
                onChange={(e) => field({ port: e.target.value, portTouched: true })}
                spellCheck={false}
              />
            </label>
            <label>
              {isRedis ? "DB index" : "Database"}
              <input
                value={db}
                onChange={(e) => field({ db: e.target.value })}
                placeholder={isRedis ? "0" : engine === "postgres" ? "postgres" : "mysql"}
                spellCheck={false}
              />
            </label>
            <label>
              {isRedis ? "ACL user" : "User"}
              <input
                value={user}
                onChange={(e) => field({ user: e.target.value })}
                placeholder={isRedis ? "default" : engine === "postgres" ? "postgres" : "root"}
                spellCheck={false}
              />
            </label>
            {/* The password is sent transiently to test/open and stored in the
              OS keychain on Save (M12 Task 3); it is NEVER part of the saved
              params or the registry file. */}
            <label className="span-2">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => field({ password: e.target.value })}
                placeholder="••••••••"
              />
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
                  onChange={(e) => field({ useSsh: e.target.checked })}
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
                    onChange={(e) => field({ sshHost: e.target.value })}
                    placeholder="bastion.example.com"
                    spellCheck={false}
                  />
                </label>
                <label>
                  SSH port
                  <input
                    value={sshPort}
                    onChange={(e) => field({ sshPort: e.target.value })}
                    spellCheck={false}
                  />
                </label>
                <label>
                  SSH user
                  <input
                    value={sshUser}
                    onChange={(e) => field({ sshUser: e.target.value })}
                    placeholder="deploy"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Auth method
                  <select
                    value={sshAuth}
                    onChange={(e) => field({ sshAuth: e.target.value as SshAuthMethod })}
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
                        onChange={(e) => field({ sshKey: e.target.value })}
                        spellCheck={false}
                      />
                      <Btn variant="tonal" small onClick={() => void browseKeyFile()}>
                        Browse…
                      </Btn>
                    </div>
                  </label>
                ) : sshAuth === "password" ? (
                  // Sent transiently + stored in the keychain on Save, same as
                  // the database password above.
                  <label className="span-2">
                    SSH password
                    <input
                      type="password"
                      value={sshPassword}
                      onChange={(e) => field({ sshPassword: e.target.value })}
                      placeholder="••••••••"
                    />
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
