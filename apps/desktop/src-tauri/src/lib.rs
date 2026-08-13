mod audio;
mod commands;
mod events;
mod stream;

use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

use crate::events::CAPTURE_TOGGLE_EVENT;

const SETTINGS_WINDOW_LABEL: &str = "settings";

pub struct AppState {
    pub audio_engine: Mutex<audio::AudioEngine>,
    pub last_provider: Mutex<Option<String>>,
}

pub(crate) fn remember_provider(app: &AppHandle, provider: &str) {
    let trimmed = provider.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut last_provider) = state.last_provider.lock() {
            *last_provider = Some(trimmed.to_string());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyD);

    let mut builder =
        tauri::Builder::default().plugin(tauri_plugin_store::Builder::default().build());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                            let _ = app.emit(CAPTURE_TOGGLE_EVENT, ());
                        }
                    })
                    .build(),
            )
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(
                WindowStateBuilder::default()
                    .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                    .with_denylist(&[SETTINGS_WINDOW_LABEL])
                    .build(),
            );
    }

    builder
        .manage(AppState {
            audio_engine: Mutex::new(audio::AudioEngine::new()),
            last_provider: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_caption_session,
            commands::stop_caption_session,
            commands::set_overlay_always_on_top,
            commands::audio_capture_status,
            commands::connection_status,
            commands::open_settings_window
        ])
        .menu(|app| {
            let settings_item = MenuItemBuilder::with_id("open-settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let show_item = MenuItemBuilder::with_id("show-overlay", "Show Overlay").build(app)?;
            let app_submenu = SubmenuBuilder::new(app, "Doot")
                .about(None)
                .separator()
                .item(&settings_item)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_submenu = SubmenuBuilder::new(app, "Window")
                .item(&show_item)
                .separator()
                .minimize()
                .build()?;
            MenuBuilder::new(app)
                .items(&[&app_submenu, &edit_submenu, &window_submenu])
                .build()
        })
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if window.label() != SETTINGS_WINDOW_LABEL {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                restore_overlay_layer(window.app_handle());
            }
        })
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                #[cfg(target_os = "macos")]
                let _ = window.set_visible_on_all_workspaces(true);
            }

            let toggle_item =
                MenuItemBuilder::with_id("toggle-capture", "Start / Stop Capturing").build(app)?;
            let show_item = MenuItemBuilder::with_id("show-overlay", "Show Overlay").build(app)?;
            let settings_item = MenuItemBuilder::with_id("open-settings", "Settings").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Doot").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&toggle_item, &show_item, &settings_item, &quit_item])
                .build()?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
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

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open-settings" => {
            let _ = open_settings(app);
        }
        "show-overlay" => show_overlay(app),
        "toggle-capture" => {
            let _ = app.emit(CAPTURE_TOGGLE_EVENT, ());
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

pub(crate) fn open_settings(app: &AppHandle) -> Result<(), String> {
    yield_overlay_layer(app);
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Settings")
    .inner_size(680.0, 520.0)
    .min_inner_size(560.0, 420.0)
    .resizable(true)
    .decorations(true)
    .always_on_top(false)
    .visible(true)
    .build()
    .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let _ = window.set_visible_on_all_workspaces(false);
    let _ = window.set_focus();
    Ok(())
}

fn yield_overlay_layer(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(false);
    }
}

fn restore_overlay_layer(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(true);
        #[cfg(target_os = "macos")]
        let _ = window.set_visible_on_all_workspaces(true);
    }
}

fn show_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(true);
        #[cfg(target_os = "macos")]
        let _ = window.set_visible_on_all_workspaces(true);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
