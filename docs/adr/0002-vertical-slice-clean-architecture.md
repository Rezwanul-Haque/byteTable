# ADR-0002 — Vertical slices with clean-architecture layers inside each

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-06-12 (first commit that shipped the feature)
- **Area:** Architecture
- **Related:** ADR-0001, ADR-0003, ADR-0005, `docs/M0-scaffold-design-system.md`, `AGENTS.md`

## Context

ByteTable grows one capability at a time: connections, browse, structure,
schema map, explain, schedules, and so on. The project required vertical slice
architecture combined with clean architecture inside each slice from the start,
so that each capability can be built, tested and replaced in isolation, matching
how the work is cut into increments.

M0 proved the pattern with one walking-skeleton slice, `preferences`
(`471ccd3`, 2026-06-12). It runs
`domain → application → ports → infrastructure → command → typed invoke()`.
The directory was renamed from `slices/` to `features/` on 2026-06-13 (`4b1b97e`).

## Decision

**Rust (`src-tauri/src/features/<slice>/`)**

- One module per capability, listed in `src-tauri/src/features/mod.rs` (33 today).
- The full layering is `domain/`, `application/`, `ports.rs`, `infrastructure/`,
  `commands.rs`. The dependency rule is `domain ← application ← (infrastructure |
  commands)` (`features/preferences/mod.rs`). Slices that own storage use all
  five: `preferences`, `settings`, `saved_queries`, `snippets`, `schedules`,
  `schema_map`, `schema_diff`, `connections`.
- **Thin slices are allowed.** A slice with no storage of its own skips the
  layers it does not need. `browse`, `introspection`, `insights`, `mutate`,
  `processes`, `result_compare` are just `application.rs` + `commands.rs` over
  the engine ports. `features/browse/mod.rs` documents this and explains why.
- `commands.rs` is the presentation layer: `#[tauri::command]` functions that
  read managed state and call the application layer. Concrete adapters are
  chosen only in `lib.rs` ("Commands depend only on ports", see
  `features/connections/commands.rs`).
- **Shared kernel `src-tauri/src/shared/`** is "the only cross-slice surface"
  (`shared/mod.rs`): `error.rs` (ADR-0005), the engine port families under
  `ports/` (ADR-0003), `readonly.rs` (ADR-0006), `sql_lex.rs`.
- **Cross-slice use goes through public application APIs.** Example: `browse`
  and `introspection` consume `connections`' `ConnectionManager`.
  `connection_bundle` composes `connections`' `ConnectionRepository` and
  `SecretStore` ports instead of living inside that slice
  (`features/connection_bundle/mod.rs`).
- **Async rule:** DB-touching slices expose `async fn` commands. `preferences` is
  the one documented sync exception (`shared/ports/sql/mod.rs`).

**Renderer (`src/features/<slice>/`)**, rules in `AGENTS.md`, enforced since
`0e8a0b1` (2026-09-08):

- `components/` contains React components only, each next to its own CSS.
- `hooks/` contains modules whose *entire* export surface is a React hook.
- The slice root holds `api.ts` (typed invoke wrappers), `state.ts` (Zustand),
  and pure logic with co-located `*.test.ts`. Pure `.ts` helpers never go in
  `components/`, even when only one component uses them.
- Cross-feature imports may use another slice's `api.ts` / `state.ts` (its
  "public contract", `src/features/connections/api.ts`) but never its
  components or hooks.
- `src/shared/` holds design tokens, UI primitives (`ui/`), cross-feature hooks
  (`hooks/`), wire types (`api/`) and i18n.

## Alternatives considered

- **Horizontal layers (one `commands/`, one `services/`, one `db/` tree).**
  Rejected at the outset. Inferred: with ~33 capabilities, one global
  layer per folder would put every feature's change across the whole tree.
- **Full layering in every slice.** Rejected in practice. The thin read-only
  slices would gain empty `domain/` and `infrastructure/` modules. `browse/mod.rs`
  records that this is deliberate.
- **Rust feature crates (a workspace of crates per slice).** Not considered in
  any document. Inferred: compile-time isolation, but more build complexity for
  a single-binary app.

## Consequences

- **Positive:** a new capability is mostly a new folder on each side plus registration
  in `lib.rs` and `features/mod.rs`. The domain and application layers are
  unit-testable with in-memory fakes (e.g. `InMemorySecretStore`, ADR-0004).
- **Negative / trade-offs:** the layering is a convention. Nothing (no lint, no
  crate boundary) stops a slice importing another's internals. Layer depth
  differs between slices. Some slices have grown large (`connections`,
  `workspaces`; the renderer's `workspaces/state.ts` holds the tab system too,
  ADR-0007). `lib.rs` is a long composition root, with about 236 `::commands::`
  references.
- **Follow-ups:** the README's slice list (`query`, …) lags the real
  `features/mod.rs`. The ESLint config has no import-boundary rule for the
  renderer placement rules.
