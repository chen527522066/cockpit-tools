use crate::modules::logger;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const GITHUB_API_URL: &str = "https://api.github.com/repos/jlcodes99/cockpit-tools/releases/latest";
const CHANGELOG_EN_URL: &str =
    "https://raw.githubusercontent.com/jlcodes99/cockpit-tools/main/CHANGELOG.md";
const CHANGELOG_ZH_URL: &str =
    "https://raw.githubusercontent.com/jlcodes99/cockpit-tools/main/CHANGELOG.zh-CN.md";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_CHECK_INTERVAL_HOURS: u64 = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub download_url: String,
    pub release_notes: String,
    pub release_notes_zh: String,
    pub published_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSettings {
    pub auto_check: bool,
    pub last_check_time: u64,
    #[serde(default = "default_check_interval")]
    pub check_interval_hours: u64,
    #[serde(default)]
    pub auto_install: bool,
    #[serde(default)]
    pub last_run_version: String,
}

fn default_check_interval() -> u64 {
    DEFAULT_CHECK_INTERVAL_HOURS
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_check: true,
            last_check_time: 0,
            check_interval_hours: DEFAULT_CHECK_INTERVAL_HOURS,
            auto_install: false,
            last_run_version: String::new(),
        }
    }
}

/// Version jump info returned when app was updated since last run
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionJumpInfo {
    pub previous_version: String,
    pub current_version: String,
    pub release_notes: String,
    pub release_notes_zh: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    published_at: String,
}

/// Check for updates from GitHub releases
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("Antigravity-Cockpit-Tools")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| {
            let err_msg = format!("Failed to create HTTP client: {}", e);
            logger::log_error(&err_msg);
            err_msg
        })?;

    logger::log_info("正在从 GitHub 检查新版本...");

    let response = client.get(GITHUB_API_URL).send().await.map_err(|e| {
        let err_msg = format!("Failed to fetch release info: {}", e);
        logger::log_error(&err_msg);
        err_msg
    })?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {}", e))?;

    // Remove 'v' prefix if present
    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let current_version = CURRENT_VERSION.to_string();

    let has_update = compare_versions(&latest_version, &current_version);

    if has_update {
        logger::log_info(&format!(
            "发现新版本: {} (当前版本: {})",
            latest_version, current_version
        ));
    } else {
        logger::log_info(&format!(
            "已是最新版本: {} (与远程版本 {} 一致)",
            current_version, latest_version
        ));
    }

    // Fetch changelog content for release notes
    let (release_notes, release_notes_zh) = if has_update {
        let notes_en =
            fetch_changelog_for_version(&client, CHANGELOG_EN_URL, &latest_version).await;
        let notes_zh =
            fetch_changelog_for_version(&client, CHANGELOG_ZH_URL, &latest_version).await;
        (notes_en, notes_zh)
    } else {
        (String::new(), String::new())
    };

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url: release.html_url,
        release_notes,
        release_notes_zh,
        published_at: release.published_at,
    })
}

/// Fetch changelog content for a specific version
async fn fetch_changelog_for_version(client: &reqwest::Client, url: &str, version: &str) -> String {
    match client.get(url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(content) = response.text().await {
                extract_version_notes(&content, version)
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// Extract release notes for a specific version from CHANGELOG content
fn extract_version_notes(changelog: &str, version: &str) -> String {
    let mut result = Vec::new();
    let mut in_target_version = false;
    let version_header = format!("## [{}]", version);

    for line in changelog.lines() {
        if line.starts_with("## [") {
            if line.contains(&version_header) || line.starts_with(&version_header) {
                in_target_version = true;
                continue; // Skip the version header itself
            } else if in_target_version {
                // Next version section, stop
                break;
            }
        }

        if in_target_version {
            // Skip empty lines at start
            if result.is_empty() && line.trim().is_empty() {
                continue;
            }
            // Skip separator lines
            if line.trim() == "---" {
                continue;
            }
            result.push(line);
        }
    }

    // Trim trailing empty lines
    while result.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
        result.pop();
    }

    result.join("\n")
}

/// Compare two semantic versions (e.g., "0.2.0" vs "0.1.0")
fn compare_versions(latest: &str, current: &str) -> bool {
    let parse_version =
        |v: &str| -> Vec<u32> { v.split('.').filter_map(|s| s.parse::<u32>().ok()).collect() };

    let latest_parts = parse_version(latest);
    let current_parts = parse_version(current);

    for i in 0..latest_parts.len().max(current_parts.len()) {
        let latest_part = latest_parts.get(i).unwrap_or(&0);
        let current_part = current_parts.get(i).unwrap_or(&0);

        if latest_part > current_part {
            return true;
        } else if latest_part < current_part {
            return false;
        }
    }

    false
}

/// Check if enough time has passed since last check
pub fn should_check_for_updates(settings: &UpdateSettings) -> bool {
    if !settings.auto_check {
        return false;
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let elapsed_hours = (now - settings.last_check_time) / 3600;
    let interval = if settings.check_interval_hours > 0 {
        settings.check_interval_hours
    } else {
        DEFAULT_CHECK_INTERVAL_HOURS
    };
    elapsed_hours >= interval
}

/// Get data directory for storing update settings
fn get_data_dir() -> Result<std::path::PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join("cockpit-tools"))
        .ok_or_else(|| "Failed to get data directory".to_string())
}

/// Load update settings from config file
pub fn load_update_settings() -> Result<UpdateSettings, String> {
    let data_dir = get_data_dir()?;
    let settings_path = data_dir.join("update_settings.json");

    if !settings_path.exists() {
        return Ok(UpdateSettings::default());
    }

    let content = std::fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings file: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))
}

/// Save update settings to config file
pub fn save_update_settings(settings: &UpdateSettings) -> Result<(), String> {
    let data_dir = get_data_dir()?;

    // Ensure directory exists
    if !data_dir.exists() {
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
    }

    let settings_path = data_dir.join("update_settings.json");

    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    std::fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write settings file: {}", e))
}

/// Update last check time
pub fn update_last_check_time() -> Result<(), String> {
    let mut settings = load_update_settings()?;
    settings.last_check_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    save_update_settings(&settings)
}

/// Check if a version jump occurred (app was updated since last run)
/// Returns Some(VersionJumpInfo) if the current version is higher than the last recorded version
pub async fn check_version_jump() -> Result<Option<VersionJumpInfo>, String> {
    let mut settings = load_update_settings()?;
    let current = CURRENT_VERSION.to_string();

    // First run or same version – just record and return
    if settings.last_run_version.is_empty() || settings.last_run_version == current {
        if settings.last_run_version != current {
            settings.last_run_version = current;
            save_update_settings(&settings)?;
        }
        return Ok(None);
    }

    let previous = settings.last_run_version.clone();

    // Only trigger if current > previous (upgrade, not downgrade)
    if !compare_versions(&current, &previous) {
        settings.last_run_version = current;
        save_update_settings(&settings)?;
        return Ok(None);
    }

    // Fetch release notes for the current (new) version
    let client = reqwest::Client::builder()
        .user_agent("Antigravity-Cockpit-Tools")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let release_notes =
        fetch_changelog_for_version(&client, CHANGELOG_EN_URL, &current).await;
    let release_notes_zh =
        fetch_changelog_for_version(&client, CHANGELOG_ZH_URL, &current).await;

    // Update the stored version
    settings.last_run_version = current.clone();
    save_update_settings(&settings)?;

    logger::log_info(&format!(
        "检测到版本跳跃: {} -> {}",
        previous, current
    ));

    Ok(Some(VersionJumpInfo {
        previous_version: previous,
        current_version: current,
        release_notes,
        release_notes_zh,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compare_versions() {
        assert!(compare_versions("0.2.0", "0.1.0"));
        assert!(compare_versions("1.0.0", "0.9.9"));
        assert!(compare_versions("0.1.1", "0.1.0"));
        assert!(!compare_versions("0.1.0", "0.1.0"));
        assert!(!compare_versions("0.1.0", "0.2.0"));
    }

    #[test]
    fn test_should_check_for_updates() {
        let mut settings = UpdateSettings::default();
        assert!(should_check_for_updates(&settings));

        settings.last_check_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(!should_check_for_updates(&settings));

        settings.auto_check = false;
        assert!(!should_check_for_updates(&settings));
    }
}
