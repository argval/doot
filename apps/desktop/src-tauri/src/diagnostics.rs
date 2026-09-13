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
pub struct Timings {
    captions: Mutex<VecDeque<TimingSample>>,
    translations: Mutex<VecDeque<TranslationTimingSample>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationTimingEvent {
    speech_provider: String,
    translation_provider: String,
    source_language: String,
    target_language: String,
    urgency: String,
    outcome: String,
    source_received_at_ms: f64,
    queued_at_ms: f64,
    request_started_at_ms: Option<f64>,
    completed_at_ms: f64,
    caption_emitted_at_ms: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationTimingSample {
    speech_provider: String,
    translation_provider: String,
    source_language: String,
    target_language: String,
    urgency: String,
    outcome: String,
    queue_ms: f64,
    request_ms: Option<f64>,
    source_to_complete_ms: f64,
    completion_to_caption_ms: Option<f64>,
}

impl Timings {
    pub fn record_translation(&self, value: serde_json::Value) -> Result<(), String> {
        let event: TranslationTimingEvent =
            serde_json::from_value(value).map_err(|e| e.to_string())?;
        let start = event.request_started_at_ms.unwrap_or(event.completed_at_ms);
        let end = event.caption_emitted_at_ms.unwrap_or(event.completed_at_ms);
        let times = [
            event.source_received_at_ms,
            event.queued_at_ms,
            start,
            event.completed_at_ms,
            end,
        ];
        if !times.iter().all(|ms| ms.is_finite() && *ms >= 0.0)
            || times.windows(2).any(|pair| pair[0] > pair[1])
            || [
                &event.speech_provider,
                &event.translation_provider,
                &event.source_language,
                &event.target_language,
            ]
            .iter()
            .any(|label| label.is_empty() || label.len() > 32)
            || !matches!(event.urgency.as_str(), "draft" | "final")
            || !matches!(
                event.outcome.as_str(),
                "success" | "error" | "timeout" | "cancelled" | "reused"
            )
        {
            return Err("Invalid translation timing".into());
        }
        let sample = TranslationTimingSample {
            speech_provider: event.speech_provider,
            translation_provider: event.translation_provider,
            source_language: event.source_language,
            target_language: event.target_language,
            urgency: event.urgency,
            outcome: event.outcome,
            queue_ms: start - event.queued_at_ms,
            request_ms: event
                .request_started_at_ms
                .map(|start| event.completed_at_ms - start),
            source_to_complete_ms: event.completed_at_ms - event.source_received_at_ms,
            completion_to_caption_ms: event
                .caption_emitted_at_ms
                .map(|end| end - event.completed_at_ms),
        };
        let mut samples = self
            .translations
            .lock()
            .map_err(|_| "Timing diagnostics unavailable")?;
        if samples.len() == 500 {
            samples.pop_front();
        }
        samples.push_back(sample);
        Ok(())
    }
}

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
        .captions
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
        .captions
        .lock()
        .map_err(|_| "Timing diagnostics unavailable")?
        .iter()
        .cloned()
        .collect())
}

#[tauri::command]
pub fn translation_timings(
    state: State<'_, Timings>,
) -> Result<Vec<TranslationTimingSample>, String> {
    Ok(state
        .translations
        .lock()
        .map_err(|_| "Timing diagnostics unavailable")?
        .iter()
        .cloned()
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translation_samples_keep_failures_bound_memory_and_strip_identifiers() {
        let timings = Timings::default();
        let mut event = serde_json::json!({
            "sessionId": "private", "utteranceId": "private:1", "sourceRevision": 2,
            "speechProvider": "sarvam", "translationProvider": "gemini",
            "sourceLanguage": "en", "targetLanguage": "es", "urgency": "final", "outcome": "timeout",
            "sourceReceivedAtMs": 10, "queuedAtMs": 20, "requestStartedAtMs": 120,
            "completedAtMs": 520, "captionEmittedAtMs": 525
        });
        for _ in 0..501 {
            timings.record_translation(event.clone()).unwrap();
        }
        let samples = timings.translations.lock().unwrap();
        assert_eq!(samples.len(), 500);
        let sample = serde_json::to_value(&samples[0]).unwrap();
        assert_eq!(sample["queueMs"], 100.0);
        assert_eq!(sample["requestMs"], 400.0);
        assert_eq!(sample["outcome"], "timeout");
        assert!(sample.get("sessionId").is_none());
        assert!(sample.get("utteranceId").is_none());
        drop(samples);
        event["completedAtMs"] = serde_json::json!(100);
        assert!(timings.record_translation(event).is_err());
    }
}
