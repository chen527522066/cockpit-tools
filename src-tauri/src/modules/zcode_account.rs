use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use crate::models::zcode::{ZcodeAccount, ZcodeAccountIndex};
use crate::modules::{account, atomic_write};

const ACCOUNTS_DIR: &str = "zcode_accounts";
const ACCOUNTS_INDEX_FILE: &str = "zcode_accounts.json";
const CREDENTIALS_FILE: &str = "credentials.json";
const SETTINGS_FILE: &str = "setting.json";
const CREDENTIAL_PREFIX: &str = "enc:v1:";
const DEFAULT_APP_VERSION: &str = "3.3.4";
const BILLING_BALANCE_URL: &str = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const ACTIVE_PROVIDER_KEY: &str = "oauth:active_provider";
const ZCODE_JWT_KEY: &str = "zcodejwttoken";

static ZCODE_ACCOUNT_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn normalize_string(value: Option<&str>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn normalize_provider(provider: &str) -> Result<String, String> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "zai" => Ok("zai".to_string()),
        "bigmodel" => Ok("bigmodel".to_string()),
        _ => Err("不支持的 ZCode OAuth provider".to_string()),
    }
}

fn normalize_tags(tags: Vec<String>) -> Option<Vec<String>> {
    let mut seen = HashSet::new();
    let values: Vec<String> = tags
        .into_iter()
        .filter_map(|tag| normalize_string(Some(&tag)))
        .filter(|tag| seen.insert(tag.to_ascii_lowercase()))
        .collect();
    (!values.is_empty()).then_some(values)
}

fn account_id(provider: &str, user_id: Option<&str>, email: Option<&str>) -> String {
    let identity = normalize_string(user_id)
        .or_else(|| normalize_string(email))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    format!(
        "zcode_{:x}",
        md5::compute(format!("{}:{}", provider, identity))
    )
}

fn accounts_dir() -> Result<PathBuf, String> {
    let path = account::get_data_dir()?.join(ACCOUNTS_DIR);
    fs::create_dir_all(&path).map_err(|error| format!("创建 ZCode 账号目录失败: {}", error))?;
    Ok(path)
}

fn index_path() -> Result<PathBuf, String> {
    Ok(account::get_data_dir()?.join(ACCOUNTS_INDEX_FILE))
}

pub fn accounts_index_path_string() -> Result<String, String> {
    Ok(index_path()?.to_string_lossy().to_string())
}

fn safe_account_id(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
    {
        return Err("ZCode 账号 ID 非法".to_string());
    }
    Ok(trimmed)
}

fn account_path(account_id: &str) -> Result<PathBuf, String> {
    Ok(accounts_dir()?.join(format!("{}.json", safe_account_id(account_id)?)))
}

fn load_index() -> Result<ZcodeAccountIndex, String> {
    let path = index_path()?;
    if !path.exists() {
        return Ok(ZcodeAccountIndex::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|error| format!("读取 ZCode 账号索引失败: {}", error))?;
    if content.trim().is_empty() {
        return Ok(ZcodeAccountIndex::default());
    }
    atomic_write::parse_json_with_auto_restore(&path, &content)
        .map_err(|error| format!("解析 ZCode 账号索引失败: {}", error))
}

fn save_index(index: &ZcodeAccountIndex) -> Result<(), String> {
    let content = serde_json::to_string_pretty(index)
        .map_err(|error| format!("序列化 ZCode 账号索引失败: {}", error))?;
    atomic_write::write_string_atomic(&index_path()?, &content)
        .map_err(|error| format!("保存 ZCode 账号索引失败: {}", error))
}

pub fn load_account(account_id: &str) -> Option<ZcodeAccount> {
    let path = account_path(account_id).ok()?;
    let content = fs::read_to_string(&path).ok()?;
    atomic_write::parse_json_with_auto_restore(&path, &content).ok()
}

fn save_account_file(account: &ZcodeAccount) -> Result<(), String> {
    let content = serde_json::to_string_pretty(account)
        .map_err(|error| format!("序列化 ZCode 账号失败: {}", error))?;
    atomic_write::write_string_atomic(&account_path(&account.id)?, &content)
        .map_err(|error| format!("保存 ZCode 账号失败: {}", error))
}

pub fn upsert_account(mut value: ZcodeAccount) -> Result<ZcodeAccount, String> {
    let _guard = ZCODE_ACCOUNT_LOCK
        .lock()
        .map_err(|_| "获取 ZCode 账号锁失败".to_string())?;
    value.provider = normalize_provider(&value.provider)?;
    value.email =
        normalize_string(Some(&value.email)).unwrap_or_else(|| "unknown@zcode.local".to_string());
    value.user_id = normalize_string(value.user_id.as_deref());
    value.display_name = normalize_string(value.display_name.as_deref());
    value.avatar_url = normalize_string(value.avatar_url.as_deref());
    value.refresh_token = normalize_string(value.refresh_token.as_deref());
    value.plan_type = normalize_string(value.plan_type.as_deref());
    value.tags = normalize_tags(value.tags.unwrap_or_default());
    if value.id.trim().is_empty() {
        value.id = account_id(
            &value.provider,
            value.user_id.as_deref(),
            Some(&value.email),
        );
    }
    if let Some(existing) = load_account(&value.id) {
        if value.tags.is_none() {
            value.tags = existing.tags;
        }
        if value.plan_type.is_none() {
            value.plan_type = existing.plan_type;
        }
        if value.quota_raw.is_none() {
            value.quota_total = existing.quota_total;
            value.quota_used = existing.quota_used;
            value.quota_remaining = existing.quota_remaining;
            value.quota_reset_at = existing.quota_reset_at;
            value.quota_query_last_error = existing.quota_query_last_error;
            value.quota_query_last_error_at = existing.quota_query_last_error_at;
            value.usage_updated_at = existing.usage_updated_at;
            value.subscription_raw = existing.subscription_raw;
            value.quota_raw = existing.quota_raw;
        }
        if existing.created_at > 0 {
            value.created_at = existing.created_at;
        }
    }
    if value.created_at <= 0 {
        value.created_at = now_ts();
    }
    if value.last_used <= 0 {
        value.last_used = now_ts();
    }

    let mut index = load_index()?;
    save_account_file(&value)?;
    if let Some(summary) = index.accounts.iter_mut().find(|item| item.id == value.id) {
        *summary = value.summary();
    } else {
        index.accounts.push(value.summary());
    }
    index
        .accounts
        .sort_by(|left, right| right.last_used.cmp(&left.last_used));
    save_index(&index)?;
    Ok(value)
}

pub fn list_accounts_checked() -> Result<Vec<ZcodeAccount>, String> {
    let index = load_index()?;
    let mut values: Vec<ZcodeAccount> = index
        .accounts
        .iter()
        .filter_map(|summary| load_account(&summary.id))
        .collect();
    values.sort_by(|left, right| right.last_used.cmp(&left.last_used));
    Ok(values)
}

pub fn remove_account(account_id: &str) -> Result<(), String> {
    remove_accounts(&[account_id.to_string()])
}

pub fn remove_accounts(account_ids: &[String]) -> Result<(), String> {
    let _guard = ZCODE_ACCOUNT_LOCK
        .lock()
        .map_err(|_| "获取 ZCode 账号锁失败".to_string())?;
    let ids: HashSet<&str> = account_ids.iter().map(String::as_str).collect();
    let mut index = load_index()?;
    index
        .accounts
        .retain(|item| !ids.contains(item.id.as_str()));
    if index
        .current_account_id
        .as_deref()
        .is_some_and(|id| ids.contains(id))
    {
        index.current_account_id = None;
    }
    save_index(&index)?;
    for id in account_ids {
        let path = account_path(id)?;
        if path.exists() {
            fs::remove_file(path).map_err(|error| format!("删除 ZCode 账号失败: {}", error))?;
        }
    }
    Ok(())
}

pub fn update_account_tags(account_id: &str, tags: Vec<String>) -> Result<ZcodeAccount, String> {
    let mut value = load_account(account_id).ok_or_else(|| "ZCode 账号不存在".to_string())?;
    value.tags = normalize_tags(tags);
    upsert_account(value)
}

pub fn current_account_id() -> Result<Option<String>, String> {
    Ok(load_index()?.current_account_id)
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn fallback_credential_secret(platform: &str, home_dir: &Path, username: &str) -> String {
    format!(
        "zcode-credential-fallback:{}:{}:{}",
        platform,
        home_dir.to_string_lossy(),
        username
    )
}

pub(crate) fn credential_secret_for_home(home_dir: &Path) -> String {
    std::env::var("ZCODE_CREDENTIAL_SECRET")
        .ok()
        .filter(|secret| !secret.is_empty())
        .unwrap_or_else(|| fallback_credential_secret(platform_name(), home_dir, &username()))
}

fn credential_key(home_dir: &Path) -> [u8; 32] {
    Sha256::digest(credential_secret_for_home(home_dir).as_bytes()).into()
}

fn credential_key_from_fallback(platform: &str, home_dir: &Path, username: &str) -> [u8; 32] {
    Sha256::digest(fallback_credential_secret(platform, home_dir, username).as_bytes()).into()
}

fn decode_component(value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|error| format!("解析 ZCode 凭据密文失败: {}", error))
}

pub fn decrypt_credential(value: &str, home_dir: &Path) -> Result<String, String> {
    decrypt_credential_with_key(value, &credential_key(home_dir))
}

fn decrypt_credential_with_key(value: &str, key: &[u8; 32]) -> Result<String, String> {
    if !value.starts_with(CREDENTIAL_PREFIX) {
        return Ok(value.to_string());
    }
    let parts: Vec<&str> = value[CREDENTIAL_PREFIX.len()..].split('.').collect();
    if parts.len() != 3 {
        return Err("ZCode 凭据密文格式无效".to_string());
    }
    let nonce = decode_component(parts[0])?;
    let tag = decode_component(parts[1])?;
    let mut encrypted = decode_component(parts[2])?;
    if nonce.len() != 12 || tag.len() != 16 {
        return Err("ZCode 凭据密文参数无效".to_string());
    }
    encrypted.extend_from_slice(&tag);
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "初始化 ZCode 凭据解密器失败".to_string())?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), encrypted.as_ref())
        .map_err(|_| "ZCode 凭据解密失败，当前用户或 HOME 与写入环境不一致".to_string())?;
    String::from_utf8(plain).map_err(|error| format!("ZCode 凭据不是有效 UTF-8: {}", error))
}

pub fn encrypt_credential(value: &str, home_dir: &Path) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(&credential_key(home_dir))
        .map_err(|_| "初始化 ZCode 凭据加密器失败".to_string())?;
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let mut encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), value.as_bytes())
        .map_err(|_| "加密 ZCode 凭据失败".to_string())?;
    if encrypted.len() < 16 {
        return Err("ZCode 凭据加密结果无效".to_string());
    }
    let tag = encrypted.split_off(encrypted.len() - 16);
    Ok(format!(
        "{}{}.{}.{}",
        CREDENTIAL_PREFIX,
        URL_SAFE_NO_PAD.encode(nonce),
        URL_SAFE_NO_PAD.encode(tag),
        URL_SAFE_NO_PAD.encode(encrypted)
    ))
}

fn read_json_map(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取 ZCode 凭据失败: {}", error))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析 ZCode 凭据失败: {}", error))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "ZCode 凭据文件必须是 JSON 对象".to_string())
}

fn resolve_default_v2_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    let default = home.join(".zcode/v2");
    let setting_path = default.join(SETTINGS_FILE);
    if let Ok(content) = fs::read_to_string(setting_path) {
        if let Ok(value) = serde_json::from_str::<Value>(&content) {
            if let Some(base) = value
                .get("dataBaseDir")
                .and_then(Value::as_str)
                .and_then(|v| normalize_string(Some(v)))
            {
                return Ok(PathBuf::from(base).join(".zcode/v2"));
            }
        }
    }
    Ok(default)
}

pub fn default_credentials_path() -> Result<PathBuf, String> {
    Ok(resolve_default_v2_dir()?.join(CREDENTIALS_FILE))
}

pub fn default_data_root_dir() -> Result<PathBuf, String> {
    resolve_default_v2_dir()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "ZCode 数据目录无效".to_string())
}

pub fn credentials_path_for_instance_root(root: &Path) -> PathBuf {
    root.join("data/.zcode/v2").join(CREDENTIALS_FILE)
}

fn decrypted_value(
    values: &Map<String, Value>,
    name: &str,
    home: &Path,
) -> Result<Option<String>, String> {
    values
        .get(name)
        .and_then(Value::as_str)
        .map(|value| decrypt_credential(value, home))
        .transpose()
}

fn value_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .and_then(|value| normalize_string(Some(value)))
}

pub fn account_from_credentials_path(path: &Path) -> Result<ZcodeAccount, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    account_from_credentials_path_with_home(path, &home)
}

fn account_from_credentials_path_with_home(
    path: &Path,
    home: &Path,
) -> Result<ZcodeAccount, String> {
    let values = read_json_map(path)?;
    let provider = decrypted_value(&values, ACTIVE_PROVIDER_KEY, home)?
        .ok_or_else(|| "ZCode 本地凭据缺少 active provider".to_string())?;
    let provider = normalize_provider(&provider)?;
    let access_token = decrypted_value(&values, &format!("oauth:{}:access_token", provider), home)?
        .ok_or_else(|| "ZCode 本地凭据缺少 access token".to_string())?;
    let refresh_token =
        decrypted_value(&values, &format!("oauth:{}:refresh_token", provider), home)?;
    let zcode_jwt_token = decrypted_value(&values, ZCODE_JWT_KEY, home)?
        .ok_or_else(|| "ZCode 本地凭据缺少 zcode JWT".to_string())?;
    let user_info_text = decrypted_value(&values, &format!("oauth:{}:user_info", provider), home)?;
    let user_info = user_info_text
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or_else(|| json!({}));
    let user_id = value_string(&user_info, &["user_id", "id", "customerNumber", "sub"]);
    let email =
        value_string(&user_info, &["email"]).unwrap_or_else(|| "unknown@zcode.local".to_string());
    let display_name = value_string(
        &user_info,
        &[
            "name",
            "displayName",
            "username",
            "nickName",
            "customerName",
        ],
    );
    let avatar_url = value_string(&user_info, &["avatar", "avatarUrl", "picture"]);
    let now = now_ts();
    Ok(ZcodeAccount {
        id: account_id(&provider, user_id.as_deref(), Some(&email)),
        provider,
        email,
        user_id,
        display_name,
        avatar_url,
        access_token,
        refresh_token,
        zcode_jwt_token,
        expires_at: None,
        plan_type: None,
        quota_total: None,
        quota_used: None,
        quota_remaining: None,
        quota_reset_at: None,
        quota_query_last_error: None,
        quota_query_last_error_at: None,
        usage_updated_at: None,
        tags: None,
        user_info_raw: Some(user_info),
        subscription_raw: None,
        quota_raw: None,
        created_at: now,
        last_used: now,
    })
}

pub async fn import_from_local() -> Result<ZcodeAccount, String> {
    let path = default_credentials_path()?;
    if !path.exists() {
        return Err("未找到 ZCode 本地 credentials.json".to_string());
    }
    let account = upsert_account(account_from_credentials_path(&path)?)?;
    refresh_account_quota(&account.id).await.or(Ok(account))
}

fn official_user_info(account: &ZcodeAccount) -> Value {
    account.user_info_raw.clone().unwrap_or_else(|| {
        json!({
            "user_id": account.user_id,
            "email": account.email,
            "name": account.display_name,
            "avatar": account.avatar_url,
        })
    })
}

pub fn write_account_to_credentials_path(
    account: &ZcodeAccount,
    path: &Path,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    write_account_to_credentials_path_with_home(account, path, &home)
}

fn write_account_to_credentials_path_with_home(
    account: &ZcodeAccount,
    path: &Path,
    home: &Path,
) -> Result<(), String> {
    let mut values = read_json_map(path)?;
    for provider in ["zai", "bigmodel"] {
        for suffix in ["access_token", "refresh_token", "user_info"] {
            values.remove(&format!("oauth:{}:{}", provider, suffix));
        }
    }
    let provider = normalize_provider(&account.provider)?;
    let mut put = |key: String, value: &str| -> Result<(), String> {
        values.insert(key, Value::String(encrypt_credential(value, home)?));
        Ok(())
    };
    put(ACTIVE_PROVIDER_KEY.to_string(), &provider)?;
    put(
        format!("oauth:{}:access_token", provider),
        &account.access_token,
    )?;
    if let Some(refresh) = normalize_string(account.refresh_token.as_deref()) {
        put(format!("oauth:{}:refresh_token", provider), &refresh)?;
    }
    put(
        format!("oauth:{}:user_info", provider),
        &serde_json::to_string(&official_user_info(account))
            .map_err(|error| format!("序列化 ZCode 用户信息失败: {}", error))?,
    )?;
    put(ZCODE_JWT_KEY.to_string(), &account.zcode_jwt_token)?;
    let parent = path
        .parent()
        .ok_or_else(|| "ZCode 凭据目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 ZCode 凭据目录失败: {}", error))?;
    let content = serde_json::to_string_pretty(&Value::Object(values))
        .map_err(|error| format!("序列化 ZCode 凭据失败: {}", error))?;
    atomic_write::write_string_atomic(path, &content)
        .map_err(|error| format!("写入 ZCode 凭据失败: {}", error))
}

pub fn inject_to_default(account_id: &str) -> Result<ZcodeAccount, String> {
    let mut value = load_account(account_id).ok_or_else(|| "ZCode 账号不存在".to_string())?;
    write_account_to_credentials_path(&value, &default_credentials_path()?)?;
    value.last_used = now_ts();
    let value = upsert_account(value)?;
    let mut index = load_index()?;
    index.current_account_id = Some(value.id.clone());
    save_index(&index)?;
    Ok(value)
}

pub fn inject_to_instance_root(account_id: &str, root: &Path) -> Result<ZcodeAccount, String> {
    let value = load_account(account_id).ok_or_else(|| "ZCode 账号不存在".to_string())?;
    write_account_to_credentials_path(&value, &credentials_path_for_instance_root(root))?;
    Ok(value)
}

fn detect_app_version() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("/usr/bin/plutil")
            .args([
                "-extract",
                "CFBundleShortVersionString",
                "raw",
                "/Applications/ZCode.app/Contents/Info.plist",
            ])
            .output()
        {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if output.status.success() && !value.is_empty() {
                return value;
            }
        }
    }
    DEFAULT_APP_VERSION.to_string()
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

fn apply_quota_payload(value: &mut ZcodeAccount, payload: Value) -> Result<(), String> {
    if payload.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(payload
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("ZCode 配额接口返回失败")
            .to_string());
    }

    let data = payload.get("data").cloned().unwrap_or_else(|| json!({}));
    let plans = data
        .get("plans")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let balances = data
        .get("balances")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    value.plan_type = plans
        .iter()
        .find(|plan| plan.get("status").and_then(Value::as_str) == Some("active"))
        .or_else(|| plans.first())
        .and_then(|plan| value_string(plan, &["name", "plan_id"]));
    value.quota_total = Some(
        balances
            .iter()
            .map(|item| number(item.get("total_units")))
            .sum(),
    );
    value.quota_used = Some(
        balances
            .iter()
            .map(|item| number(item.get("used_units")))
            .sum(),
    );
    value.quota_remaining = Some(
        balances
            .iter()
            .map(|item| {
                number(
                    item.get("remaining_units")
                        .or_else(|| item.get("available_units")),
                )
            })
            .sum(),
    );
    value.quota_reset_at = balances
        .iter()
        .filter_map(|item| {
            item.get("period_end")
                .or_else(|| item.get("expires_at"))
                .and_then(Value::as_i64)
        })
        .min();
    value.subscription_raw = Some(Value::Array(plans));
    value.quota_raw = Some(Value::Array(balances));
    value.usage_updated_at = Some(now_ms());
    value.quota_query_last_error = None;
    value.quota_query_last_error_at = None;
    Ok(())
}

pub async fn refresh_account_quota(account_id: &str) -> Result<ZcodeAccount, String> {
    let mut value = load_account(account_id).ok_or_else(|| "ZCode 账号不存在".to_string())?;
    let url = format!(
        "{}?app_version={}",
        BILLING_BALANCE_URL,
        detect_app_version()
    );
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&value.zcode_jwt_token)
        .send()
        .await
        .map_err(|error| format!("请求 ZCode 配额失败: {}", error));
    let payload = match response {
        Ok(response) if response.status().is_success() => response
            .json::<Value>()
            .await
            .map_err(|error| format!("解析 ZCode 配额失败: {}", error)),
        Ok(response) => Err(format!("请求 ZCode 配额失败: HTTP {}", response.status())),
        Err(error) => Err(error),
    };

    match payload {
        Ok(payload) => match apply_quota_payload(&mut value, payload) {
            Ok(()) => upsert_account(value),
            Err(message) => {
                value.quota_query_last_error = Some(message.clone());
                value.quota_query_last_error_at = Some(now_ms());
                let _ = upsert_account(value);
                Err(message)
            }
        },
        Err(error) => {
            value.quota_query_last_error = Some(error.clone());
            value.quota_query_last_error_at = Some(now_ms());
            let _ = upsert_account(value);
            Err(error)
        }
    }
}

pub async fn refresh_all_accounts() -> Result<i32, String> {
    let accounts = list_accounts_checked()?;
    let mut success = 0;
    for value in accounts {
        if refresh_account_quota(&value.id).await.is_ok() {
            success += 1;
        }
    }
    Ok(success)
}

fn serialize_accounts_for_export(
    values: Vec<ZcodeAccount>,
    account_ids: &[String],
) -> Result<String, String> {
    let ids: HashSet<&str> = account_ids.iter().map(String::as_str).collect();
    let selected: Vec<ZcodeAccount> = values
        .into_iter()
        .filter(|value| ids.is_empty() || ids.contains(value.id.as_str()))
        .collect();
    serde_json::to_string_pretty(&selected)
        .map_err(|error| format!("序列化 ZCode 导出失败: {}", error))
}

pub fn export_accounts(account_ids: &[String]) -> Result<String, String> {
    serialize_accounts_for_export(list_accounts_checked()?, account_ids)
}

fn parse_import_accounts(content: &str) -> Result<Vec<ZcodeAccount>, String> {
    let root: Value =
        serde_json::from_str(content).map_err(|error| format!("JSON 解析失败: {}", error))?;
    let items: Vec<Value> = match root {
        Value::Array(items) => items,
        Value::Object(object) => object
            .get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![Value::Object(object)]),
        _ => return Err("ZCode 导入数据必须是对象或数组".to_string()),
    };
    let mut imported = Vec::new();
    for item in items {
        let mut account: ZcodeAccount = serde_json::from_value(item)
            .map_err(|error| format!("ZCode 导入账号格式无效: {}", error))?;
        if account.access_token.trim().is_empty() || account.zcode_jwt_token.trim().is_empty() {
            return Err("ZCode 导入账号缺少必要 Token".to_string());
        }
        account.id.clear();
        imported.push(account);
    }
    Ok(imported)
}

pub fn import_from_json(content: &str) -> Result<Vec<ZcodeAccount>, String> {
    parse_import_accounts(content)?
        .into_iter()
        .map(upsert_account)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn sample_account() -> ZcodeAccount {
        ZcodeAccount {
            id: "zcode_fixture".to_string(),
            provider: "zai".to_string(),
            email: "fixture@example.com".to_string(),
            user_id: Some("fixture-user".to_string()),
            display_name: Some("Fixture User".to_string()),
            avatar_url: Some("https://example.com/avatar.png".to_string()),
            access_token: "access-token".to_string(),
            refresh_token: Some("refresh-token".to_string()),
            zcode_jwt_token: "zcode-jwt-token".to_string(),
            expires_at: Some(1_900_000_000),
            plan_type: None,
            quota_total: None,
            quota_used: None,
            quota_remaining: None,
            quota_reset_at: None,
            quota_query_last_error: Some("stale error".to_string()),
            quota_query_last_error_at: Some(1),
            usage_updated_at: None,
            tags: Some(vec!["work".to_string()]),
            user_info_raw: Some(json!({
                "user_id": "fixture-user",
                "email": "fixture@example.com",
                "name": "Fixture User",
                "avatar": "https://example.com/avatar.png"
            })),
            subscription_raw: None,
            quota_raw: None,
            created_at: 1_700_000_000,
            last_used: 1_700_000_001,
        }
    }

    #[test]
    fn credential_cipher_matches_official_shape_and_round_trips() {
        let home = Path::new("/tmp/zcode-cipher-test-home");
        let encrypted = encrypt_credential("secret-value", home).unwrap();
        assert!(encrypted.starts_with(CREDENTIAL_PREFIX));
        assert_eq!(encrypted[CREDENTIAL_PREFIX.len()..].split('.').count(), 3);
        assert_eq!(
            decrypt_credential(&encrypted, home).unwrap(),
            "secret-value"
        );
    }

    #[test]
    fn decrypts_fixed_official_enc_v1_fixture() {
        // Independently generated with Node.js AES-256-GCM using ZCode's fallback key material.
        let key =
            credential_key_from_fallback("darwin", Path::new("/Users/zcode-test"), "test-user");
        let encrypted =
            "enc:v1:AAECAwQFBgcICQoL.NTIF8rgqI66J7hvPIwTD8g.QTtgwDlfAEvz72ttQggYC2KZyVwLVA";
        assert_eq!(
            decrypt_credential_with_key(encrypted, &key).unwrap(),
            "official-fixture-token"
        );
    }

    #[test]
    fn fallback_credential_secret_matches_official_material() {
        assert_eq!(
            fallback_credential_secret("darwin", Path::new("/Users/zcode-test"), "test-user"),
            "zcode-credential-fallback:darwin:/Users/zcode-test:test-user"
        );
    }

    #[test]
    fn credentials_write_and_read_round_trip_in_instance_directory() {
        let root = make_temp_dir("zcode-credentials-round-trip");
        let path = credentials_path_for_instance_root(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"preserved":"value","oauth:bigmodel:access_token":"obsolete"}"#,
        )
        .unwrap();

        let account = sample_account();
        let credential_home = Path::new("/Users/zcode-round-trip-test");
        write_account_to_credentials_path_with_home(&account, &path, credential_home).unwrap();
        let written = read_json_map(&path).unwrap();
        assert_eq!(
            written.get("preserved"),
            Some(&Value::String("value".into()))
        );
        assert!(!written.contains_key("oauth:bigmodel:access_token"));
        assert!(written
            .get(ACTIVE_PROVIDER_KEY)
            .and_then(Value::as_str)
            .is_some_and(|value| value.starts_with(CREDENTIAL_PREFIX)));

        let restored = account_from_credentials_path_with_home(&path, credential_home).unwrap();
        assert_eq!(restored.provider, account.provider);
        assert_eq!(restored.email, account.email);
        assert_eq!(restored.user_id, account.user_id);
        assert_eq!(restored.access_token, account.access_token);
        assert_eq!(restored.refresh_token, account.refresh_token);
        assert_eq!(restored.zcode_jwt_token, account.zcode_jwt_token);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quota_payload_aggregates_models_and_prefers_active_plan() {
        let mut account = sample_account();
        apply_quota_payload(
            &mut account,
            json!({
                "code": 0,
                "data": {
                    "plans": [
                        {"name": "Expired Plan", "status": "expired"},
                        {
                            "plan_id": "zcode-v3-start-plan-0615",
                            "name": "ZCode Start Plan",
                            "status": "active"
                        }
                    ],
                    "balances": [
                        {
                            "show_name": "GLM-5.2",
                            "total_units": 3_000_000,
                            "used_units": 0,
                            "remaining_units": 3_000_000,
                            "available_units": 3_000_000,
                            "period_end": 1_783_785_599,
                            "expires_at": 1_783_785_599
                        },
                        {
                            "show_name": "GLM-5-Turbo",
                            "total_units": 2_000_000,
                            "used_units": 250_000,
                            "remaining_units": 1_750_000,
                            "available_units": 1_750_000,
                            "period_end": 1_783_785_599,
                            "expires_at": 1_783_785_599
                        }
                    ]
                }
            }),
        )
        .unwrap();

        assert_eq!(account.plan_type.as_deref(), Some("ZCode Start Plan"));
        assert_eq!(account.quota_total, Some(5_000_000.0));
        assert_eq!(account.quota_used, Some(250_000.0));
        assert_eq!(account.quota_remaining, Some(4_750_000.0));
        assert_eq!(account.quota_reset_at, Some(1_783_785_599));
        assert_eq!(
            account
                .quota_raw
                .as_ref()
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        assert!(account.usage_updated_at.is_some());
        assert!(account.quota_query_last_error.is_none());
        assert!(account.quota_query_last_error_at.is_none());
    }

    #[test]
    fn quota_payload_surfaces_api_error_without_overwriting_existing_values() {
        let mut account = sample_account();
        account.plan_type = Some("Existing Plan".to_string());
        let error = apply_quota_payload(
            &mut account,
            json!({"code": 3001, "msg": "app_version is required"}),
        )
        .unwrap_err();
        assert_eq!(error, "app_version is required");
        assert_eq!(account.plan_type.as_deref(), Some("Existing Plan"));
    }

    #[test]
    fn account_id_is_stable() {
        assert_eq!(
            account_id("zai", Some("user-1"), Some("first@example.com")),
            account_id("zai", Some("user-1"), Some("second@example.com"))
        );
    }

    #[test]
    fn tags_are_trimmed_and_deduplicated_case_insensitively() {
        assert_eq!(
            normalize_tags(vec![
                " Work ".to_string(),
                "work".to_string(),
                "Team".to_string(),
                "".to_string(),
            ]),
            Some(vec!["Work".to_string(), "Team".to_string()])
        );
        assert_eq!(normalize_tags(Vec::new()), None);
    }

    #[test]
    fn import_parser_accepts_export_wrapper_and_requires_tokens() {
        let account = sample_account();
        let parsed = parse_import_accounts(
            &serde_json::to_string(&json!({ "accounts": [account.clone()] })).unwrap(),
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].id.is_empty());

        let mut invalid = serde_json::to_value(account).unwrap();
        invalid["zcode_jwt_token"] = Value::String(String::new());
        let error = parse_import_accounts(&invalid.to_string()).unwrap_err();
        assert!(error.contains("缺少必要 Token"));
    }

    #[test]
    fn export_serializer_respects_selected_account_ids() {
        let first = sample_account();
        let mut second = sample_account();
        second.id = "zcode_second".to_string();
        second.user_id = Some("fixture-user-2".to_string());
        second.email = "second@example.com".to_string();

        let selected = serialize_accounts_for_export(
            vec![first.clone(), second.clone()],
            std::slice::from_ref(&second.id),
        )
        .unwrap();
        let selected: Vec<ZcodeAccount> = serde_json::from_str(&selected).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, second.id);

        let all = serialize_accounts_for_export(vec![first, second], &[]).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<ZcodeAccount>>(&all)
                .unwrap()
                .len(),
            2
        );
    }
}
