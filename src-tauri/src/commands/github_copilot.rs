use tauri::AppHandle;
use std::ffi::OsString;
use std::path::Path;
use std::process::Command;

use crate::models::github_copilot::{GitHubCopilotAccount, GitHubCopilotOAuthStartResponse};
use crate::modules::{github_copilot_account, github_copilot_oauth, logger};

/// 列出所有 GitHub Copilot 账号
#[tauri::command]
pub fn list_github_copilot_accounts() -> Result<Vec<GitHubCopilotAccount>, String> {
    Ok(github_copilot_account::list_accounts())
}

/// 删除 GitHub Copilot 账号
#[tauri::command]
pub fn delete_github_copilot_account(account_id: String) -> Result<(), String> {
    github_copilot_account::remove_account(&account_id)
}

/// 批量删除 GitHub Copilot 账号
#[tauri::command]
pub fn delete_github_copilot_accounts(account_ids: Vec<String>) -> Result<(), String> {
    github_copilot_account::remove_accounts(&account_ids)
}

/// 从 JSON 字符串导入 GitHub Copilot 账号
#[tauri::command]
pub fn import_github_copilot_from_json(
    json_content: String,
) -> Result<Vec<GitHubCopilotAccount>, String> {
    github_copilot_account::import_from_json(&json_content)
}

/// 导出 GitHub Copilot 账号为 JSON
#[tauri::command]
pub fn export_github_copilot_accounts(account_ids: Vec<String>) -> Result<String, String> {
    github_copilot_account::export_accounts(&account_ids)
}

/// 刷新单个账号 Copilot token/配额信息（GitHub API）
#[tauri::command]
pub async fn refresh_github_copilot_token(
    _app: AppHandle,
    account_id: String,
) -> Result<GitHubCopilotAccount, String> {
    github_copilot_account::refresh_account_token(&account_id).await
}

/// 刷新所有账号 Copilot token/配额信息（GitHub API）
#[tauri::command]
pub async fn refresh_all_github_copilot_tokens(_app: AppHandle) -> Result<i32, String> {
    let results = github_copilot_account::refresh_all_tokens().await?;
    let success_count = results.iter().filter(|(_, r)| r.is_ok()).count();
    Ok(success_count as i32)
}

/// OAuth（Device Flow）：开始登录（返回 user_code + verification_uri 等）
#[tauri::command]
pub async fn github_copilot_oauth_login_start() -> Result<GitHubCopilotOAuthStartResponse, String> {
    logger::log_info("GitHub Copilot OAuth start 命令触发");
    let response = github_copilot_oauth::start_login().await?;
    logger::log_info(&format!(
        "GitHub Copilot OAuth start 命令成功: login_id={}",
        response.login_id
    ));
    Ok(response)
}

/// OAuth（Device Flow）：轮询并完成登录（返回保存后的账号）
#[tauri::command]
pub async fn github_copilot_oauth_login_complete(
    login_id: String,
) -> Result<GitHubCopilotAccount, String> {
    logger::log_info(&format!(
        "GitHub Copilot OAuth complete 命令触发: login_id={}",
        login_id
    ));
    let payload = github_copilot_oauth::complete_login(&login_id).await?;
    let account = github_copilot_account::upsert_account(payload)?;
    logger::log_info(&format!(
        "GitHub Copilot OAuth complete 成功: account_id={}, login={}",
        account.id, account.github_login
    ));
    Ok(account)
}

/// OAuth（Device Flow）：取消登录（login_id 为空时取消当前流程）
#[tauri::command]
pub fn github_copilot_oauth_login_cancel(login_id: Option<String>) -> Result<(), String> {
    logger::log_info(&format!(
        "GitHub Copilot OAuth cancel 命令触发: login_id={}",
        login_id.as_deref().unwrap_or("<none>")
    ));
    github_copilot_oauth::cancel_login(login_id.as_deref())
}

/// 通过 GitHub access token 添加账号（会自动拉取 Copilot token/user 信息）
#[tauri::command]
pub async fn add_github_copilot_account_with_token(
    github_access_token: String,
) -> Result<GitHubCopilotAccount, String> {
    let payload =
        github_copilot_oauth::build_payload_from_github_access_token(&github_access_token).await?;
    let account = github_copilot_account::upsert_account(payload)?;
    Ok(account)
}

/// 更新账号标签
#[tauri::command]
pub async fn update_github_copilot_account_tags(
    account_id: String,
    tags: Vec<String>,
) -> Result<GitHubCopilotAccount, String> {
    github_copilot_account::update_account_tags(&account_id, tags)
}

/// 返回 GitHub Copilot 账号索引文件路径（便于排障/查看）
#[tauri::command]
pub fn get_github_copilot_accounts_index_path() -> Result<String, String> {
    github_copilot_account::accounts_index_path_string()
}

/// Inject a Copilot account's GitHub token into VS Code's default instance.
/// This enables one-click account switching by writing directly to VS Code's
/// encrypted auth storage (state.vscdb) using platform-specific os_crypt.
/// If default-profile VS Code is running, it will be closed first to avoid
/// state.vscdb lock issues.
#[tauri::command]
pub async fn inject_github_copilot_to_vscode(account_id: String) -> Result<String, String> {
    logger::log_info(&format!("开始切换 GitHub Copilot 账号: {}", account_id));
    let account = github_copilot_account::load_account(&account_id)
        .ok_or_else(|| format!("GitHub Copilot account not found: {}", account_id))?;
    logger::log_info(&format!(
        "正在切换到 GitHub Copilot 账号: {} (ID: {})",
        account.github_login, account.id
    ));

    let default_user_data_dir = crate::modules::github_copilot_instance::get_default_vscode_user_data_dir()
        .map_err(|e| format!("Failed to resolve VS Code default profile path: {}", e))?;
    close_default_profile_vscode_if_running(&default_user_data_dir, 20)?;

    logger::log_info("正在注入 GitHub Copilot Token 到 VS Code...");
    let result = crate::modules::vscode_inject::inject_copilot_token(
        &account.github_login,
        &account.github_access_token,
        Some(&account.github_id.to_string()),
    )
    .map_err(|e| {
        logger::log_error(&format!("GitHub Copilot Token 注入失败: {}", e));
        e
    })?;

    // Try to launch VS Code after injection
    let launch_msg = match launch_vscode_default() {
        Ok(_) => ", VS Code launched".to_string(),
        Err(e) => {
            logger::log_warn(&format!("VS Code 启动失败: {}", e));
            format!(", but failed to launch VS Code: {}", e)
        }
    };

    logger::log_info(&format!(
        "GitHub Copilot 账号切换完成: {}",
        account.github_login
    ));
    Ok(format!("{}{}", result, launch_msg))
}

fn close_default_profile_vscode_if_running(
    default_user_data_dir: &Path,
    timeout_secs: u64,
) -> Result<(), String> {
    let pids = collect_default_profile_vscode_main_pids(default_user_data_dir);
    if !pids.is_empty() {
        logger::log_info(&format!(
            "检测到 VS Code 正在运行，准备关闭进程: {:?}",
            pids
        ));
    }
    for pid in pids {
        crate::modules::process::close_pid(pid, timeout_secs)
            .map_err(|e| format!("Failed to close running VS Code process (pid={}): {}", pid, e))?;
    }
    Ok(())
}

fn collect_default_profile_vscode_main_pids(default_user_data_dir: &Path) -> Vec<u32> {
    let target = normalize_path_for_compare(&default_user_data_dir.to_string_lossy());
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut pids = Vec::new();
    for (pid, process) in system.processes() {
        if !is_vscode_main_process(process) {
            continue;
        }
        let is_default_profile = match resolve_user_data_dir_for_process(process.cmd(), pid.as_u32()) {
            Some(Some(user_data_dir)) => normalize_path_for_compare(&user_data_dir) == target,
            Some(None) => true,
            None => false,
        };
        if is_default_profile {
            pids.push(pid.as_u32());
        }
    }
    pids
}

fn resolve_user_data_dir_for_process(cmd: &[OsString], pid: u32) -> Option<Option<String>> {
    if let Some(user_data_dir) = extract_user_data_dir(cmd) {
        return Some(Some(user_data_dir));
    }

    let command_line = get_process_cmdline_by_pid(pid)?;
    let parts = split_command_line(&command_line);
    if parts.is_empty() {
        return None;
    }
    let cmd_parts: Vec<OsString> = parts.into_iter().map(OsString::from).collect();
    Some(extract_user_data_dir(&cmd_parts))
}

fn split_command_line(command_line: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;

    for ch in command_line.chars() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            ' ' | '\t' if !in_single && !in_double => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

#[cfg(target_os = "macos")]
fn get_process_cmdline_by_pid(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "windows")]
fn get_process_cmdline_by_pid(pid: u32) -> Option<String> {
    let command = format!(
        "Get-CimInstance Win32_Process -Filter \"ProcessId={}\" | Select-Object -ExpandProperty CommandLine",
        pid
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &command])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "linux")]
fn get_process_cmdline_by_pid(pid: u32) -> Option<String> {
    let cmdline = std::fs::read(format!("/proc/{}/cmdline", pid)).ok()?;
    if cmdline.is_empty() {
        return None;
    }
    let value = String::from_utf8_lossy(&cmdline).replace('\0', " ").trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn get_process_cmdline_by_pid(_pid: u32) -> Option<String> {
    None
}

fn extract_user_data_dir(cmd: &[OsString]) -> Option<String> {
    let mut idx = 0usize;
    while idx < cmd.len() {
        let arg = cmd[idx].to_string_lossy().trim().to_string();
        let lower = arg.to_lowercase();

        if lower == "--user-data-dir" {
            if idx + 1 < cmd.len() {
                let value = cmd[idx + 1].to_string_lossy().trim().trim_matches('"').to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
            idx += 2;
            continue;
        }

        if let Some(value) = arg.strip_prefix("--user-data-dir=") {
            let value = value.trim().trim_matches('"');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }

        idx += 1;
    }
    None
}

fn normalize_path_for_compare(path: &str) -> String {
    let trimmed = path.trim();
    #[cfg(target_os = "windows")]
    {
        return trimmed.replace('/', "\\").to_lowercase();
    }
    #[cfg(not(target_os = "windows"))]
    {
        trimmed.to_string()
    }
}

fn is_vscode_main_process(process: &sysinfo::Process) -> bool {
    let name = process.name().to_string_lossy().to_lowercase();
    let exe_path = process
        .exe()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_lowercase();
    let args_str = process
        .cmd()
        .iter()
        .map(|a| a.to_string_lossy().to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    let is_helper = args_str.contains("--type=");

    #[cfg(target_os = "windows")]
    {
        return (name == "code.exe" || exe_path.ends_with("\\code.exe")) && !is_helper;
    }
    #[cfg(target_os = "macos")]
    {
        return (exe_path.contains("visual studio code.app/contents/") || name == "code")
            && !is_helper;
    }
    #[cfg(target_os = "linux")]
    {
        return (name == "code" || exe_path.ends_with("/code")) && !is_helper;
    }
    #[allow(unreachable_code)]
    false
}

fn launch_vscode_default() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        // "code" on Windows is a .cmd script, must run via cmd.exe
        Command::new("cmd")
            .args(["/C", "code"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Failed to launch VS Code: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let open_result = Command::new("open")
            .args(["-a", "Visual Studio Code"])
            .spawn();
        if open_result.is_ok() {
            return Ok(());
        }
        Command::new("code")
            .spawn()
            .map_err(|e| format!("Failed to launch VS Code: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("code")
            .spawn()
            .map_err(|e| format!("Failed to launch VS Code: {}", e))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        return Err("Unsupported platform for VS Code launch".to_string());
    }
}
