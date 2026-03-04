mod commands;
pub mod error;
mod models;
mod modules;
mod utils;

use modules::config::CloseWindowBehavior;
use modules::logger;
use std::sync::OnceLock;
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::WindowEvent;
use tauri::{Emitter, Manager};
use tracing::info;

/// 全局 AppHandle 存储
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// 获取全局 AppHandle
pub fn get_app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

#[cfg(target_os = "macos")]
fn apply_macos_activation_policy(app: &tauri::AppHandle) {
    let config = modules::config::get_user_config();
    let (policy, dock_visible, policy_label) = if config.hide_dock_icon {
        (ActivationPolicy::Accessory, false, "hidden")
    } else {
        (ActivationPolicy::Regular, true, "visible")
    };

    if let Err(err) = app.set_activation_policy(policy) {
        logger::log_warn(&format!("[Window] 设置 macOS 激活策略失败: {}", err));
        return;
    }

    if let Err(err) = app.set_dock_visibility(dock_visible) {
        logger::log_warn(&format!("[Window] 设置 macOS Dock 可见性失败: {}", err));
    }

    if dock_visible {
        let _ = app.show();
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
        }
    }

    info!("[Window] 已应用 macOS Dock 图标策略: {}", policy_label);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logger::init_logger();

    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            logger::log_info("[Linux] 设置 WEBKIT_DISABLE_DMABUF_RENDERER=1");
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.get_webview_window("main").map(|window| {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            });
        }))
        .setup(|app| {
            info!("Cockpit Tools 启动...");

            // 存储全局 AppHandle
            let _ = APP_HANDLE.set(app.handle().clone());

            // 初始化 Updater 插件
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle()
                    .plugin(tauri_plugin_process::init())?;
                info!("[Updater] Tauri Updater + Process 插件已初始化");
            }

            // 启动时同步：读取共享配置文件，与本地配置比较时间戳后合并
            {
                let current_config = modules::config::get_user_config();
                if let Some(merged_language) = modules::sync_settings::merge_setting_on_startup(
                    "language",
                    &current_config.language,
                    None, // 本地暂无更新时间记录，始终以共享文件为准
                ) {
                    info!(
                        "[SyncSettings] 启动时合并语言设置: {} -> {}",
                        current_config.language, merged_language
                    );
                    let new_config = modules::config::UserConfig {
                        language: merged_language,
                        ..current_config
                    };
                    if let Err(e) = modules::config::save_user_config(&new_config) {
                        logger::log_error(&format!("[SyncSettings] 保存合并后的配置失败: {}", e));
                    }
                }
            }

            // 启动 WebSocket 服务（使用 Tauri 的 async runtime）
            tauri::async_runtime::spawn(async {
                modules::websocket::start_server().await;
            });

            #[cfg(target_os = "macos")]
            apply_macos_activation_policy(&app.handle());

            // 初始化系统托盘
            if let Err(e) = modules::tray::create_tray(app.handle()) {
                logger::log_error(&format!("[Tray] 创建系统托盘失败: {}", e));
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let config = modules::config::get_user_config();

                match config.close_behavior {
                    CloseWindowBehavior::Minimize => {
                        // 直接最小化到托盘
                        api.prevent_close();
                        let _ = window.hide();
                        info!("[Window] 窗口已最小化到托盘");
                    }
                    CloseWindowBehavior::Quit => {
                        // 直接退出，不阻止关闭
                        info!("[Window] 用户选择退出应用");
                    }
                    CloseWindowBehavior::Ask => {
                        // 需要询问用户，阻止关闭并发送事件到前端
                        api.prevent_close();
                        let _ = window.emit("window:close_requested", ());
                        info!("[Window] 等待用户选择关闭行为");
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            // Account Commands
            commands::account::list_accounts,
            commands::account::add_account,
            commands::account::delete_account,
            commands::account::delete_accounts,
            commands::account::reorder_accounts,
            commands::account::get_current_account,
            commands::account::set_current_account,
            commands::account::fetch_account_quota,
            commands::account::refresh_all_quotas,
            commands::account::refresh_current_quota,
            commands::account::switch_account,
            commands::account::bind_account_fingerprint,
            commands::account::get_bound_accounts,
            commands::account::update_account_tags,
            commands::account::sync_current_from_client,
            commands::account::sync_from_extension,
            // Device Commands
            commands::device::get_device_profiles,
            commands::device::bind_device_profile,
            commands::device::bind_device_profile_with_profile,
            commands::device::list_device_versions,
            commands::device::restore_device_version,
            commands::device::delete_device_version,
            commands::device::restore_original_device,
            commands::device::open_device_folder,
            commands::device::preview_generate_profile,
            commands::device::preview_current_profile,
            // Fingerprint Commands
            commands::device::list_fingerprints,
            commands::device::get_fingerprint,
            commands::device::generate_new_fingerprint,
            commands::device::capture_current_fingerprint,
            commands::device::create_fingerprint_with_profile,
            commands::device::apply_fingerprint,
            commands::device::delete_fingerprint,
            commands::device::delete_unbound_fingerprints,
            commands::device::rename_fingerprint,
            commands::device::get_current_fingerprint_id,
            // OAuth Commands
            commands::oauth::start_oauth_login,
            commands::oauth::prepare_oauth_url,
            commands::oauth::complete_oauth_login,
            commands::oauth::cancel_oauth_login,
            // Import/Export Commands
            commands::import::import_from_old_tools,
            commands::import::import_fingerprints_from_old_tools,
            commands::import::import_fingerprints_from_json,
            commands::import::import_from_local,
            commands::import::import_from_json,
            commands::import::export_accounts,
            // System Commands
            commands::system::open_data_folder,
            commands::system::save_text_file,
            commands::system::get_downloads_dir,
            commands::system::get_network_config,
            commands::system::save_network_config,
            commands::system::get_general_config,
            commands::system::save_general_config,
            commands::system::save_tray_platform_layout,
            commands::system::set_app_path,
            commands::system::detect_app_path,
            commands::system::set_wakeup_override,
            commands::system::handle_window_close,
            commands::system::open_folder,
            commands::system::delete_corrupted_file,
            // Wakeup Commands
            commands::wakeup::wakeup_ensure_runtime_ready,
            commands::wakeup::trigger_wakeup,
            commands::wakeup::fetch_available_models,
            commands::wakeup::wakeup_sync_state,
            commands::wakeup::wakeup_load_history,
            commands::wakeup::wakeup_add_history,
            commands::wakeup::wakeup_clear_history,
            commands::wakeup::wakeup_verification_load_state,
            commands::wakeup::wakeup_verification_load_history,
            commands::wakeup::wakeup_verification_delete_history,
            commands::wakeup::wakeup_verification_run_batch,
            // Update Commands
            commands::update::should_check_updates,
            commands::update::update_last_check_time,
            commands::update::get_update_settings,
            commands::update::save_update_settings,
            commands::update::save_pending_update_notes,
            commands::update::check_version_jump,
            commands::update::update_log,
            // Announcement Commands
            commands::announcement::announcement_get_state,
            commands::announcement::announcement_mark_as_read,
            commands::announcement::announcement_mark_all_as_read,
            commands::announcement::announcement_force_refresh,
            // Group Commands
            commands::group::get_group_settings,
            commands::group::save_group_settings,
            commands::group::set_model_group,
            commands::group::remove_model_group,
            commands::group::set_group_name,
            commands::group::delete_group,
            commands::group::update_group_order,
            commands::group::get_display_groups,
            // Codex Commands
            commands::codex::list_codex_accounts,
            commands::codex::get_current_codex_account,
            commands::codex::switch_codex_account,
            commands::codex::delete_codex_account,
            commands::codex::delete_codex_accounts,
            commands::codex::import_codex_from_local,
            commands::codex::import_codex_from_json,
            commands::codex::export_codex_accounts,
            commands::codex::refresh_codex_quota,
            commands::codex::refresh_all_codex_quotas,
            commands::codex::refresh_current_codex_quota,
            commands::codex::codex_oauth_login_start,
            commands::codex::codex_oauth_login_completed,
            commands::codex::codex_oauth_login_cancel,
            commands::codex::add_codex_account_with_token,
            commands::codex::is_codex_oauth_port_in_use,
            commands::codex::close_codex_oauth_port,
            commands::codex::update_codex_account_tags,
            // GitHub Copilot Commands
            commands::github_copilot::list_github_copilot_accounts,
            commands::github_copilot::delete_github_copilot_account,
            commands::github_copilot::delete_github_copilot_accounts,
            commands::github_copilot::import_github_copilot_from_json,
            commands::github_copilot::export_github_copilot_accounts,
            commands::github_copilot::refresh_github_copilot_token,
            commands::github_copilot::refresh_all_github_copilot_tokens,
            commands::github_copilot::github_copilot_oauth_login_start,
            commands::github_copilot::github_copilot_oauth_login_complete,
            commands::github_copilot::github_copilot_oauth_login_cancel,
            commands::github_copilot::add_github_copilot_account_with_token,
            commands::github_copilot::update_github_copilot_account_tags,
            commands::github_copilot::get_github_copilot_accounts_index_path,
            commands::github_copilot::inject_github_copilot_to_vscode,
            // GitHub Copilot Instance Commands
            commands::github_copilot_instance::github_copilot_get_instance_defaults,
            commands::github_copilot_instance::github_copilot_list_instances,
            commands::github_copilot_instance::github_copilot_create_instance,
            commands::github_copilot_instance::github_copilot_update_instance,
            commands::github_copilot_instance::github_copilot_delete_instance,
            commands::github_copilot_instance::github_copilot_start_instance,
            commands::github_copilot_instance::github_copilot_stop_instance,
            commands::github_copilot_instance::github_copilot_open_instance_window,
            commands::github_copilot_instance::github_copilot_close_all_instances,
            // Windsurf Commands
            commands::windsurf::list_windsurf_accounts,
            commands::windsurf::delete_windsurf_account,
            commands::windsurf::delete_windsurf_accounts,
            commands::windsurf::import_windsurf_from_json,
            commands::windsurf::import_windsurf_from_local,
            commands::windsurf::export_windsurf_accounts,
            commands::windsurf::refresh_windsurf_token,
            commands::windsurf::refresh_all_windsurf_tokens,
            commands::windsurf::windsurf_oauth_login_start,
            commands::windsurf::windsurf_oauth_login_complete,
            commands::windsurf::windsurf_oauth_login_cancel,
            commands::windsurf::add_windsurf_account_with_token,
            commands::windsurf::add_windsurf_account_with_password,
            commands::windsurf::update_windsurf_account_tags,
            commands::windsurf::get_windsurf_accounts_index_path,
            commands::windsurf::inject_windsurf_to_vscode,
            // Kiro Commands
            commands::kiro::list_kiro_accounts,
            commands::kiro::delete_kiro_account,
            commands::kiro::delete_kiro_accounts,
            commands::kiro::import_kiro_from_json,
            commands::kiro::import_kiro_from_local,
            commands::kiro::export_kiro_accounts,
            commands::kiro::refresh_kiro_token,
            commands::kiro::refresh_all_kiro_tokens,
            commands::kiro::kiro_oauth_login_start,
            commands::kiro::kiro_oauth_login_complete,
            commands::kiro::kiro_oauth_login_cancel,
            commands::kiro::add_kiro_account_with_token,
            commands::kiro::update_kiro_account_tags,
            commands::kiro::get_kiro_accounts_index_path,
            commands::kiro::inject_kiro_to_vscode,
            // Windsurf Instance Commands
            commands::windsurf_instance::windsurf_get_instance_defaults,
            commands::windsurf_instance::windsurf_list_instances,
            commands::windsurf_instance::windsurf_create_instance,
            commands::windsurf_instance::windsurf_update_instance,
            commands::windsurf_instance::windsurf_delete_instance,
            commands::windsurf_instance::windsurf_start_instance,
            commands::windsurf_instance::windsurf_stop_instance,
            commands::windsurf_instance::windsurf_open_instance_window,
            commands::windsurf_instance::windsurf_close_all_instances,
            // Kiro Instance Commands
            commands::kiro_instance::kiro_get_instance_defaults,
            commands::kiro_instance::kiro_list_instances,
            commands::kiro_instance::kiro_create_instance,
            commands::kiro_instance::kiro_update_instance,
            commands::kiro_instance::kiro_delete_instance,
            commands::kiro_instance::kiro_start_instance,
            commands::kiro_instance::kiro_stop_instance,
            commands::kiro_instance::kiro_open_instance_window,
            commands::kiro_instance::kiro_close_all_instances,
            // Codex Instance Commands
            commands::codex_instance::codex_get_instance_defaults,
            commands::codex_instance::codex_list_instances,
            commands::codex_instance::codex_create_instance,
            commands::codex_instance::codex_update_instance,
            commands::codex_instance::codex_delete_instance,
            commands::codex_instance::codex_start_instance,
            commands::codex_instance::codex_stop_instance,
            commands::codex_instance::codex_open_instance_window,
            commands::codex_instance::codex_close_all_instances,
            // Instance Commands
            commands::instance::get_instance_defaults,
            commands::instance::list_instances,
            commands::instance::create_instance,
            commands::instance::update_instance,
            commands::instance::delete_instance,
            commands::instance::start_instance,
            commands::instance::stop_instance,
            commands::instance::open_instance_window,
            commands::instance::close_all_instances,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        {
            if let RunEvent::Reopen { .. } = event {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app_handle, event);
        }
    });
}
