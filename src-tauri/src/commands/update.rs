use crate::modules::update_checker::{self, UpdateInfo, UpdateSettings, VersionJumpInfo};

/// Check for updates from GitHub
#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    update_checker::check_for_updates().await
}

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

/// Check if a version jump occurred (for post-update changelog display)
#[tauri::command]
pub async fn check_version_jump() -> Result<Option<VersionJumpInfo>, String> {
    update_checker::check_version_jump().await
}
