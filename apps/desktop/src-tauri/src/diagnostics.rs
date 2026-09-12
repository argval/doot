use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, sync::Mutex};
use tauri::State;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingSample {
    provider: String,
    #[serde(rename = "final")]
    is_final: bool,
    pipeline_ms: f64,
    desktop_ms: f64,
    estimated_display_lag_ms: f64,
}

#[derive(Default)]
pub struct Timings(Mutex<VecDeque<TimingSample>>);

#[tauri::command]
pub fn record_caption_timing(
    state: State<'_, Timings>,
    sample: TimingSample,
) -> Result<(), String> {
    if sample.provider.len() > 32
        || ![
            sample.pipeline_ms,
            sample.desktop_ms,
            sample.estimated_display_lag_ms,
        ]
        .iter()
        .all(|ms| ms.is_finite() && *ms >= 0.0 && *ms <= 120_000.0)
    {
        return Err("Invalid timing sample".into());
    }
    let mut samples = state
        .0
        .lock()
        .map_err(|_| "Timing diagnostics unavailable")?;
    if samples.len() == 500 {
        samples.pop_front();
    }
    samples.push_back(sample);
    Ok(())
}

#[tauri::command]
pub fn caption_timings(state: State<'_, Timings>) -> Result<Vec<TimingSample>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "Timing diagnostics unavailable")?
        .iter()
        .cloned()
        .collect())
}
