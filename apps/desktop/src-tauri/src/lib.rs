mod audio;
mod commands;
mod providers;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub audio_engine: Mutex<audio::AudioEngine>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            audio_engine: Mutex::new(audio::AudioEngine::new()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_caption_session,
            commands::stop_caption_session,
            commands::set_overlay_always_on_top,
            commands::audio_capture_status
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(false);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Doot");
}
