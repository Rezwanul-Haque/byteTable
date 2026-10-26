//! The background loop that makes a schedule actually fire (M41).
//!
//! One tokio task, spawned once from the composition root. It wakes every
//! [`TICK`], asks which schedules are due *as of the wall clock right now*,
//! and runs them one at a time through the slice's gate.
//!
//! # Why a short tick instead of sleeping until the next run
//!
//! The obvious implementation — compute the next due instant and
//! `sleep(until - now)` — is wrong on a laptop. `tokio::time::sleep` counts
//! monotonic time, which on most platforms does not advance while the machine
//! is suspended, so a sleep until 03:00 set at 23:00 fires at 07:00 on a
//! machine closed for four hours. Re-reading the wall clock every 30 seconds
//! costs nothing measurable (a file read and an integer comparison) and is
//! correct across suspend, resume, timezone changes and a manual clock set.
//!
//! # Catch-up is bounded
//!
//! A schedule whose `next_run_at` is in the past runs ONCE and is then
//! rescheduled from `now` (see `application::next_run_at`). A laptop closed
//! over a long weekend produces one Monday-morning run of a nightly report,
//! not three.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::features::connections::commands::connect_timeout;
use crate::features::settings::commands::SettingsState;

use super::application;
use super::commands::{run_one, scheduler_states};
use super::domain::RunTrigger;

/// How often the loop re-reads the clock.
const TICK: Duration = Duration::from_secs(30);

/// Delay before the first tick.
///
/// Startup is the busiest moment in the app's life — the splash screen, the
/// settings bootstrap, the connection registry and the updater check all land
/// at once — and a schedule that missed its slot overnight can perfectly well
/// wait another twenty seconds. It also puts the first keychain read for an
/// unattended connection AFTER the window exists, so the OS prompt it may
/// raise on macOS has something to sit in front of.
const STARTUP_DELAY: Duration = Duration::from_secs(20);

/// Start the scheduler. Called once from `lib.rs`'s setup hook.
///
/// The task runs for the life of the process and is never joined: there is
/// nothing to collect, and the app exits through `RunEvent::ExitRequested`,
/// which tears the runtime down. An in-flight run holds the gate, so the
/// worst a quit mid-run costs is a half-written temp file that the atomic
/// write never renamed into place.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            tick(&app).await;
            tokio::time::sleep(TICK).await;
        }
    });
}

/// One pass: stamp any schedule that has never been scheduled, then run
/// whatever is due.
async fn tick(app: &AppHandle) {
    let Some((state, connections)) = scheduler_states(app) else {
        return; // Shutting down.
    };
    let now = application::now_local();

    // A corrupt schedules file is reported to the user the moment they open
    // the manager (the list command surfaces it). Here it would only produce
    // an error every 30 seconds with nowhere to go, so the tick simply does
    // nothing until the file is fixed.
    let Ok(schedules) = application::list_schedules(state.schedules()) else {
        return;
    };

    // Entries that have never been scheduled — a hand-written file, or one
    // written by a build from before this feature. Stamping them here (rather
    // than firing them) is what stops every app launch from running every
    // such schedule once.
    for (id, next_run_at) in application::missing_next_runs(&schedules, now) {
        let _ = state.schedules().set_next_run_at(&id, next_run_at);
    }

    let due = application::due_schedule_ids(&schedules, now);
    if due.is_empty() {
        return;
    }
    let Some(settings) = app.try_state::<SettingsState>() else {
        return; // Shutting down.
    };
    let timeout = connect_timeout(&settings);
    for id in due {
        let Some(schedule) = schedules.iter().find(|s| s.id == id) else {
            continue;
        };
        // Reschedule BEFORE running, not after. A run can take minutes, and a
        // crash or a quit in the middle of one must not leave the schedule
        // still marked due — which on next launch would run it again. The
        // next time is measured from now either way, so the only thing lost
        // by stamping early is the handful of seconds the run itself takes.
        let _ = state
            .schedules()
            .set_next_run_at(&id, application::next_run_at(schedule, now));
        run_one(
            app,
            &state,
            &connections,
            timeout,
            schedule,
            RunTrigger::Scheduled,
        )
        .await;
    }
}
