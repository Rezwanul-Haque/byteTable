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

import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from "react";

import { isAppErrorPayload } from "../../../shared/api/error";
import { expandTilde, tildify, useHomeDir } from "../../../shared/homeDir";
import type { Engine, Env } from "../../../shared/types";
import { Btn } from "../../../shared/ui/Btn";
import { EngineBadge } from "../../../shared/ui/EngineBadge";
import { Icon } from "../../../shared/ui/Icon";
import { IconBtn } from "../../../shared/ui/IconBtn";
import { ENV_COLOR, ENV_SWATCHES } from "../../../shared/ui/envColors";
import { Modal, ModalActions, ModalTitle } from "../../../shared/ui/Modal";
import { Select } from "../../../shared/ui/Select";
import { useToast } from "../../../shared/ui/toastContext";
import {
  connectionTest,
  type ConnectionParams,
  type SavedConnection,
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
  { engine: "mssql", label: "MS SQL Server" },
  { engine: "redis", label: "Redis" },
  { engine: "dynamodb", label: "DynamoDB" },
  { engine: "mongodb", label: "MongoDB" },
  { engine: "cassandra", label: "Cassandra" },
];

/** AWS regions offered in the DynamoDB connect form (prototype `AWS_REGIONS`). */
const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-north-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "sa-east-1",
  "ca-central-1",
];

const DEFAULT_PORTS: Partial<Record<Engine, string>> = {
  postgres: "5432",
  mysql: "3306",
  mssql: "1433",
  redis: "6379",
  mongodb: "27017",
  cassandra: "9042",
};

// The conventional superuser each engine ships with — prefilled into the User
// field so the common case is one click. Untouched switches re-default it (like
// the port); once the user edits the field it is left alone.
const DEFAULT_USERS: Partial<Record<Engine, string>> = {
  postgres: "postgres",
  mysql: "root",
  // SQL Server's built-in sysadmin login.
  mssql: "sa",
};

/**
 * The environment picker's segmented choices (prototype connect.jsx
 * `CONN_ENVS`): the canonical {@link Env} ids plus their display label and the
 * Material icon shown in the segment. `short` is the EnvTag text (identical to
 * the id for all three).
 */
const CONN_ENVS: { id: Env; label: string; short: string; icon: string }[] = [
  { id: "dev", label: "Development", short: "dev", icon: "code" },
  { id: "staging", label: "Staging", short: "staging", icon: "science" },
  { id: "production", label: "Production", short: "production", icon: "public" },
];

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
  /** Project label for grouping on the connect screen ("" ⇒ Ungrouped). */
  project: string;
  host: string;
  port: string;
  // True once the user edited the port — switching engines then keeps it.
  portTouched: boolean;
  db: string;
  user: string;
  // True once the user edited the username — switching engines then keeps it
  // (mirrors portTouched).
  userTouched: boolean;
  file: string;
  tls: TlsMode;
  // DynamoDB (M17). `ddbMode` toggles AWS vs a Local endpoint; `region` is the
  // AWS region (a label only in Local mode); `ddbEndpoint` is the DynamoDB Local
  // URL; `awsAuth` picks the credential mode; `awsProfile` / `awsAccessKeyId` are
  // its non-secret inputs (the secret access key reuses the `password` field).
  ddbMode: "aws" | "local";
  region: string;
  ddbEndpoint: string;
  awsAuth: "profile" | "keys";
  awsProfile: string;
  awsAccessKeyId: string;
  // MongoDB (M18). `mongoConnMode` toggles the Host/port form vs a single
  // connection-string field; `mongoUri` is the `mongodb://` / `mongodb+srv://`
  // string used in URI mode.
  mongoConnMode: "fields" | "uri";
  mongoUri: string;
  // Cassandra (M19). `datacenter` is the optional local datacenter for
  // token-aware routing (`dc1`); the contact points reuse `host`, the keyspace
  // reuses `db`, and the user/password/TLS fields are shared with the server
  // engines.
  datacenter: string;
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
  // Environment (m15 env picker). `env` is the chosen deployment env; `envColors`
  // is the per-env swatch (seeded from ENV_COLOR, overridable). Neither affects
  // whether the connection works, so editing them does NOT reset the test
  // verdict — they live on their own actions in the opt-out list.
  env: Env;
  envColors: Record<Env, string>;
  // Footer.
  test: TestState;
  saving: boolean;
}

const INITIAL: FormState = {
  engine: "postgres",
  section: "general",
  name: "",
  project: "",
  host: "localhost",
  port: "5432",
  portTouched: false,
  db: "",
  user: "postgres",
  userTouched: false,
  file: "",
  tls: "disable",
  ddbMode: "aws",
  region: "eu-central-1",
  ddbEndpoint: "http://localhost:8000",
  awsAuth: "profile",
  awsProfile: "default",
  awsAccessKeyId: "",
  mongoConnMode: "fields",
  mongoUri: "mongodb://localhost:27017",
  datacenter: "dc1",
  password: "",
  useSsh: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuth: "key",
  sshKey: "~/.ssh/id_ed25519",
  sshPassword: "",
  env: "dev",
  envColors: { ...ENV_COLOR },
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
  // Env picker: choosing an env / recoloring it does not change the params, so
  // it never invalidates the test verdict.
  | { type: "env"; env: Env }
  | { type: "envColor"; color: string }
  // Project label is connect-screen metadata — never invalidates the verdict.
  | { type: "project"; project: string }
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
    case "env":
      return { ...state, env: action.env };
    case "project":
      return { ...state, project: action.project };
    case "envColor":
      // Recolor only the currently-selected env (prototype `setEnvColors`).
      return { ...state, envColors: { ...state.envColors, [state.env]: action.color } };
    case "engine": {
      const defaultPort = DEFAULT_PORTS[action.engine];
      return {
        ...state,
        engine: action.engine,
        section: "general",
        port: defaultPort !== undefined && !state.portTouched ? defaultPort : state.port,
        user: !state.userTouched ? (DEFAULT_USERS[action.engine] ?? "") : state.user,
        test: IDLE,
      };
    }
    // -- everything else is a params-relevant edit → reset the verdict ------
    case "field":
      return { ...state, ...action.patch, test: IDLE };
  }
}

/** Derive the form state from an existing saved connection (edit mode). Secrets
 *  are NOT prefilled — they live in the keychain; leaving the password blank
 *  keeps the stored secret (the backend only overwrites when a non-empty secret
 *  is supplied). */
function formStateFromConnection(c: SavedConnection): FormState {
  const p = c.params;
  const base: FormState = {
    ...INITIAL,
    engine: c.engine,
    name: c.name,
    project: c.project ?? "",
    env: c.env,
    portTouched: true,
    userTouched: true,
    envColors: { ...ENV_COLOR, [c.env]: c.color ?? ENV_COLOR[c.env] },
  };
  if (p.engine === "sqlite") {
    return { ...base, file: p.path };
  }
  if (p.engine === "dynamodb") {
    return {
      ...base,
      ddbMode: p.endpoint ? "local" : "aws",
      region: p.region,
      ddbEndpoint: p.endpoint ?? INITIAL.ddbEndpoint,
      awsAuth: p.auth.mode,
      awsProfile: p.auth.mode === "profile" ? p.auth.profile : INITIAL.awsProfile,
      awsAccessKeyId: p.auth.mode === "keys" ? p.auth.accessKeyId : "",
    };
  }
  if (p.engine === "mongodb") {
    return {
      ...base,
      mongoConnMode: p.uri ? "uri" : "fields",
      mongoUri: p.uri ?? INITIAL.mongoUri,
      host: p.host,
      port: String(p.port),
      db: p.database ?? "",
      user: p.user ?? "",
      tls: p.tlsMode,
    };
  }
  if (p.engine === "cassandra") {
    return {
      ...base,
      host: p.contactPoints,
      port: String(p.port),
      db: p.keyspace ?? "",
      datacenter: p.localDatacenter ?? "",
      user: p.user ?? "",
      tls: p.tlsMode,
    };
  }
  const sshFields = p.ssh
    ? {
        useSsh: true,
        sshHost: p.ssh.host,
        sshPort: String(p.ssh.port),
        sshUser: p.ssh.user,
        sshAuth: p.ssh.auth.method,
        sshKey: p.ssh.auth.method === "key" ? p.ssh.auth.keyPath : INITIAL.sshKey,
      }
    : {};
  if (p.engine === "redis") {
    return {
      ...base,
      host: p.host,
      port: String(p.port),
      db: String(p.dbIndex),
      user: p.user ?? "",
      tls: p.tlsMode,
      ...sshFields,
    };
  }
  return {
    ...base,
    host: p.host,
    port: String(p.port),
    db: p.database ?? "",
    user: p.user ?? "",
    tls: p.tlsMode,
    ...sshFields,
  };
}

interface NewConnectionModalProps {
  onClose: () => void;
  /** When set, the modal edits this saved connection (prefilled, saved back to
   *  the same id) instead of creating a new one. */
  edit?: SavedConnection;
}

/** Project picker (ported from the prototype's ProjectField): a dropdown of
 *  "Ungrouped" + known project labels, with an inline "New project…" add. */
function ProjectField({
  value,
  onChange,
  known,
}: {
  value: string;
  onChange: (value: string) => void;
  known: string[];
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const commitNew = () => {
    const v = draft.trim();
    if (v) onChange(v);
    setAdding(false);
    setDraft("");
    setOpen(false);
  };
  // A value the user typed that isn't in the known list yet (shown as selected).
  const isNew = value !== "" && !known.includes(value);

  return (
    // A <div>, NOT a <label>: a <label> forwards clicks on any inner element to
    // its first control (the select button), which would re-toggle the dropdown
    // shut when you click "New project…".
    <div className="form-field">
      <span className="form-field-label">Project</span>
      <div className="proj-select" ref={ref}>
        <button type="button" className="proj-select-btn" onClick={() => setOpen((o) => !o)}>
          <Icon
            name={value ? "folder" : "folder_off"}
            size={13}
            style={{ color: value ? "var(--accent)" : "var(--text-faint)" }}
          />
          <span className={"proj-select-val" + (value ? "" : " empty")}>
            {value || "Ungrouped"}
          </span>
          <Icon name="expand_more" size={14} style={{ color: "var(--text-faint)" }} />
        </button>
        {open ? (
          <div className="proj-dd">
            <button
              type="button"
              className={"proj-dd-item" + (!value ? " on" : "")}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              <Icon name="folder_off" size={13} /> Ungrouped
            </button>
            {known.map((p) => (
              <button
                key={p}
                type="button"
                className={"proj-dd-item" + (value === p ? " on" : "")}
                onClick={() => {
                  onChange(p);
                  setOpen(false);
                }}
              >
                <Icon name="folder" size={13} style={{ color: "var(--accent)" }} /> {p}
              </button>
            ))}
            {isNew ? (
              <div className="proj-dd-item on">
                <Icon name="folder" size={13} style={{ color: "var(--accent)" }} /> {value}
              </div>
            ) : null}
            <div className="proj-dd-sep" />
            {adding ? (
              <div className="proj-dd-add">
                <input
                  autoFocus
                  value={draft}
                  placeholder="New project name"
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitNew();
                    if (e.key === "Escape") setAdding(false);
                  }}
                />
                <button type="button" className="proj-dd-addbtn" onClick={commitNew}>
                  <Icon name="check" size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="proj-dd-item create"
                onClick={() => {
                  setAdding(true);
                  setDraft("");
                }}
              >
                <Icon name="add" size={13} /> New project…
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function NewConnectionModal({ onClose, edit }: NewConnectionModalProps) {
  const home = useHomeDir();
  const [state, dispatch] = useReducer(reducer, edit ? formStateFromConnection(edit) : INITIAL);
  const {
    engine,
    section,
    name,
    project,
    host,
    port,
    db,
    user,
    file,
    tls,
    ddbMode,
    region,
    ddbEndpoint,
    awsAuth,
    awsProfile,
    awsAccessKeyId,
    mongoConnMode,
    mongoUri,
    datacenter,
    password,
    useSsh,
    sshHost,
    sshPort,
    sshUser,
    sshAuth,
    sshKey,
    sshPassword,
    env,
    envColors,
    test: testState,
    saving,
  } = state;

  // The chosen env's color — drives the env tag, the swatch active ring, and
  // the color persisted on the saved connection.
  const envColor = envColors[env];

  const saveConnection = useConnectionsStore((s) => s.save);
  const removeConnection = useConnectionsStore((s) => s.remove);
  // Existing project labels (for the ProjectField dropdown).
  const savedConnections = useConnectionsStore((s) => s.savedConnections);
  const knownProjects = [
    ...new Set(savedConnections.map((c) => c.project).filter((p): p is string => !!p)),
  ].sort((a, b) => a.localeCompare(b));
  const toast = useToast();
  // Two-click delete confirm (edit mode only) — destructive, so the first click
  // arms it and the second removes.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sshToggleId = useId();
  const envLabelId = useId();

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
  // DynamoDB (M17): its own AWS/Local + region + credential form; no SSH tab.
  const isDynamo = engine === "dynamodb";
  // MongoDB (M18): its own Host/port ⇄ Connection string form; no SSH tab.
  const isMongo = engine === "mongodb";
  // Cassandra (M19): contact points + native port + optional keyspace + local
  // datacenter; no SSH tab (the driver discovers the ring).
  const isCassandra = engine === "cassandra";

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
    // DynamoDB (M17): region + credential mode + an optional Local endpoint. No
    // host/port/database/TLS/SSH. The secret access key (keys auth) is a secret
    // and travels via `secrets()`, never in params.
    if (engine === "dynamodb") {
      if (!region.trim()) return { error: "Region is required" };
      if (ddbMode === "local" && !ddbEndpoint.trim()) {
        return { error: "Endpoint URL is required for a Local connection" };
      }
      const auth =
        awsAuth === "profile"
          ? { mode: "profile" as const, profile: awsProfile.trim() || "default" }
          : { mode: "keys" as const, accessKeyId: awsAccessKeyId.trim() };
      if (auth.mode === "keys" && !auth.accessKeyId) {
        return { error: "Access key ID is required" };
      }
      return {
        params: {
          engine: "dynamodb",
          region: region.trim(),
          ...(ddbMode === "local" ? { endpoint: ddbEndpoint.trim() } : {}),
          auth,
        },
      };
    }
    // MongoDB (M18): connection-string mode validates only the URI; host/port
    // mode validates host + port and carries the discrete fields. The password
    // (either mode) is a secret and travels via `secrets()`, never in params.
    if (engine === "mongodb") {
      if (mongoConnMode === "uri") {
        const uri = mongoUri.trim();
        if (!uri) return { error: "Connection string is required" };
        if (!uri.startsWith("mongodb://") && !uri.startsWith("mongodb+srv://")) {
          return { error: "Connection string must start with mongodb:// or mongodb+srv://" };
        }
        return {
          params: {
            engine: "mongodb",
            uri,
            host: host.trim() || "localhost",
            port: Number(port.trim()) || 27017,
            tlsMode: tls,
          },
        };
      }
      if (!host.trim()) return { error: "Host is required" };
      const mongoPort = Number(port.trim());
      if (!Number.isInteger(mongoPort) || mongoPort < 1 || mongoPort > 65535) {
        return { error: "Port must be a number between 1 and 65535" };
      }
      return {
        params: {
          engine: "mongodb",
          host: host.trim(),
          port: mongoPort,
          ...(db.trim() ? { database: db.trim() } : {}),
          ...(user.trim() ? { user: user.trim() } : {}),
          tlsMode: tls,
        },
      };
    }
    // Cassandra (M19): contact points (host or comma-separated hosts) + native
    // port, an optional keyspace + local datacenter, and an optional auth user.
    // The password is a secret and travels via `secrets()`, never in params.
    if (engine === "cassandra") {
      if (!host.trim()) return { error: "Contact points are required" };
      const cassPort = Number(port.trim());
      if (!Number.isInteger(cassPort) || cassPort < 1 || cassPort > 65535) {
        return { error: "Port must be a number between 1 and 65535" };
      }
      return {
        params: {
          engine: "cassandra",
          contactPoints: host.trim(),
          port: cassPort,
          ...(db.trim() ? { keyspace: db.trim() } : {}),
          ...(datacenter.trim() ? { localDatacenter: datacenter.trim() } : {}),
          ...(user.trim() ? { user: user.trim() } : {}),
          tlsMode: tls,
        },
      };
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

    // Postgres and SQL Server each bind a connection to ONE database with no
    // in-session switch, so a blank database strands the user in the login's
    // default db (libpq's username-default for Postgres; `master` for SQL Server
    // `sa`), which can't reach the intended database's schemas/tables. Require
    // it. MySQL stays optional (schema == database there; the adapter qualifies
    // every reference).
    if (engine === "postgres" && !db.trim()) {
      return { error: "Database is required for PostgreSQL" };
    }
    if (engine === "mssql" && !db.trim()) {
      return { error: "Database is required for SQL Server" };
    }

    // database + user are optional (MySQL: no default schema / default user;
    // Postgres handled above). Omit when blank.
    return {
      params: {
        engine,
        host: host.trim(),
        port: portNumber,
        ...(db.trim() ? { database: db.trim() } : {}),
        ...(user.trim() ? { user: user.trim() } : {}),
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
      // The env picker (m15) carries the chosen env + its color onto the saved
      // connection: the EnvTag/dot read `env`, and the workspace tile reads
      // `color` (falling back to the auto-cycle palette when absent — it never
      // is here). Secrets travel to the OS keychain via the store, never to the
      // registry file.
      await saveConnection(
        {
          // Editing reuses the existing id so the backend updates in place
          // (keeping created_at + the keychain secret); "" creates a new entry.
          id: edit ? edit.id : "",
          name: name.trim(),
          engine,
          params: built.params,
          env,
          color: envColor,
          ...(project.trim() ? { project: project.trim() } : {}),
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

  // Delete the connection being edited (removes it + its keychain secrets). The
  // first click arms (confirmDelete); this runs on the second.
  const remove = async () => {
    if (!edit) return;
    try {
      await removeConnection(edit.id);
    } catch (error) {
      if (isAppErrorPayload(error)) toast(error.message, "err");
      else toast("Deleting connections requires the desktop app", "info");
      return;
    }
    toast("Connection “" + edit.name + "” deleted", "ok");
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
    <Modal label={edit ? "Edit connection" : "New connection"} onClose={onClose}>
      <ModalTitle>
        <span>{edit ? "Edit connection" : "New connection"}</span>
        <IconBtn icon="close" onClick={onClose} title="Close" />
      </ModalTitle>

      <div className="form-grid name-grid">
        <label>
          Name
          <input
            value={name}
            onChange={(e) => field({ name: e.target.value })}
            placeholder="my_database"
            spellCheck={false}
            autoFocus
          />
        </label>
        <ProjectField
          value={project}
          onChange={(v) => dispatch({ type: "project", project: v })}
          known={knownProjects}
        />
      </div>

      <div className="ee-block">
        <span className="form-section-label">Engine</span>
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
      </div>

      <div className="ee-block">
        <span className="form-section-label" id={envLabelId}>
          Environment
        </span>
        <div className="env-seg" role="radiogroup" aria-labelledby={envLabelId}>
          {CONN_ENVS.map((e) => {
            const isActive = env === e.id;
            return (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={isActive}
                className={"env-seg-btn" + (isActive ? " active" : "")}
                style={{
                  borderColor: isActive ? envColors[e.id] : "var(--border)",
                  background: isActive ? envColors[e.id] + "16" : "var(--bg1)",
                  color: isActive ? "var(--text)" : "var(--text-dim)",
                }}
                onClick={() => dispatch({ type: "env", env: e.id })}
              >
                <span className="env-dot" style={{ background: envColors[e.id] }} />
                <Icon name={e.icon} size={14} />
                {e.label}
              </button>
            );
          })}
        </div>
        <div className="env-colors">
          <span className="env-colors-label">Color</span>
          {ENV_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className={"env-swatch" + (envColor === c ? " active" : "")}
              style={{ background: c }}
              title={c}
              aria-label={"Set color " + c}
              aria-pressed={envColor === c}
              onClick={() => dispatch({ type: "envColor", color: c })}
            />
          ))}
        </div>
        {env === "production" ? (
          <div className="env-warn" role="alert">
            <Icon name="gpp_maybe" size={15} /> Production — destructive actions (DROP, DELETE,
            TRUNCATE, FLUSHDB) will require confirmation.
          </div>
        ) : null}
      </div>

      {!isFileBased && !isDynamo && !isMongo && !isCassandra ? (
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

      {isDynamo ? (
        <div className="form-grid">
          <div className="span-2 seg ddb-mode-seg">
            <button
              type="button"
              className={"seg-btn" + (ddbMode === "aws" ? " active" : "")}
              onClick={() => field({ ddbMode: "aws" })}
            >
              <Icon name="cloud" size={14} /> AWS
            </button>
            <button
              type="button"
              className={"seg-btn" + (ddbMode === "local" ? " active" : "")}
              onClick={() => field({ ddbMode: "local" })}
            >
              <Icon name="hard_drive" size={14} /> Local endpoint
            </button>
          </div>
          {ddbMode === "aws" ? (
            <>
              {/* Select fields use a div + span, NOT a <label>: a <label>
                  natively forwards an inner click to its first control (the
                  trigger), reopening the just-closed popover — React's synthetic
                  stopPropagation can't prevent that native behavior. Mirrors
                  ProjectField. */}
              <div className="form-field span-2">
                <span className="form-field-label">Region</span>
                <Select
                  className="sel-block"
                  aria-label="AWS region"
                  value={region}
                  options={AWS_REGIONS.map((r) => ({ value: r, label: r }))}
                  onChange={(v) => field({ region: v })}
                />
              </div>
              <div className="form-field">
                <span className="form-field-label">Credentials</span>
                <Select
                  className="sel-block"
                  aria-label="Credential mode"
                  value={awsAuth}
                  options={[
                    { value: "profile", label: "Shared profile" },
                    { value: "keys", label: "Access keys" },
                  ]}
                  onChange={(v) => field({ awsAuth: v as "profile" | "keys" })}
                />
              </div>
              {awsAuth === "profile" ? (
                <label>
                  Profile
                  <input
                    value={awsProfile}
                    onChange={(e) => field({ awsProfile: e.target.value })}
                    placeholder="default"
                    spellCheck={false}
                  />
                </label>
              ) : (
                <label>
                  Access key ID
                  <input
                    value={awsAccessKeyId}
                    onChange={(e) => field({ awsAccessKeyId: e.target.value })}
                    placeholder="AKIA…"
                    spellCheck={false}
                  />
                </label>
              )}
              {awsAuth === "keys" ? (
                // The secret access key is sent transiently and stored in the OS
                // keychain on Save (like the SQL password) — never in params.
                <label className="span-2">
                  Secret access key
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => field({ password: e.target.value })}
                    placeholder="••••••••••••"
                  />
                </label>
              ) : null}
              <div className="span-2 form-note">
                <Icon name="cloud" size={14} />{" "}
                <span>
                  Connects to DynamoDB in {region}. Credentials are resolved from your{" "}
                  {awsAuth === "profile" ? "~/.aws/credentials profile" : "access keys"} and never
                  leave this machine.
                </span>
              </div>
            </>
          ) : (
            <>
              <label className="span-2">
                Endpoint URL
                <input
                  value={ddbEndpoint}
                  onChange={(e) => field({ ddbEndpoint: e.target.value })}
                  placeholder="http://localhost:8000"
                  spellCheck={false}
                />
              </label>
              <div className="form-field span-2">
                <span className="form-field-label">
                  <span className="lbl-row">
                    Region <span className="opt-tag">label only</span>
                  </span>
                </span>
                <Select
                  className="sel-block"
                  aria-label="Region label"
                  value={region}
                  options={AWS_REGIONS.map((r) => ({ value: r, label: r }))}
                  onChange={(v) => field({ region: v })}
                />
              </div>
              <div className="span-2 form-note">
                <Icon name="hard_drive" size={14} />{" "}
                <span>
                  DynamoDB Local / LocalStack — region is just a label; any access keys work.
                </span>
              </div>
            </>
          )}
        </div>
      ) : isMongo ? (
        <div className="form-grid">
          <div className="span-2 seg ddb-mode-seg">
            <button
              type="button"
              className={"seg-btn" + (mongoConnMode === "fields" ? " active" : "")}
              onClick={() => field({ mongoConnMode: "fields" })}
            >
              <Icon name="dns" size={14} /> Host / port
            </button>
            <button
              type="button"
              className={"seg-btn" + (mongoConnMode === "uri" ? " active" : "")}
              onClick={() => field({ mongoConnMode: "uri" })}
            >
              <Icon name="link" size={14} /> Connection string
            </button>
          </div>
          {mongoConnMode === "uri" ? (
            <>
              <label className="span-2">
                Connection string
                <input
                  value={mongoUri}
                  onChange={(e) => field({ mongoUri: e.target.value })}
                  placeholder="mongodb+srv://user:pass@cluster.mongodb.net/byteshop"
                  spellCheck={false}
                />
              </label>
              <div className="span-2 form-note">
                <Icon name="link" size={14} />{" "}
                <span>
                  Both <code>mongodb://</code> and <code>mongodb+srv://</code> (Atlas SRV) URIs are
                  supported. Credentials are parsed locally and never leave this machine.
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="form-field">
                <span className="form-field-label">TLS mode</span>
                <Select
                  className="sel-block"
                  aria-label="TLS mode"
                  value={tls}
                  options={TLS_MODES.map((mode) => ({ value: mode, label: mode }))}
                  onChange={(v) => field({ tls: v })}
                />
              </div>
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
                <span className="lbl-row">
                  Database <span className="opt-tag">optional</span>
                </span>
                <input
                  value={db}
                  onChange={(e) => field({ db: e.target.value })}
                  placeholder="byteshop"
                  spellCheck={false}
                />
              </label>
              <label>
                <span className="lbl-row">
                  User <span className="opt-tag">optional</span>
                </span>
                <input
                  value={user}
                  onChange={(e) => field({ user: e.target.value, userTouched: true })}
                  placeholder="admin"
                  spellCheck={false}
                />
              </label>
              <label>
                <span className="lbl-row">
                  Password <span className="opt-tag">optional</span>
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => field({ password: e.target.value })}
                  placeholder="••••••••"
                />
              </label>
            </>
          )}
        </div>
      ) : isCassandra ? (
        <div className="form-grid">
          <div className="form-field">
            <span className="form-field-label">TLS mode</span>
            <Select
              className="sel-block"
              aria-label="TLS mode"
              value={tls}
              options={TLS_MODES.map((mode) => ({ value: mode, label: mode }))}
              onChange={(v) => field({ tls: v })}
            />
          </div>
          <label>
            <span className="lbl-row">
              Host
              <span
                className="lbl-info"
                tabIndex={0}
                role="img"
                aria-label="Cassandra connects to contact points and discovers the rest of the ring. Set the host(s), the native-protocol port (9042), and the local datacenter for token-aware routing."
                data-tip="Cassandra connects to contact points and discovers the rest of the ring. Set the host(s), the native-protocol port (9042), and the local datacenter for token-aware routing."
              >
                <Icon name="info" size={13} />
              </span>
            </span>
            <input
              value={host}
              onChange={(e) => field({ host: e.target.value })}
              placeholder="127.0.0.1"
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
            <span className="lbl-row">
              Keyspace <span className="opt-tag">optional</span>
            </span>
            <input
              value={db}
              onChange={(e) => field({ db: e.target.value })}
              placeholder="byteshop"
              spellCheck={false}
            />
          </label>
          <label>
            <span className="lbl-row">
              Local datacenter <span className="opt-tag">optional</span>
            </span>
            <input
              value={datacenter}
              onChange={(e) => field({ datacenter: e.target.value })}
              placeholder="dc1"
              spellCheck={false}
            />
          </label>
          <label>
            <span className="lbl-row">
              User <span className="opt-tag">optional</span>
            </span>
            <input
              value={user}
              onChange={(e) => field({ user: e.target.value, userTouched: true })}
              placeholder="cassandra"
              spellCheck={false}
            />
          </label>
          <label>
            <span className="lbl-row">
              Password <span className="opt-tag">optional</span>
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => field({ password: e.target.value })}
              placeholder="••••••••"
            />
          </label>
        </div>
      ) : isFileBased ? (
        <div className="form-grid">
          <label className="span-2">
            Database file
            <div className="file-row">
              <input
                // Display the path with the home dir collapsed to `~`, but keep
                // the absolute path as the stored value (expand on every edit) so
                // save / test / connect all see a real filesystem path.
                value={tildify(file, home)}
                onChange={(e) => field({ file: expandTilde(e.target.value, home) })}
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
              Host
              <input
                value={host}
                onChange={(e) => field({ host: e.target.value })}
                spellCheck={false}
              />
            </label>
            <div className="form-field">
              <span className="form-field-label">TLS mode</span>
              <Select
                className="sel-block"
                aria-label="TLS mode"
                value={tls}
                options={TLS_MODES.map((mode) => ({ value: mode, label: mode }))}
                onChange={(v) => field({ tls: v })}
              />
            </div>
            <label>
              Port
              <input
                value={port}
                onChange={(e) => field({ port: e.target.value, portTouched: true })}
                spellCheck={false}
              />
            </label>
            <label>
              {isRedis ? (
                "DB index"
              ) : (
                <span className="lbl-row">
                  Database{" "}
                  {engine === "postgres" || engine === "mssql" ? null : (
                    <span className="opt-tag">optional</span>
                  )}
                </span>
              )}
              <input
                value={db}
                onChange={(e) => field({ db: e.target.value })}
                placeholder={
                  isRedis
                    ? "0"
                    : engine === "postgres"
                      ? "postgres"
                      : engine === "mssql"
                        ? "byteshop"
                        : "mysql"
                }
                spellCheck={false}
              />
            </label>
            <label>
              {isRedis ? (
                "ACL user"
              ) : (
                <span className="lbl-row">
                  User <span className="opt-tag">optional</span>
                </span>
              )}
              <input
                value={user}
                onChange={(e) => field({ user: e.target.value, userTouched: true })}
                placeholder={
                  isRedis
                    ? "default"
                    : engine === "mssql"
                      ? "sa"
                      : engine === "postgres"
                        ? "postgres"
                        : "root"
                }
                spellCheck={false}
              />
            </label>
            {/* The password is sent transiently to test/open and stored in the
              OS keychain on Save (M12 Task 3); it is NEVER part of the saved
              params or the registry file. */}
            <label>
              <span className="lbl-row">
                Password <span className="opt-tag">optional</span>
              </span>
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
                <div className="form-field">
                  <span className="form-field-label">Auth method</span>
                  <Select
                    className="sel-block"
                    aria-label="Auth method"
                    value={sshAuth}
                    options={[
                      { value: "key", label: "Private key" },
                      { value: "password", label: "Password" },
                      { value: "agent", label: "SSH agent" },
                    ]}
                    onChange={(v) => field({ sshAuth: v as SshAuthMethod })}
                  />
                </div>
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
        {edit ? (
          <Btn
            variant="text"
            className={"conn-delete" + (confirmDelete ? " armed" : "")}
            icon={confirmDelete ? "warning" : "delete"}
            disabled={saving}
            onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
          >
            {confirmDelete ? "Confirm delete" : "Delete"}
          </Btn>
        ) : null}
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
