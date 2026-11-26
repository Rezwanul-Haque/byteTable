# ADR-0034 — Privileges view: normalised grant matrix with a staged editor

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-10-24 (first commit that shipped the feature)
- **Area:** Schema
- **Related:** ADR-0003, ADR-0006, ADR-0029, ADR-0035

## Context

Users want to see who can do what: principals (users and roles), role membership, and
effective grants per object, the way pgAdmin and DBeaver show them. Four engines
model privileges as grantee × privilege × object: Postgres, MySQL, SQL Server and
ClickHouse. They disagree on the details:

- SQL Server has an explicit `DENY`, and ClickHouse has partial revokes.
- MySQL stores `GRANT OPTION` as a separate bit.
- Roles can form cycles in Postgres and MySQL.
- Wildcard scopes such as `*.*` coexist with narrower grants.

The plan was a read-only phase 1 and an editor in phase 2. Both shipped:
`7ded0c4` (2026-10-24) added the matrix, and `9a9a488` (2026-10-25) added the
grant/revoke editor (`domain/ops.rs`).

## Decision

- **An optional capability, not a family trait.** `PrivilegeReader` is defined in
  `src-tauri/src/shared/ports/privileges.rs`. A SQL connection exposes it through
  `as_privilege_reader` (`shared/ports/sql/conn.rs`, default `None`). It is
  implemented in `src-tauri/src/engines/{postgres,mysql,mssql,clickhouse}/privileges.rs`.
  `ConnectionManager::get_privilege_reader` returns `Unsupported` for every other
  engine.
- **Port methods:** `list_principals`, `list_memberships`, `list_grants(schema)`,
  `grant_capabilities` (pure), `current_principal`, and `apply_grants(ops, apply)`.
  `apply_grants` follows the M8 preview/apply contract: `apply = false` must not touch
  the database. Adapters select a fixed leading column layout so the shared
  `map_*_rows` helpers serve all four. Grants are capped at `PRIVILEGE_ROW_LIMIT =
  50_000`, and `truncated` reports when the cap is hit.
- **Four-state cell.** `PrivilegeState` is `none | granted | grantable | denied`, not a
  boolean, because SQL Server's `DENY` is not the absence of a grant (domain doc).
- **Effective resolution in the pure Rust domain** (`domain/mod.rs`,
  `resolve_effective`):
  - `Denied` beats everything. Otherwise more access wins.
  - On a tie, the nearest role chain wins and fills `via`.
  - The role walk is guarded against cycles.
  - Superusers are not expanded.
  - Wildcard scopes are deliberately *not* collapsed. The renderer
    (`src/features/privileges/matrix.ts`) resolves them by specificity first and
    state second. The file notes this was checked against clickhouse-server 24.10.
- **Commands** (`src-tauri/src/features/privileges/commands.rs`):
  - `privilege_snapshot(handle, schema, effective)` and `privilege_preview(handle,
    ops)` are reads.
  - `privilege_apply` calls `ensure_writable` first (ADR-0006).
- **Engine-neutral staged ops.** `GrantOp` is one of `Grant`, `Revoke`, `Deny`,
  `RevokeGrantOption`, `AddMember`, `DropMember` or `CreatePrincipal`, plus the
  remaining variants in `domain/ops.rs`. The SQL for each op is written in the engine
  adapters, mirroring `AlterOp` (ADR-0029).
  - `RevokeGrantOption` is its own op because on MySQL, revoking and re-granting
    leaves the option bit set. The op comment says this was verified on a live
    server.
  - `Deny` is offered only when `GrantCapabilities::can_deny` is true.
  - Passwords are masked in every statement that is displayed.
- **Self-lockout guard.** `refuse_self_lockout` in `application.rs` runs on both
  preview and apply. It rejects any removal whose subject is `current_principal()`.
- **Renderer** (`src/features/privileges/`):
  - `PrivilegesTab.tsx` is a singleton tab that follows the workspace schema and has
    a scope switcher (`204ae07`).
  - `CellMenu.tsx` lets the user pick a state explicitly. `edit.ts` notes that an
    earlier click-to-cycle design granted `WITH GRANT OPTION` on stray clicks.
  - `PrincipalModal.tsx` creates principals.
  - `GrantReviewModal.tsx` shows the SQL. Any op that removes access arms the
    production type-to-arm gate.
  - Cell transition rules and block reasons (`wildcardNarrow`,
    `widerGrantRemains`, `inherited`) are pure and covered by `edit.test.ts` and
    `matrix.test.ts`.

## Alternatives considered

- **Boolean grants.** Rejected in the domain doc because `DENY` cannot be retrofitted
  onto a boolean model.
- **Expand wildcards in Rust.** Rejected because expanding a wildcard needs the
  object list, which only the renderer holds (domain doc).
- **Translate "drop grant option" into revoke + grant.** Rejected because MySQL keeps
  the option bit (`ops.rs`, `edit.ts`).
- **Include Cassandra, MongoDB and Redis.** Excluded because their
  models differ (role documents, ACL categories) or because Cassandra was deferred to
  a "phase 1b".

## Consequences

- **Positive:**
  - One matrix covers four engines with honest `via` chains.
  - The rules that are easy to get wrong are pure and unit-tested.
  - The editor reuses the preview/apply pipeline and the read-only enforcement.
- **Negative / trade-offs:**
  - Apply is atomic only where `capabilities.atomic` is true. Elsewhere it runs
    sequentially and stops at the first failure.
  - Reading the catalogs needs privileges the connected account often lacks. Those
    errors are reworded by `catalog_access`.
  - If `current_principal` cannot be identified, the lockout guard is silently
    skipped.
- **Follow-ups:**
  - SQLite, Redis, MongoDB, Cassandra, DynamoDB and Typesense show the `Unsupported`
    empty state.
  - Cassandra is the documented next candidate.
