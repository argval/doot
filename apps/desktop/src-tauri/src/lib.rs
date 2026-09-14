mod audio;
mod commands;
mod diagnostics;
mod events;
mod overlay_chrome;
mod service;
mod stream;

use std::sync::atomic::{AtomicBool, Ordering};
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
    pub gateway: tokio::sync::Mutex<service::GatewayManager>,
    pub click_through: AtomicBool,
    pub exiting: AtomicBool,
    pub exit_ready: AtomicBool,
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
    #[cfg(all(
        not(any(target_os = "android", target_os = "ios")),
        target_os = "macos"
    ))]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyD);
    #[cfg(all(
        not(any(target_os = "android", target_os = "ios")),
        not(target_os = "macos")
    ))]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let interaction_shortcut = Shortcut::new(
        Some(if cfg!(target_os = "macos") {
            Modifiers::SUPER | Modifiers::SHIFT
        } else {
            Modifiers::CONTROL | Modifiers::SHIFT
        }),
        Code::KeyO,
    );

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
                        if shortcut == &interaction_shortcut
                            && event.state() == ShortcutState::Pressed
                        {
                            let enabled =
                                !app.state::<AppState>().click_through.load(Ordering::SeqCst);
                            let _ = commands::set_overlay_click_through(app.clone(), enabled);
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
        .manage(diagnostics::Timings::default())
        .manage(AppState {
            audio_engine: Mutex::new(audio::AudioEngine::new()),
            last_provider: Mutex::new(None),
            gateway: tokio::sync::Mutex::new(service::GatewayManager::default()),
            click_through: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_caption_session,
            commands::stop_caption_session,
            commands::set_overlay_always_on_top,
            commands::audio_capture_status,
            commands::check_system_audio,
            commands::connection_status,
            diagnostics::caption_timings,
            diagnostics::translation_timings,
            diagnostics::record_caption_timing,
            commands::open_audio_settings,
            commands::request_screen_recording,
            commands::open_settings_window,
            service::gateway_connection,
            service::credential_status,
            service::save_service_key,
            commands::set_overlay_click_through,
            commands::move_overlay
        ])
        .menu(|app| {
            let settings_item = MenuItemBuilder::with_id("open-settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let overlay_item =
                MenuItemBuilder::with_id("toggle-overlay", "Show / Hide Overlay").build(app)?;
            let app_submenu = SubmenuBuilder::new(app, "Doot")
                .about(None)
                .separator()
                .item(&settings_item)
                .separator()
                .item(&overlay_item)
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
                .item(&overlay_item)
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
            }
        })
        .setup(move |app| {
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let instance = service::lock_instance(&data.join("instance.lock"))?;
            app.manage(instance);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let _ = state.gateway.lock().await.ensure(&handle).await;
            });
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                overlay_chrome::show_overlay_without_activating(&window);
            }

            let toggle_item =
                MenuItemBuilder::with_id("toggle-capture", "Start / Stop Capturing").build(app)?;
            let overlay_item =
                MenuItemBuilder::with_id("toggle-overlay", "Show / Hide Overlay").build(app)?;
            let settings_item = MenuItemBuilder::with_id("open-settings", "Settings").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Doot").build(app)?;
            let unlock_item =
                MenuItemBuilder::with_id("unlock-overlay", "Unlock Overlay").build(app)?;
            let reset_item =
                MenuItemBuilder::with_id("reset-overlay", "Reset Overlay Position").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[
                    &toggle_item,
                    &overlay_item,
                    &unlock_item,
                    &reset_item,
                    &settings_item,
                    &quit_item,
                ])
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
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app.global_shortcut().register(interaction_shortcut)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Doot")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                if state.exit_ready.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                if state.exiting.swap(true, Ordering::SeqCst) {
                    return;
                }
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    if let Ok(mut engine) = state.audio_engine.lock() {
                        engine.request_shutdown();
                    }
                    // A UI stop may already own the completion receiver; wait on the
                    // shared running flag so Quit still lets that stop finish.
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(50), async {
                        loop {
                            if !state
                                .audio_engine
                                .lock()
                                .map(|engine| engine.is_active())
                                .unwrap_or(false)
                            {
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    })
                    .await;
                    state.gateway.lock().await.stop().await;
                    state.exit_ready.store(true, Ordering::SeqCst);
                    app.exit(0);
                });
            }
        });
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open-settings" => {
            let _ = open_settings(app);
        }
        "toggle-overlay" => toggle_overlay(app),
        "unlock-overlay" => {
            let _ = commands::set_overlay_click_through(app.clone(), false);
            show_overlay(app);
        }
        "reset-overlay" => {
            let _ = commands::move_overlay(app.clone(), "reset".into());
        }
        "toggle-capture" => {
            let _ = app.emit(CAPTURE_TOGGLE_EVENT, ());
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

pub(crate) fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Settings")
    .inner_size(780.0, 600.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .decorations(true)
    .always_on_top(false)
    .visible(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    let window = builder.build().map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let _ = window.set_visible_on_all_workspaces(false);
    let _ = window.set_focus();
    Ok(())
}

fn toggle_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        hide_overlay(app);
    } else {
        show_overlay(app);
    }
}

fn hide_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn show_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        overlay_chrome::show_overlay_without_activating(&window);
    }
}
