# ADR-NNNN — Title in plain words

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** YYYY-MM-DD (first commit that shipped the feature)
- **Area:** Architecture | Connections | Data browsing | SQL | Schema | Data movement | Engines | App shell
- **Related:** ADR-XXXX, `docs/MNN-….md`

## Context

What problem the feature solves and the forces that shaped it: user need, engine
differences, desktop/Tauri constraints, performance, safety. Only facts that the
code, commit history, or design docs support.

## Decision

What was built and how, at the level of the choices that matter. Name the real
modules (`src-tauri/src/features/<slice>/…`, `src/features/<slice>/…`) and the
Tauri commands. Prefer bullets for distinct choices.

## Alternatives considered

The options a reasonable engineer would weigh, and why the shipped choice won.
Where the code or a comment records the reason (e.g. a Cargo.toml note), cite it.
Where the reason is inferred rather than recorded, say "inferred".

## Consequences

- **Positive:** what the choice buys.
- **Negative / trade-offs:** what it costs, known limits, engines left out.
- **Follow-ups:** open gaps visible in the code (TODOs, unsupported engines).
