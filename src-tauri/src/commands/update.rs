use crate::modules::logger;
use crate::modules::update_checker::{self, UpdateSettings, VersionJumpInfo};

/// Check if we should check for updates (based on interval settings)
#[tauri::command]
pub fn should_check_updates() -> Result<bool, String> {
    let settings = update_checker::load_update_settings()?;
    Ok(update_checker::should_check_for_updates(&settings))
}

/// Update the last check time
#[tauri::command]
pub fn update_last_check_time() -> Result<(), String> {
    update_checker::update_last_check_time()
}

/// Get update settings
#[tauri::command]
pub fn get_update_settings() -> Result<UpdateSettings, String> {
    update_checker::load_update_settings()
}

/// Save update settings
#[tauri::command]
pub fn save_update_settings(settings: UpdateSettings) -> Result<(), String> {
    update_checker::save_update_settings(&settings)
}

/// Save release notes for a downloaded/pending update
#[tauri::command]
pub fn save_pending_update_notes(
    version: String,
    release_notes: String,
    release_notes_zh: String,
) -> Result<(), String> {
    update_checker::save_pending_update_notes(version, release_notes, release_notes_zh)
}

/// Check if a version jump occurred (for post-update changelog display)
#[tauri::command]
pub fn check_version_jump() -> Result<Option<VersionJumpInfo>, String> {
    update_checker::check_version_jump()
}

/// Write updater lifecycle logs from frontend into app.log
#[tauri::command]
pub fn update_log(level: String, message: String) -> Result<(), String> {
    let level = level.trim().to_lowercase();
    let message = message.trim();
    if message.is_empty() {
        return Ok(());
    }

    let text = format!("[Updater] {}", message);
    match level.as_str() {
        "error" => logger::log_error(&text),
        "warn" | "warning" => logger::log_warn(&text),
        _ => logger::log_info(&text),
    }

    Ok(())
}
