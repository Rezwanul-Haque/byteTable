//! Tauri command handler for the app-metrics slice (M33). Deserialize →
//! use-case → serialize; no logic lives here.

use std::sync::Mutex;

use tauri::State;

use crate::shared::error::AppError;

use super::application::{AppMetrics, MetricsSampler};

/// The sampler, kept alive between calls so CPU has a baseline to diff against.
#[derive(Default)]
pub struct AppMetricsState {
    sampler: Mutex<MetricsSampler>,
}

/// ByteTable's own CPU and resident memory right now.
#[tauri::command]
pub async fn app_metrics_read(state: State<'_, AppMetricsState>) -> Result<AppMetrics, AppError> {
    // A cold read has no baseline, so prime it, wait out the shortest interval
    // sysinfo considers meaningful, and only then take the sample the renderer
    // sees. The two locks are deliberately separate: a std Mutex guard must not
    // be held across the await.
    let primed = state.sampler.lock().unwrap().prime_if_stale();
    if primed {
        tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
    }
    let metrics = state.sampler.lock().unwrap().read();
    Ok(metrics)
}
