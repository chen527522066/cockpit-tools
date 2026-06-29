use crate::modules::platform_package::{
    self, PlatformPackageState, PlatformPackageUiEntry, PlatformUiDevConfig,
};
use tauri::AppHandle;

#[tauri::command]
pub fn list_platform_packages(app: AppHandle) -> Result<Vec<PlatformPackageState>, String> {
    platform_package::list_platform_packages(&app)
}

#[tauri::command]
pub async fn check_platform_package_update(
    app: AppHandle,
    platform_id: String,
) -> Result<PlatformPackageState, String> {
    let app_for_task = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        platform_package::check_platform_package_update(&app_for_task, platform_id.as_str())
    })
    .await
    .map_err(|err| format!("检查平台包更新任务失败: {}", err))?
}

#[tauri::command]
pub async fn prepare_platform_package_updates(
    app: AppHandle,
) -> Result<Vec<PlatformPackageState>, String> {
    let app_for_task = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        platform_package::prepare_platform_package_updates(&app_for_task)
    })
    .await
    .map_err(|err| format!("预准备平台包任务失败: {}", err))?
}

#[tauri::command]
pub async fn install_platform_package(
    app: AppHandle,
    platform_id: String,
) -> Result<PlatformPackageState, String> {
    let app_for_task = app.clone();
    let state = tauri::async_runtime::spawn_blocking(move || {
        platform_package::install_platform_package(&app_for_task, platform_id.as_str())
    })
    .await
    .map_err(|err| format!("安装平台包任务失败: {}", err))??;
    let _ = crate::modules::tray::update_tray_menu(&app);
    Ok(state)
}

#[tauri::command]
pub async fn update_platform_package(
    app: AppHandle,
    platform_id: String,
) -> Result<PlatformPackageState, String> {
    let app_for_task = app.clone();
    let state = tauri::async_runtime::spawn_blocking(move || {
        platform_package::update_platform_package(&app_for_task, platform_id.as_str())
    })
    .await
    .map_err(|err| format!("更新平台包任务失败: {}", err))??;
    let _ = crate::modules::tray::update_tray_menu(&app);
    Ok(state)
}

#[tauri::command]
pub async fn reload_platform_package(
    app: AppHandle,
    platform_id: String,
) -> Result<PlatformPackageState, String> {
    let app_for_task = app.clone();
    let state = tauri::async_runtime::spawn_blocking(move || {
        platform_package::reload_platform_package(&app_for_task, platform_id.as_str())
    })
    .await
    .map_err(|err| format!("重载平台包任务失败: {}", err))??;
    let _ = crate::modules::tray::update_tray_menu(&app);
    Ok(state)
}

#[tauri::command]
pub async fn uninstall_platform_package(
    app: AppHandle,
    platform_id: String,
) -> Result<PlatformPackageState, String> {
    let app_for_task = app.clone();
    let state = tauri::async_runtime::spawn_blocking(move || {
        platform_package::uninstall_platform_package(Some(&app_for_task), platform_id.as_str())
    })
    .await
    .map_err(|err| format!("卸载平台包任务失败: {}", err))??;
    let _ = crate::modules::tray::update_tray_menu(&app);
    Ok(state)
}

#[tauri::command]
pub fn get_platform_package_ui_entry(
    platform_id: String,
) -> Result<PlatformPackageUiEntry, String> {
    platform_package::get_platform_package_ui_entry(platform_id.as_str())
}

#[tauri::command]
pub fn get_platform_ui_dev_config() -> PlatformUiDevConfig {
    platform_package::get_platform_ui_dev_config()
}
