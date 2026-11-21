//! Auto-updates. A release (GitHub, see .github/workflows/release.yml) publishes `latest.json`
//! and an installer signed with the updater key; the public half is in tauri.conf.json, so an
//! update that isn't signed by that key is refused before anything runs.
//!
//! What goes over the network: one GET of `latest.json` from github.com (no account, no id),
//! a while after start and then twice a day, only if "Check for updates automatically" is on.
//! The installer is only downloaded when the user clicks "Install".

use freetime_core::config::Config;
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

type Res<T> = Result<T, String>;

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Serialize)]
pub struct UpdateStatus {
    pub current: String,
    pub auto: bool,
}

/// Debug builds (cargo run) never update themselves.
const ENABLED: bool = !cfg!(debug_assertions);

async fn find(app: &AppHandle) -> Res<Option<tauri_plugin_updater::Update>> {
    if !ENABLED {
        return Ok(None);
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| format!("Couldn't check for updates: {e}"))
}

/// The background check: quiet on errors (offline, no release yet), an event when there's one.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        loop {
            if Config::load().map(|c| c.check_updates).unwrap_or(false) {
                if let Ok(Some(u)) = tauri::async_runtime::block_on(find(&app)) {
                    let _ = app.emit("update-available", UpdateInfo { version: u.version.clone(), notes: u.body.clone() });
                }
            }
            std::thread::sleep(Duration::from_secs(12 * 3600));
        }
    });
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> Res<UpdateStatus> {
    Ok(UpdateStatus {
        current: app.package_info().version.to_string(),
        auto: Config::load().map_err(|e| e.to_string())?.check_updates,
    })
}

#[tauri::command(async)]
pub fn set_auto_update(enabled: bool) -> Res<()> {
    let mut cfg = Config::load().map_err(|e| e.to_string())?;
    cfg.check_updates = enabled;
    cfg.save().map_err(|e| e.to_string())
}

/// "Check now": the new version, or None when this one is the latest.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Res<Option<UpdateInfo>> {
    Ok(find(&app).await?.map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() }))
}

/// Downloads the signed installer, checks its signature, installs it and restarts.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Res<()> {
    let Some(update) = find(&app).await? else {
        return Err("You already have the latest version".into());
    };
    let mut done = 0usize;
    update
        .download_and_install(
            |chunk, total| {
                done += chunk;
                if let Some(total) = total {
                    let _ = app.emit("update-progress", (done as f64 / total as f64 * 100.0).round() as u32);
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("The update failed: {e}"))?;
    // On Windows the plugin has already exited to run the installer, so this line only runs on
    // macOS and Linux, where the new version starts on the next launch.
    app.restart();
}
