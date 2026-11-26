# ADR-0005 — Per-slice Zustand stores, typed invoke wrappers, one structured error

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-12 (first commit that shipped the feature)
- **Area:** Architecture
- **Related:** ADR-0001, ADR-0002, ADR-0006, ADR-0007, `docs/M0-scaffold-design-system.md`, `docs/M2-sqlite-connections.md`

## Context

The renderer talks to the Rust core only through Tauri commands (ADR-0001), and
each capability is a slice (ADR-0002). The renderer therefore needs a typed view
of each slice's commands, the payloads they share, and a way to tell failure
categories apart without exposing Rust internals. The requirements were
per-slice renderer stores (Zustand or equivalent) and one shared error type mapped
at the command boundary, so stack traces never leak to the UI. The
`preferences` walking skeleton set the pattern on 2026-06-12 (`471ccd3`).

## Decision

- **`api.ts` per slice: typed `invoke()` wrappers.** Each has one function per
  command, such as `prefsGet(): Promise<Preferences>` →
  `invoke<Preferences>("prefs_get")` in `src/features/preferences/api.ts`.
  These sit next to TS interfaces mirroring the Rust serde types (camelCase
  fields, lowercase enum tags). 22 slices have one. Long-running commands
  stream progress over a Tauri `Channel<T>` (`engine.ts` import/export,
  `generate`, `value_search`, `assistant`).
- **Shared wire types in `src/shared/api/engine.ts`.** These are the TS mirrors of
  `crate::shared::engine` (`EngineInfo`, `SchemaInfo`, `TableInfo`,
  `QueryResult`, `CellValue`, …) and are used by every slice that talks to a
  connection. They were moved out of `connections/api.ts` in `4773ff5`
  (2026-06-13); `connections/api.ts` re-exports them for back-compat. The rule
  in the file header is "keep the two files in sync".
- **Per-slice Zustand stores in `state.ts`** (17 slices), using `create<…>()`
  from `zustand`. Stores stay synchronous where they can. For example,
  `workspaces/state.ts` leaves the async connect flow to `connect.ts` and
  only calls `openWorkspace` once a backend handle exists. Other slices may
  import a store (`useIntrospectionStore.getState().invalidate(handleId)` from
  `workspaces`) because `state.ts` counts as public contract.
- **Persistence happens outside the stores.** Zustand `persist` middleware is
  not used. Data owned by the backend goes through commands. Cheap UI
  state goes to `localStorage` through explicit modules (`workspaces/session.ts`,
  `settings/cache.ts`), with every read guarded.
- **One error type.** `AppError` in `src-tauri/src/shared/error.rs` (thiserror) has
  `Io | Serialization | NotFound | Invalid | Database | Unsupported | ReadOnly`.
  A hand-written `Serialize` emits `{ "kind": "<camelCase>", "message":
  "<Display>" }`. `Database`, `Unsupported` and `ReadOnly` pass their message
  through verbatim, because adapters already produce human §5 sentences. The
  renderer mirror is `src/shared/api/error.ts`: `AppErrorKind`,
  `AppErrorPayload`, `isAppErrorPayload()` and `appErrorMessage(value,
  fallback)`. `ReadOnly` was added on 2026-10-18 so the UI can tell "your
  setting" apart from "engine can't" (ADR-0006).

## Alternatives considered

- **Generated bindings (tauri-specta, ts-rs).** Not used, and no document
  discusses them. Inferred: hand-mirroring was simpler at M0 scale. The cost
  is the manual "keep in sync" discipline noted in every header.
- **A single global store or Redux.** Rejected by the per-slice rule. Inferred:
  Zustand's hook selectors and `getState()` cover both component and module
  access with no provider tree.
- **Zustand `persist` middleware.** Not used. `session.ts` documents what
  is deliberately *not* stored (SQL result sets, structure drafts, staged grid
  edits). An explicit serializer (`forStorage`) makes that filtering visible.
- **Returning `String` errors from commands.** Rejected. A plain string cannot
  be branched on, hence the `kind` discriminant (`error.rs` header).

## Consequences

- **Positive:** every command call is typed at the call site. A failure always
  has a human message plus a stable `kind`, and the error tests
  (`every_variant_maps_to_a_stable_kind`) pin the wire shape. Slices stay
  independent on the renderer side as well.
- **Negative / trade-offs:** Rust/TS type drift is caught only by tests and review.
  `engine.ts` is about 1050 lines. `workspaces/state.ts` is the largest store
  and holds tab state for every tab kind (ADR-0007).
- **Follow-ups:** `engine.ts` still notes `queryRun` lives there "as a temporary
  home".
