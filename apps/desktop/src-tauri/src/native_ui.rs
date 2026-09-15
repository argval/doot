//! Small C bridge to the macOS views. Business operations stay in the existing UI controller.
use tauri::{AppHandle, WebviewWindow};
#[cfg(not(target_os = "macos"))]
use tauri::Emitter;

#[cfg(target_os = "macos")]
mod mac {
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        sync::OnceLock,
    };
    use tauri::{AppHandle, Emitter};
    static APP: OnceLock<AppHandle> = OnceLock::new();
    extern "C" {
        fn doot_native_init(callback: extern "C" fn(*const c_char));
        pub fn doot_native_open();
        pub fn doot_native_ready();
        fn doot_native_receive(json: *const c_char);
        pub fn doot_native_picker(window: *mut c_void, json: *const c_char);
        pub fn doot_native_about();
        pub fn doot_native_attach_overlay(window: *mut c_void);
    }
    extern "C" fn request(json: *const c_char) {
        if json.is_null() {
            return;
        }
        // Swift owns this UTF-8 string until this callback returns. Never log key payloads.
        let Ok(value) =
            serde_json::from_slice::<serde_json::Value>(unsafe { CStr::from_ptr(json) }.to_bytes())
        else {
            return;
        };
        if let Some(app) = APP.get() {
            let _ = app.emit_to("main", "native-ui://request", value);
        }
    }
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        unsafe {
            doot_native_init(request);
        }
    }
    pub fn receive(value: serde_json::Value) {
        if let Ok(json) = CString::new(value.to_string()) {
            unsafe {
                doot_native_receive(json.as_ptr());
            }
        }
    }
}

pub fn init(_app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::init(_app);
}

#[cfg(target_os = "macos")]
pub fn open(app: &AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| unsafe {
        mac::doot_native_open();
    })
    .map_err(|e| e.to_string())
}

pub fn attach_overlay(window: &WebviewWindow) {
    crate::overlay_chrome::clamp_overlay_size(window);
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = window.ns_window() {
        unsafe {
            mac::doot_native_attach_overlay(ptr as *mut std::ffi::c_void);
        }
    }
}

#[tauri::command]
pub fn native_ui_ready(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the overlay controller can connect native views.".into());
    }
    crate::overlay_chrome::clamp_overlay_size(&window);
    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;
        let ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
        return app
            .run_on_main_thread(move || unsafe {
                mac::doot_native_ready();
                mac::doot_native_attach_overlay(ptr as *mut c_void);
            })
            .map_err(|e| e.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub fn native_ui_receive(
    app: AppHandle,
    window: WebviewWindow,
    value: serde_json::Value,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the overlay controller can update native views.".into());
    }
    #[cfg(target_os = "macos")]
    return app
        .run_on_main_thread(move || mac::receive(value))
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, value);
        Ok(())
    }
}

#[tauri::command]
pub fn show_native_language_picker(
    app: AppHandle,
    window: WebviewWindow,
    value: serde_json::Value,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Language controls belong to the overlay.".into());
    }
    if caption_session_active(app.clone())? {
        return Err("Stop capture before changing languages.".into());
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        let json = CString::new(value.to_string()).map_err(|e| e.to_string())?;
        let ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
        app.run_on_main_thread(move || unsafe {
            mac::doot_native_picker(ptr as *mut _, json.as_ptr());
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, value);
        Err("Native language picker is available on macOS.".into())
    }
}

#[tauri::command]
pub fn show_native_about(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return app
        .run_on_main_thread(|| unsafe {
            mac::doot_native_about();
        })
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app.emit("settings://section", "about");
        crate::open_settings(&app)
    }
}

#[tauri::command]
pub async fn export_document(
    app: AppHandle,
    window: WebviewWindow,
    filename: String,
    format: String,
    body: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    if !matches!(format.as_str(), "txt" | "srt" | "json")
        || filename.len() > 240
        || filename.contains(['/', '\\'])
        || body.len() > 64 * 1024 * 1024
    {
        return Err("Invalid caption export.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(&filename)
            .add_filter("Caption export", &[&format])
            .blocking_save_file();
        let Some(path) = selection else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        use std::io::Write;
        let temporary = path.with_file_name(format!(".doot-{}.tmp", uuid::Uuid::new_v4()));
        let saved = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(body.as_bytes())?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &path)
        })();
        if let Err(error) = saved {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("Could not save export: {error}"));
        }
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn confirm_destructive(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
    message: String,
    action: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if title.len() > 200 || message.len() > 2000 || action.len() > 80 {
        return Err("Invalid confirmation.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .parent(&window)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                action,
                "Cancel".into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn update_capture_menu(app: &AppHandle, state: &str) {
    use tauri::Manager;
    let (label, enabled, tooltip) = match state {
        "starting" => ("Starting Captions…", false, "Doot · Starting captions"),
        "capturing" | "reconnecting" => ("Stop Capturing", true, "Doot · Captions running"),
        "finalizing" => ("Finalizing Captions…", false, "Doot · Finalizing captions"),
        "idle" | "error" => ("Start Capturing", true, "Doot · Captions stopped"),
        _ => return,
    };
    if let Some(items) = app.try_state::<crate::CaptureMenuItems>() {
        if let Ok(items) = items.0.lock() {
            for item in items.iter() {
                let _ = item.set_text(label);
                let _ = item.set_enabled(enabled);
            }
        }
    }
    if let Some(tray) = app.tray_by_id("doot") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

#[cfg(target_os = "macos")]
pub fn menu_bar_icon() -> tauri::image::Image<'static> {
    // A 22pt template speech bubble with two caption lines, drawn at 2x.
    let mut rgba = vec![0; 44 * 44 * 4];
    for y in 0..44usize {
        for x in 0..44usize {
            let bubble = (5..39).contains(&x) && (8..34).contains(&y);
            let inside = (8..36).contains(&x) && (11..31).contains(&y);
            let tail = (10..17).contains(&x) && (32..39).contains(&y) && x + y < 49;
            let line = (12..32).contains(&x) && ((16..19).contains(&y) || (24..27).contains(&y));
            if (bubble && !inside) || tail || line {
                rgba[(y * 44 + x) * 4 + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, 44, 44)
}

#[tauri::command]
pub fn caption_session_active(app: AppHandle) -> Result<bool, String> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let engine = state
        .audio_engine
        .lock()
        .map_err(|_| "Audio engine unavailable")?;
    Ok(engine.is_active() || state.exiting.load(std::sync::atomic::Ordering::SeqCst))
}
