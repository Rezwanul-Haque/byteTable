# ADR-0006 — Workspace rail, schema sub-workspaces, and read-only workspaces

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-12 (first commit that shipped the feature)
- **Area:** App shell
- **Related:** ADR-0005, ADR-0007, ADR-0012, ADR-0018, `docs/M1-workspace-rail-connect-screen.md`

## Context

A user typically has several connections open at once (local, staging,
production) and needs to tell them apart instantly. Later requests (issue #33)
asked to work in several schemas of one database side by side without opening
the connection twice. A further request was a workspace that cannot write, for
browsing production safely. The work shipped in three steps: the rail (`3ebb477`,
`ba4e659`, 2026-06-12), schema sub-workspaces (`1f25baf`, `e8f3e51`, 2026-08-11),
and read-only workspaces (`b754a9d`, 2026-10-18).

## Decision

**Workspaces and the rail**

- A `Workspace` (`src/features/workspaces/types.ts`) is one opened connection. It
  holds `handleId`, `info`, `schemas`, `kind`, a user-renamable `name`, a palette
  `color`, and its own `ui` (tabs, filters, history; ADR-0007). It lives in
  `useWorkspacesStore` (`workspaces/state.ts`).
- The rail (`workspaces/components/Rail.tsx`) shows one tile per workspace with a
  context popover for rename, recolor and close, plus a "+" tile for the
  connect screen. The session is restored per saved connection id from
  `localStorage` (`workspaces/session.ts`). Nothing auto-connects.

**Schema sub-workspaces (#33)**

- There are three optional fields: `parentId`, `schema`, `temp`.
  `openSchemaWorkspace(parentId, schema)` clones the parent workspace. It
  shares the **same `handleId`** (no second connection), gets a fresh `ui`, and
  gets a colour not used by the parent or its siblings. The id is
  deterministic (`schemaWorkspaceId` = `ws-<parent>-<schema>`), so opening the
  same schema again focuses it.
- Nesting is one level only. A temporary child closes with its parent. A
  child that has been kept is promoted to top level. `closeWorkspace` and
  `setWorkspaceHandle` refcount handles and call `connection_close` only when
  no surviving workspace references the handle.
- `workspaces/scopes.ts` extends this to Cassandra keyspaces and Mongo/Redis
  databases (`e8f3e51`). DynamoDB and Typesense are excluded on purpose (no
  scope level).

**Read-only workspaces**

- `SavedConnection.read_only` is persisted, and `connection_open` accepts a
  `read_only` request. The rule in `open_connection` is
  `saved_read_only || read_only_request`: a request can only tighten.
  `ConnectionManager` keeps a `read_only` set of handles.
  `connection_set_read_only` is a session override that never touches the
  registry.
- **Enforcement is in Rust.** `ConnectionManager::ensure_writable(&handle, action)`
  returns `AppError::ReadOnly` and is the first call in named mutation commands
  (`mutate`, `structure`, `export`, `generate`, `keyvalue`, `dynamo`,
  `mongo`, `cassandra`, `search`, `privileges`, `processes`, `schema_diff`,
  `change_history`, `value_search`). Free-form runners classify the text with
  `src-tauri/src/shared/readonly.rs`: `sql_is_read_only` (an allowlist of
  opening keywords plus a scan for write keywords later in the statement),
  `redis_command_is_read_only`, and `http_method_is_read_only`. The
  classifiers are conservative by design: whatever they cannot prove read-only
  is refused. The SQL editor refuses a whole batch if any statement writes
  (`refuse_writes_in_read_only`).
- **The UI only hides controls.** `useReadOnly()` (`src/shared/ui/readOnlyContext.ts`)
  is a React context read by surfaces that hide mutation affordances. Its
  header says "This is a UI concern only", and it cannot bypass the backend.
- Read-only is **per workspace** in the UI, while the backend tracks it per
  handle, and parent and children share a handle. To reconcile the two,
  `useHandleReadOnlySync` is the single caller of `connectionSetReadOnly`. It
  pushes the *active* workspace's mode whenever focus, flag or handle changes.

## Alternatives considered

- **A second connection per sub-workspace.** Rejected. The code says it
  "inherits the connection wholesale … so no second connection is opened".
- **Read-only enforced only in the UI.** Rejected. `readonly.rs` says a stray,
  hand-crafted or forgotten invoke "cannot write either".
- **A keyword blocklist for SQL.** Rejected in favour of an allowlist of openers.
  The reason given is that it rejects every write verb "by construction —
  including the ones a keyword blocklist would miss".
- **Database-level read-only sessions (`SET TRANSACTION READ ONLY`).** Not
  documented as considered. Inferred: it is not portable across Redis, DynamoDB,
  Typesense, or SQLite.

## Consequences

- **Positive:** one socket serves many schema views. Read-only holds even
  against code paths that forget to check it. False refusals have an
  obvious workaround (reconnect writable).
- **Negative / trade-offs:** the conservative classifiers refuse some harmless
  reads (e.g. `SELECT lock FROM t` with an unquoted column named after a `TAIL_HAZARDS` keyword). The handle-level flag means
  correctness depends on only the active workspace issuing commands, plus one
  IPC hop after a switch. Every new mutating command must remember
  `ensure_writable`.
- **Follow-ups:** no lint or test asserts that every mutating command calls the
  guard.
