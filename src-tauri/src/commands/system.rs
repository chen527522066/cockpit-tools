use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::modules;
use crate::modules::websocket;
use crate::modules::config::{self, UserConfig, CloseWindowBehavior, DEFAULT_WS_PORT};

/// 网络服务配置（前端使用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfig {
    /// WebSocket 是否启用
    pub ws_enabled: bool,
    /// 配置的端口
    pub ws_port: u16,
    /// 实际运行的端口（可能与配置不同）
    pub actual_port: Option<u16>,
    /// 默认端口
    pub default_port: u16,
}

/// 通用设置配置（前端使用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralConfig {
    /// 界面语言
    pub language: String,
    /// 应用主题: "light", "dark", "system"
    pub theme: String,
    /// 自动刷新间隔（分钟），-1 表示禁用
    pub auto_refresh_minutes: i32,
    /// Codex 自动刷新间隔（分钟），-1 表示禁用
    pub codex_auto_refresh_minutes: i32,
    /// GitHub Copilot 自动刷新间隔（分钟），-1 表示禁用
    pub ghcp_auto_refresh_minutes: i32,
    /// 窗口关闭行为: "ask", "minimize", "quit"
    pub close_behavior: String,
    /// OpenCode 启动路径（为空则使用默认路径）
    pub opencode_app_path: String,
    /// Antigravity 启动路径（为空则使用默认路径）
    pub antigravity_app_path: String,
    /// Codex 启动路径（为空则使用默认路径）
    pub codex_app_path: String,
    /// VS Code 启动路径（为空则使用默认路径）
    pub vscode_app_path: String,
    /// 切换 Codex 时是否自动重启 OpenCode
    pub opencode_sync_on_switch: bool,
    /// 是否启用自动切号
    pub auto_switch_enabled: bool,
    /// 自动切号阈值（百分比）
    pub auto_switch_threshold: i32,
}

#[tauri::command]
pub async fn open_data_folder() -> Result<(), String> {
    let path = modules::account::get_data_dir()?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }

    Ok(())
}

/// 保存文本文件
#[tauri::command]
pub async fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("写入文件失败: {}", e))
}

/// 获取下载目录
#[tauri::command]
pub fn get_downloads_dir() -> Result<String, String> {
    if let Some(dir) = dirs::download_dir() {
        return Ok(dir.to_string_lossy().to_string());
    }
    if let Some(home) = dirs::home_dir() {
        return Ok(home.join("Downloads").to_string_lossy().to_string());
    }
    Err("无法获取下载目录".to_string())
}

/// 获取网络服务配置
#[tauri::command]
pub fn get_network_config() -> Result<NetworkConfig, String> {
    let user_config = config::get_user_config();
    let actual_port = config::get_actual_port();
    
    Ok(NetworkConfig {
        ws_enabled: user_config.ws_enabled,
        ws_port: user_config.ws_port,
        actual_port,
        default_port: DEFAULT_WS_PORT,
    })
}

/// 保存网络服务配置
#[tauri::command]
pub fn save_network_config(ws_enabled: bool, ws_port: u16) -> Result<bool, String> {
    let current = config::get_user_config();
    let needs_restart = current.ws_port != ws_port || current.ws_enabled != ws_enabled;
    
    let new_config = UserConfig {
        ws_enabled,
        ws_port,
        // 保留其他设置不变
        language: current.language,
        theme: current.theme,
        auto_refresh_minutes: current.auto_refresh_minutes,
        codex_auto_refresh_minutes: current.codex_auto_refresh_minutes,
        ghcp_auto_refresh_minutes: current.ghcp_auto_refresh_minutes,
        close_behavior: current.close_behavior,
        opencode_app_path: current.opencode_app_path,
        antigravity_app_path: current.antigravity_app_path,
        codex_app_path: current.codex_app_path,
        vscode_app_path: current.vscode_app_path,
        opencode_sync_on_switch: current.opencode_sync_on_switch,
        auto_switch_enabled: current.auto_switch_enabled,
        auto_switch_threshold: current.auto_switch_threshold,
    };
    
    config::save_user_config(&new_config)?;
    
    Ok(needs_restart)
}

/// 获取通用设置配置
#[tauri::command]
pub fn get_general_config() -> Result<GeneralConfig, String> {
    let user_config = config::get_user_config();
    
    let close_behavior_str = match user_config.close_behavior {
        CloseWindowBehavior::Ask => "ask",
        CloseWindowBehavior::Minimize => "minimize",
        CloseWindowBehavior::Quit => "quit",
    };
    
    Ok(GeneralConfig {
        language: user_config.language,
        theme: user_config.theme,
        auto_refresh_minutes: user_config.auto_refresh_minutes,
        codex_auto_refresh_minutes: user_config.codex_auto_refresh_minutes,
        ghcp_auto_refresh_minutes: user_config.ghcp_auto_refresh_minutes,
        close_behavior: close_behavior_str.to_string(),
        opencode_app_path: user_config.opencode_app_path,
        antigravity_app_path: user_config.antigravity_app_path,
        codex_app_path: user_config.codex_app_path,
        vscode_app_path: user_config.vscode_app_path,
        opencode_sync_on_switch: user_config.opencode_sync_on_switch,
        auto_switch_enabled: user_config.auto_switch_enabled,
        auto_switch_threshold: user_config.auto_switch_threshold,
    })
}

/// 保存通用设置配置
#[tauri::command]
pub fn save_general_config(
    language: String,
    theme: String,
    auto_refresh_minutes: i32,
    codex_auto_refresh_minutes: i32,
    ghcp_auto_refresh_minutes: Option<i32>,
    close_behavior: String,
    opencode_app_path: String,
    antigravity_app_path: String,
    codex_app_path: String,
    vscode_app_path: String,
    opencode_sync_on_switch: bool,
    auto_switch_enabled: Option<bool>,
    auto_switch_threshold: Option<i32>,
) -> Result<(), String> {
    let current = config::get_user_config();
    let normalized_opencode_path = opencode_app_path.trim().to_string();
    let normalized_antigravity_path = antigravity_app_path.trim().to_string();
    let normalized_codex_path = codex_app_path.trim().to_string();
    let normalized_vscode_path = vscode_app_path.trim().to_string();
    // 标准化语言代码为小写，确保与插件端格式一致
    let normalized_language = language.to_lowercase();
    let language_changed = current.language != normalized_language;
    let language_for_broadcast = normalized_language.clone();
    
    // 解析关闭行为
    let close_behavior_enum = match close_behavior.as_str() {
        "minimize" => CloseWindowBehavior::Minimize,
        "quit" => CloseWindowBehavior::Quit,
        _ => CloseWindowBehavior::Ask,
    };
    
    let new_config = UserConfig {
        // 保留网络设置不变
        ws_enabled: current.ws_enabled,
        ws_port: current.ws_port,
        // 更新通用设置
        language: normalized_language.clone(),
        theme,
        auto_refresh_minutes,
        codex_auto_refresh_minutes,
        ghcp_auto_refresh_minutes: ghcp_auto_refresh_minutes.unwrap_or(current.ghcp_auto_refresh_minutes),
        close_behavior: close_behavior_enum,
        opencode_app_path: normalized_opencode_path,
        antigravity_app_path: normalized_antigravity_path,
        codex_app_path: normalized_codex_path,
        vscode_app_path: normalized_vscode_path,
        opencode_sync_on_switch,
        auto_switch_enabled: auto_switch_enabled.unwrap_or(current.auto_switch_enabled),
        auto_switch_threshold: auto_switch_threshold.unwrap_or(current.auto_switch_threshold),
    };
    
    config::save_user_config(&new_config)?;

    if language_changed {
        // 广播语言变更（如果有客户端连接，会通过 WebSocket 发送）
        websocket::broadcast_language_changed(&language_for_broadcast, "desktop");
        
        // 同时写入共享文件（供插件端离线时启动读取）
        // 因为无法确定插件端是否收到了 WebSocket 消息，保守策略是总是写入
        // 但为了减少写入，可以检查是否有客户端连接
        // 这里简化处理：总是写入，插件端启动时会比较时间戳
        modules::sync_settings::write_sync_setting("language", &normalized_language);
    }
    
    Ok(())
}

#[tauri::command]
pub fn set_app_path(app: String, path: String) -> Result<(), String> {
    let mut current = config::get_user_config();
    let normalized_path = path.trim().to_string();
    match app.as_str() {
        "antigravity" => current.antigravity_app_path = normalized_path,
        "codex" => current.codex_app_path = normalized_path,
        "vscode" => current.vscode_app_path = normalized_path,
        "opencode" => current.opencode_app_path = normalized_path,
        _ => return Err("未知应用类型".to_string()),
    }
    config::save_user_config(&current)?;
    Ok(())
}

#[tauri::command]
pub fn detect_app_path(app: String) -> Result<Option<String>, String> {
    match app.as_str() {
        "antigravity" | "codex" | "vscode" | "opencode" => Ok(modules::process::detect_and_save_app_path(app.as_str())),
        _ => Err("未知应用类型".to_string()),
    }
}

/// 通知插件关闭/开启唤醒功能（互斥）
#[tauri::command]
pub fn set_wakeup_override(enabled: bool) -> Result<(), String> {
    websocket::broadcast_wakeup_override(enabled);
    Ok(())
}

/// 执行窗口关闭操作
/// action: "minimize" | "quit"
/// remember: 是否记住选择
#[tauri::command]
pub fn handle_window_close(window: tauri::Window, action: String, remember: bool) -> Result<(), String> {
    modules::logger::log_info(&format!("[Window] 用户选择: action={}, remember={}", action, remember));
    
    // 如果需要记住选择，更新配置
    if remember {
        let current = config::get_user_config();
        let close_behavior = match action.as_str() {
            "minimize" => CloseWindowBehavior::Minimize,
            "quit" => CloseWindowBehavior::Quit,
            _ => CloseWindowBehavior::Ask,
        };
        
        let new_config = UserConfig {
            close_behavior,
            ..current
        };
        
        config::save_user_config(&new_config)?;
        modules::logger::log_info(&format!("[Window] 已保存关闭行为设置: {}", action));
    }
    
    // 执行操作
    match action.as_str() {
        "minimize" => {
            let _ = window.hide();
            modules::logger::log_info("[Window] 窗口已最小化到托盘");
        }
        "quit" => {
            window.app_handle().exit(0);
        }
        _ => {
            return Err("无效的操作".to_string());
        }
    }
    
    Ok(())
}

/// 打开指定文件夹（如不存在则创建）
#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    let folder_path = std::path::Path::new(&path);
    
    // 如果目录不存在则创建
    if !folder_path.exists() {
        std::fs::create_dir_all(folder_path)
            .map_err(|e| format!("创建文件夹失败: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }

    Ok(())
}

/// 删除损坏的文件（会先备份）
#[tauri::command]
pub async fn delete_corrupted_file(path: String) -> Result<(), String> {
    let file_path = std::path::Path::new(&path);
    
    if !file_path.exists() {
        // 文件不存在，直接返回成功
        return Ok(());
    }
    
    // 创建备份文件名
    let timestamp = chrono::Utc::now().timestamp();
    let backup_name = format!("{}.corrupted.{}", path, timestamp);
    
    // 备份文件
    std::fs::rename(&path, &backup_name)
        .map_err(|e| format!("备份损坏文件失败: {}", e))?;
    
    modules::logger::log_info(&format!(
        "已备份并删除损坏文件: {} -> {}", 
        path, 
        backup_name
    ));
    
    Ok(())
}
