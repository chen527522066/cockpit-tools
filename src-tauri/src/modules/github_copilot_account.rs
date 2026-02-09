use crate::models::github_copilot::{
    GitHubCopilotAccount, GitHubCopilotAccountIndex, GitHubCopilotOAuthCompletePayload,
};
use crate::modules::{account, github_copilot_oauth, logger};
use std::fs;
use std::path::PathBuf;

const ACCOUNTS_INDEX_FILE: &str = "github_copilot_accounts.json";
const ACCOUNTS_DIR: &str = "github_copilot_accounts";

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

fn get_data_dir() -> Result<PathBuf, String> {
    account::get_data_dir()
}

fn get_accounts_dir() -> Result<PathBuf, String> {
    let base = get_data_dir()?;
    let dir = base.join(ACCOUNTS_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建 GitHub Copilot 账号目录失败: {}", e))?;
    }
    Ok(dir)
}

fn get_accounts_index_path() -> Result<PathBuf, String> {
    Ok(get_data_dir()?.join(ACCOUNTS_INDEX_FILE))
}

pub fn accounts_index_path_string() -> Result<String, String> {
    Ok(get_accounts_index_path()?.to_string_lossy().to_string())
}

/// Load a single account by ID (public wrapper)
pub fn load_account(account_id: &str) -> Option<GitHubCopilotAccount> {
    load_account_file(account_id)
}

fn load_account_file(account_id: &str) -> Option<GitHubCopilotAccount> {
    let account_path = get_accounts_dir()
        .ok()
        .map(|dir| dir.join(format!("{}.json", account_id)))?;
    if !account_path.exists() {
        return None;
    }
    let content = fs::read_to_string(account_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_account_file(account: &GitHubCopilotAccount) -> Result<(), String> {
    let path = get_accounts_dir()?.join(format!("{}.json", account.id));
    let content =
        serde_json::to_string_pretty(account).map_err(|e| format!("序列化账号失败: {}", e))?;
    fs::write(path, content).map_err(|e| format!("保存账号失败: {}", e))
}

fn delete_account_file(account_id: &str) -> Result<(), String> {
    let path = get_accounts_dir()?.join(format!("{}.json", account_id));
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("删除账号失败: {}", e))?;
    }
    Ok(())
}

fn load_account_index() -> GitHubCopilotAccountIndex {
    let path = match get_accounts_index_path() {
        Ok(p) => p,
        Err(_) => return GitHubCopilotAccountIndex::new(),
    };

    if !path.exists() {
        return GitHubCopilotAccountIndex::new();
    }

    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| GitHubCopilotAccountIndex::new()),
        Err(_) => GitHubCopilotAccountIndex::new(),
    }
}

fn save_account_index(index: &GitHubCopilotAccountIndex) -> Result<(), String> {
    let path = get_accounts_index_path()?;
    let content = serde_json::to_string_pretty(index)
        .map_err(|e| format!("序列化账号索引失败: {}", e))?;
    fs::write(path, content).map_err(|e| format!("写入账号索引失败: {}", e))
}

fn refresh_summary(index: &mut GitHubCopilotAccountIndex, account: &GitHubCopilotAccount) {
    if let Some(summary) = index.accounts.iter_mut().find(|item| item.id == account.id) {
        *summary = account.summary();
        return;
    }
    index.accounts.push(account.summary());
}

fn upsert_account_record(account: GitHubCopilotAccount) -> Result<GitHubCopilotAccount, String> {
    let mut index = load_account_index();
    save_account_file(&account)?;
    refresh_summary(&mut index, &account);
    save_account_index(&index)?;
    Ok(account)
}

pub fn list_accounts() -> Vec<GitHubCopilotAccount> {
    let index = load_account_index();
    index
        .accounts
        .iter()
        .filter_map(|summary| load_account_file(&summary.id))
        .collect()
}

pub fn upsert_account(payload: GitHubCopilotOAuthCompletePayload) -> Result<GitHubCopilotAccount, String> {
    let now = now_ts();
    let mut index = load_account_index();
    let generated_id = format!(
        "ghcp_{:x}",
        md5::compute(format!("{}:{}", payload.github_login, payload.github_id))
    );
    let account_id = index
        .accounts
        .iter()
        .find(|item| item.github_login == payload.github_login)
        .map(|item| item.id.clone())
        .unwrap_or(generated_id);

    let existing = load_account_file(&account_id);
    let tags = existing.as_ref().and_then(|acc| acc.tags.clone());
    let created_at = existing.as_ref().map(|acc| acc.created_at).unwrap_or(now);

    let mut account = existing.unwrap_or(GitHubCopilotAccount {
        id: account_id.clone(),
        github_login: payload.github_login.clone(),
        github_id: payload.github_id,
        github_name: payload.github_name.clone(),
        github_email: payload.github_email.clone(),
        tags,
        github_access_token: payload.github_access_token.clone(),
        github_token_type: payload.github_token_type.clone(),
        github_scope: payload.github_scope.clone(),
        copilot_token: payload.copilot_token.clone(),
        copilot_plan: payload.copilot_plan.clone(),
        copilot_chat_enabled: payload.copilot_chat_enabled,
        copilot_expires_at: payload.copilot_expires_at,
        copilot_refresh_in: payload.copilot_refresh_in,
        copilot_quota_snapshots: payload.copilot_quota_snapshots.clone(),
        copilot_quota_reset_date: payload.copilot_quota_reset_date.clone(),
        copilot_limited_user_quotas: payload.copilot_limited_user_quotas.clone(),
        copilot_limited_user_reset_date: payload.copilot_limited_user_reset_date,
        created_at,
        last_used: now,
    });

    account.github_login = payload.github_login;
    account.github_id = payload.github_id;
    account.github_name = payload.github_name;
    account.github_email = payload.github_email;
    account.github_access_token = payload.github_access_token;
    account.github_token_type = payload.github_token_type;
    account.github_scope = payload.github_scope;
    account.copilot_token = payload.copilot_token;
    account.copilot_plan = payload.copilot_plan;
    account.copilot_chat_enabled = payload.copilot_chat_enabled;
    account.copilot_expires_at = payload.copilot_expires_at;
    account.copilot_refresh_in = payload.copilot_refresh_in;
    account.copilot_quota_snapshots = payload.copilot_quota_snapshots;
    account.copilot_quota_reset_date = payload.copilot_quota_reset_date;
    account.copilot_limited_user_quotas = payload.copilot_limited_user_quotas;
    account.copilot_limited_user_reset_date = payload.copilot_limited_user_reset_date;
    account.created_at = created_at;
    account.last_used = now;

    save_account_file(&account)?;
    refresh_summary(&mut index, &account);
    save_account_index(&index)?;

    logger::log_info(&format!(
        "GitHub Copilot 账号已保存: id={}, login={}",
        account.id, account.github_login
    ));
    Ok(account)
}

pub async fn refresh_account_token(account_id: &str) -> Result<GitHubCopilotAccount, String> {
    let mut account = load_account_file(account_id).ok_or_else(|| "账号不存在".to_string())?;
    let bundle = github_copilot_oauth::refresh_copilot_token(&account.github_access_token).await?;

    account.copilot_token = bundle.token;
    account.copilot_plan = bundle.plan;
    account.copilot_chat_enabled = bundle.chat_enabled;
    account.copilot_expires_at = bundle.expires_at;
    account.copilot_refresh_in = bundle.refresh_in;
    account.copilot_quota_snapshots = bundle.quota_snapshots;
    account.copilot_quota_reset_date = bundle.quota_reset_date;
    account.copilot_limited_user_quotas = bundle.limited_user_quotas;
    account.copilot_limited_user_reset_date = bundle.limited_user_reset_date;
    account.last_used = now_ts();

    let updated = account.clone();
    upsert_account_record(account)?;
    Ok(updated)
}

pub async fn refresh_all_tokens() -> Result<Vec<(String, Result<GitHubCopilotAccount, String>)>, String> {
    let accounts = list_accounts();
    let mut results = Vec::new();
    for acc in accounts {
        let id = acc.id.clone();
        let res = refresh_account_token(&id).await;
        results.push((id, res));
    }
    Ok(results)
}

pub fn remove_account(account_id: &str) -> Result<(), String> {
    let mut index = load_account_index();
    index.accounts.retain(|item| item.id != account_id);
    save_account_index(&index)?;
    delete_account_file(account_id)?;
    Ok(())
}

pub fn remove_accounts(account_ids: &[String]) -> Result<(), String> {
    for id in account_ids {
        remove_account(id)?;
    }
    Ok(())
}

pub fn update_account_tags(account_id: &str, tags: Vec<String>) -> Result<GitHubCopilotAccount, String> {
    let mut account = load_account_file(account_id).ok_or_else(|| "账号不存在".to_string())?;
    account.tags = Some(tags);
    account.last_used = now_ts();
    let updated = account.clone();
    upsert_account_record(account)?;
    Ok(updated)
}

pub fn import_from_json(json_content: &str) -> Result<Vec<GitHubCopilotAccount>, String> {
    if let Ok(account) = serde_json::from_str::<GitHubCopilotAccount>(json_content) {
        let saved = upsert_account_record(account)?;
        return Ok(vec![saved]);
    }

    if let Ok(accounts) = serde_json::from_str::<Vec<GitHubCopilotAccount>>(json_content) {
        let mut result = Vec::new();
        for account in accounts {
            let saved = upsert_account_record(account)?;
            result.push(saved);
        }
        return Ok(result);
    }

    Err("无法解析 JSON 内容".to_string())
}

pub fn export_accounts(account_ids: &[String]) -> Result<String, String> {
    let accounts: Vec<GitHubCopilotAccount> = account_ids
        .iter()
        .filter_map(|id| load_account_file(id))
        .collect();
    serde_json::to_string_pretty(&accounts).map_err(|e| format!("序列化失败: {}", e))
}
