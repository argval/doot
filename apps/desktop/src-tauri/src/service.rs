use serde::Serialize;
use std::{path::PathBuf, process::Stdio};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    time::{timeout, Duration},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConnection {
    pub origin: String,
    pub token: String,
}

#[derive(Default)]
pub struct GatewayManager {
    child: Option<Child>,
    connection: Option<GatewayConnection>,
}

pub fn lock_instance(path: &std::path::Path) -> Result<std::fs::File, String> {
    let file = std::fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|_| "Doot is already open, or its application data is locked.".to_string())?;
    Ok(file)
}

impl GatewayManager {
    pub async fn ensure(&mut self, app: &AppHandle) -> Result<GatewayConnection, String> {
        if app
            .state::<crate::AppState>()
            .exiting
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Doot is quitting.".into());
        }
        if let Some(child) = &mut self.child {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return self
                    .connection
                    .clone()
                    .ok_or("Caption service is starting".into());
            }
        }
        self.child = None;
        self.connection = None;
        let (node, entry, migrations) = gateway_paths(app)?;
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let sarvam = read_key("sarvam")?;
        let gemini = read_key("gemini")?;
        let mut command = Command::new(node);
        if cfg!(debug_assertions) {
            command.args(["--import", "tsx"]);
        }
        command
            .arg(entry)
            .arg("--managed")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Do not inherit runtime-injection flags or provider credentials from the shell.
        for name in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "SARVAM_API_KEY",
            "GEMINI_API_KEY",
            "DOOT_GATEWAY_TOKEN",
            "DOOT_ALLOW_UNAUTHENTICATED",
        ] {
            command.env_remove(name);
        }
        if cfg!(debug_assertions) {
            command.current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
        }
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| "Could not start the bundled caption service. Reinstall Doot or check your development runtime.".to_string())?;
        let startup = serde_json::json!({ "authToken": token, "dbPath": data.join("doot.db"), "migrationsFolder": migrations, "sarvamApiKey": sarvam, "geminiApiKey": gemini });
        child
            .stdin
            .as_mut()
            .ok_or("Caption service input unavailable")?
            .write_all(format!("{startup}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Caption service output unavailable")?;
        let mut lines = BufReader::new(stdout).lines();
        let ready = timeout(Duration::from_secs(12), lines.next_line()).await
            .map_err(|_| "Caption service startup timed out")?.map_err(|e| e.to_string())?
            .ok_or("Caption service exited during startup. Its local database or bundled runtime may be unavailable.")?;
        let ready: serde_json::Value =
            serde_json::from_str(&ready).map_err(|_| "Invalid caption service startup response")?;
        let port = ready
            .get("port")
            .and_then(|p| p.as_u64())
            .filter(|p| *p > 0 && *p <= 65535)
            .ok_or("Invalid caption service port")?;
        let connection = GatewayConnection {
            origin: format!("http://127.0.0.1:{port}"),
            token,
        };
        self.child = Some(child);
        self.connection = Some(connection.clone());
        Ok(connection)
    }

    pub async fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            if let Some(mut input) = child.stdin.take() {
                let _ = input.write_all(b"stop\n").await;
            }
            if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        }
        self.connection = None;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_one_app_instance_can_own_the_local_history() {
        let path =
            std::env::temp_dir().join(format!("doot-instance-{}.lock", uuid::Uuid::new_v4()));
        let first = super::lock_instance(&path).unwrap();
        assert!(super::lock_instance(&path).is_err());
        drop(first);
        assert!(super::lock_instance(&path).is_ok());
        std::fs::remove_file(path).unwrap();
    }
}

fn gateway_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        Ok((
            PathBuf::from("node"),
            root.join("services/gateway/src/main.ts"),
            root.join("packages/db/drizzle"),
        ))
    } else {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let node = executable
            .parent()
            .ok_or("Doot executable directory unavailable")?
            .join(if cfg!(windows) {
                "doot-node.exe"
            } else {
                "doot-node"
            });
        let resources = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("gateway");
        Ok((node, resources.join("main.mjs"), resources.join("drizzle")))
    }
}

fn key_entry(provider: &str) -> Result<keyring::Entry, String> {
    if !["sarvam", "gemini"].contains(&provider) {
        return Err("Unknown speech service".into());
    }
    keyring::Entry::new("app.doot.desktop", provider)
        .map_err(|_| "OS credential storage is unavailable".into())
}

fn read_key(provider: &str) -> Result<Option<String>, String> {
    match key_entry(provider)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Allow Doot to read its saved key in your OS credential store.".into()),
    }
}

#[tauri::command]
pub async fn gateway_connection(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<GatewayConnection, String> {
    state.gateway.lock().await.ensure(&app).await
}

#[tauri::command]
pub fn credential_status() -> Result<serde_json::Value, String> {
    Ok(
        serde_json::json!({ "sarvam": read_key("sarvam")?.is_some(), "gemini": read_key("gemini")?.is_some() }),
    )
}

#[tauri::command]
pub async fn save_service_key(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    let mut gateway = state.gateway.lock().await;
    if state
        .audio_engine
        .lock()
        .map_err(|_| "Audio engine unavailable")?
        .is_active()
    {
        return Err("Stop captions before changing service keys.".into());
    }
    let key = key.trim();
    if key.len() > 8192 || key.contains(['\r', '\n']) {
        return Err("Enter a valid API key.".into());
    }
    let entry = key_entry(&provider)?;
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("Could not remove the saved key.".into()),
        }
    } else {
        entry
            .set_password(key)
            .map_err(|_| "Could not save the key in OS credential storage.")?;
    }
    gateway.stop().await;
    gateway.ensure(&app).await?;
    Ok(())
}
