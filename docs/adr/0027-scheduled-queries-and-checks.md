# ADR-0027 — Scheduled queries and checks run in-process, read-only, from a resolved SQL snapshot

- **Status:** Accepted (retroactive — documented 2026-11-26 from the shipped implementation)
- **Date:** 2026-10-26 (first commit that shipped the feature: `3ef9c54` "run saved queries on a schedule time and write the result to a folder"; checks added in `a25abeb`, 2026-11-24)
- **Area:** SQL
- **Related:** ADR-0001, ADR-0003, ADR-0004, ADR-0006, ADR-0022, ADR-0023, ADR-0036, ADR-0053

## Context

The backlog item was "run a report nightly, drop the CSV somewhere". It later
grew into local data-quality alerts: "this query should return no rows". The UI
reuses the snippet-drawer and settings-modal patterns. Several constraints shaped the design:

- The app hides to tray on window close and has a single-instance guard (AGENTS.md).
- Laptops suspend, so monotonic timers drift from wall-clock time.
- Query parameters are resolved by a renderer-only lexer (ADR-0022).
- An unattended write at 3am cannot be undone.

## Decision

Five decisions shape the feature. The code that
carries them is in `src-tauri/src/features/schedules/` (domain / ports /
application / infrastructure / commands / scheduler) and `src/features/schedules/`.

- **In-process scheduler** (`scheduler.rs`): one tokio task spawned from
  `lib.rs`. After `STARTUP_DELAY = 20s` it ticks every `TICK = 30s` and reads the
  wall clock each time, never sleeping until the next due time. The module
  comment explains why: a sleep set at 23:00 for 03:00 fires at 07:00 on a
  machine suspended for four hours. Close-to-tray keeps the loop alive while
  the window is hidden. **Catch-up is bounded**: an overdue schedule runs once,
  and `next_run_at` is then recomputed from now.
- **Structured recurrence** (`domain::Recurrence`, serde-tagged):
  - `Every { minutes }` with a minimum of `MIN_EVERY_MINUTES = 5`;
  - `Daily`;
  - `Weekly` (weekday 0 = Sunday, matching JS `getDay()`);
  - `Monthly`, where a day past month end clamps to the last day instead of
    skipping the month.
  There is no cron string. `src/features/schedules/recurrence.ts` only describes
  recurrences; `nextRunAt` always comes from Rust.
- **Resolved SQL snapshot:** parameters are substituted in the renderer when the
  schedule is saved, so a second lexer in Rust cannot disagree with
  `sqlParams.ts`. `saved_query_id` is kept for provenance only. The only dynamic
  parts are date tokens (`{{today}}`, …) expanded by `resolve_sql_tokens`.
  `{{name}}` and `{{env}}` are deliberately not allowed in SQL, and unknown
  tokens are left as written.
- **Read-only, twice:** `execute` checks `sql_only_reads` before opening a socket,
  because the command-layer guard is not on this path and `schedules.json` can be
  hand-edited. It then opens a **new, short-lived** connection with
  `read_only_request: true` and closes it on every exit path. It never borrows
  the user's workspace handle.
- **Row limit:** the schedule's own `row_limit` (`DEFAULT_ROW_LIMIT = 100_000`)
  replaces the IPC `MAX_ROW_LIMIT`, since the result goes to a file and not over
  IPC. `truncated` is recorded on the run.
- **Serialized, infallible runs:** `commands::run_one` runs behind a
  `tokio::sync::Mutex<()>` gate. `run_schedule` returns a `RunRecord`, not a
  `Result`, so every failure becomes a recorded failed run. There is no
  automatic retry; the next occurrence is the retry.
- **Output:** `OutputFormat` `Csv | Json`. CSV is byte-identical to the manual
  export (ADR-0036). Filenames come from a `{{name}}_{{date}}`-style pattern
  (`src/features/schedules/filename.ts`), and pruning keeps the last
  `DEFAULT_KEEP = 30` files that match **this schedule's pattern only**.
- **Checks** (`CheckRule` `NoRows | AtMost { rows } | AtLeast { rows }`): a
  failing check is a *successful* run with `check_failure` and a sample of
  `SAMPLE_ROWS = 5` rows. If the schedule writes a file, the file is still
  written.
- **Alerts:** an alert fires only when a notifying schedule's health changes.
  It is a toast when a window is focused, otherwise an OS notification via
  `tauri-plugin-notification`. The Cargo.toml comment gives the reason:
  "close-to-tray means the usual 3am run has no window to toast in". The plugin
  is called from Rust only, so the renderer gets no notification permission.
  Failing schedules show a badge on the rail.
- **Stores** (`infrastructure`): `schedules.json` treats a corrupt file as an
  error, because it is user data. `schedule_runs.json` resets when corrupt,
  because it is a diagnostic. History keeps `MAX_HISTORY = 20` runs per schedule.
  Both are written atomically under a mutex.
- **Commands and UI:** `schedule_list`, `schedule_save`, `schedule_delete`,
  `schedule_set_enabled`, `schedule_runs`, `schedule_run_now` and
  `schedule_reveal`. The UI is `components/SchedulesModal.tsx` with
  `hooks/useScheduleEvents.ts`. It opens from the rail, the Query menu, and a
  saved-query row ("Schedule this query", ADR-0023).

## Alternatives considered

- **OS schedulers (launchd / Task Scheduler / systemd) with a headless CLI:**
  rejected for v1. It needs a second entry point, per-OS
  installer work, and a fresh keychain ACL grant for a non-GUI invocation
  (ADR-0004).
- **Point at a live `SavedQuery.id`:** rejected, because it would need parameter
  resolution in Rust (see above).
- **Cron expressions:** omitted on purpose. The serde tag leaves room to add a
  `Cron` variant later.
- **Optional write permission:** rejected ("Not a checkbox").
- **Retry on failure:** rejected. A schema-change failure repeats on every
  retry, and an overnight retry loop against production is worse than a missed
  report.

## Consequences

- **Positive:** there is no per-OS install work. Lifecycle, keychain access and
  single-instance behaviour come from the app. Runs are timed correctly across
  suspend and clock changes, cannot write, and cannot leak connections.
- **Negative / trade-offs:** **nothing fires while the app is fully quit.**
  Catch-up on next launch is the only mitigation. Runs are sequential, so a long
  query delays the others. A deleted connection becomes a recorded `NotFound`
  failure. The SQL snapshot does not follow later edits to the source saved
  query.
- **Follow-ups:** cron and value-based check rules are left open by the tagged
  enums. A headless or OS-level runner is deferred.
