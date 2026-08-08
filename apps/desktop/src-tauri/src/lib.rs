mod audio;
mod commands;
mod events;
mod providers;
mod stream;

use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::events::CAPTURE_TOGGLE_EVENT;

pub struct AppState {
    pub audio_engine: Mutex<audio::AudioEngine>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyD);

    let builder = tauri::Builder::default();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                    let _ = app.emit(CAPTURE_TOGGLE_EVENT, ());
                }
            })
            .build(),
    );

    builder
        .manage(AppState {
            audio_engine: Mutex::new(audio::AudioEngine::new()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_caption_session,
            commands::stop_caption_session,
            commands::set_overlay_always_on_top,
            commands::audio_capture_status
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                #[cfg(target_os = "macos")]
                let _ = window.set_visible_on_all_workspaces(true);
            }

            let toggle_item =
                MenuItemBuilder::with_id("toggle-capture", "Start / Stop Capturing").build(app)?;
            let show_item = MenuItemBuilder::with_id("show-overlay", "Show Overlay").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Doot").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&toggle_item, &show_item, &quit_item])
                .build()?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle-capture" => {
                        let _ = app.emit(CAPTURE_TOGGLE_EVENT, ());
                    }
                    "show-overlay" => show_overlay(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_overlay(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app.global_shortcut().register(toggle_shortcut)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Doot");
}

fn show_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(true);
        #[cfg(target_os = "macos")]
        let _ = window.set_visible_on_all_workspaces(true);
        let _ = window.unminimize();
        let _ = window.show();
    }
}
