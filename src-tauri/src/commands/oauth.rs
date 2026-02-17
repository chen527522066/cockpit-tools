use crate::models;
use crate::modules;
use tauri::AppHandle;

#[tauri::command]
pub async fn start_oauth_login(app_handle: AppHandle) -> Result<models::Account, String> {
    modules::logger::log_info("开始 OAuth 授权流程...");

    let token_res = modules::oauth_server::start_oauth_flow(app_handle.clone())
        .await
        .map_err(|e| {
            modules::logger::log_error(&format!("OAuth 流程失败: {}", e));
            e
        })?;

    modules::logger::log_info("OAuth 授权成功，检查 refresh_token...");

    let refresh_token = token_res.refresh_token.ok_or_else(|| {
        let msg = "未获取到 Refresh Token。\n\n\
         可能原因：您之前已授权过此应用\n\n\
         解决方案：\n\
         1. 访问 https://myaccount.google.com/permissions\n\
         2. 撤销 'Antigravity Tools' 的访问权限\n\
         3. 重新进行 OAuth 授权"
            .to_string();
        modules::logger::log_error(&msg);
        msg
    })?;

    modules::logger::log_info("获取用户信息...");
    let user_info = modules::oauth::get_user_info(&token_res.access_token)
        .await
        .map_err(|e| {
            modules::logger::log_error(&format!("获取用户信息失败: {}", e));
            e
        })?;

    modules::logger::log_info(&format!(
        "用户: {} ({})",
        user_info.email,
        user_info.name.as_deref().unwrap_or("无名称")
    ));

    let token_data = models::TokenData::new(
        token_res.access_token,
        refresh_token,
        token_res.expires_in,
        Some(user_info.email.clone()),
        None,
        user_info.id.clone(),
    );

    let account = modules::upsert_account(
        user_info.email.clone(),
        user_info.get_display_name(),
        token_data,
    )
    .map_err(|e| {
        modules::logger::log_error(&format!("保存账号失败: {}", e));
        e
    })?;

    modules::logger::log_info(&format!("账号添加成功: {}", account.email));

    // 广播数据变更通知
    modules::websocket::broadcast_data_changed("oauth_login");

    Ok(account)
}

#[tauri::command]
pub async fn complete_oauth_login(app_handle: AppHandle) -> Result<models::Account, String> {
    modules::logger::log_info("完成 OAuth 授权流程...");

    let token_res = modules::oauth_server::complete_oauth_flow(app_handle.clone())
        .await
        .map_err(|e| {
            modules::logger::log_error(&format!("OAuth 流程失败: {}", e));
            e
        })?;

    modules::logger::log_info("OAuth 授权成功，检查 refresh_token...");

    let refresh_token = token_res.refresh_token.ok_or_else(|| {
        let msg = "未获取到 Refresh Token。\n\n\
         可能原因：您之前已授权过此应用\n\n\
         解决方案：\n\
         1. 访问 https://myaccount.google.com/permissions\n\
         2. 撤销 'Antigravity Tools' 的访问权限\n\
         3. 重新进行 OAuth 授权"
            .to_string();
        modules::logger::log_error(&msg);
        msg
    })?;

    modules::logger::log_info("获取用户信息...");
    let user_info = modules::oauth::get_user_info(&token_res.access_token)
        .await
        .map_err(|e| {
            modules::logger::log_error(&format!("获取用户信息失败: {}", e));
            e
        })?;

    modules::logger::log_info(&format!(
        "用户: {} ({})",
        user_info.email,
        user_info.name.as_deref().unwrap_or("无名称")
    ));

    let token_data = models::TokenData::new(
        token_res.access_token,
        refresh_token,
        token_res.expires_in,
        Some(user_info.email.clone()),
        None,
        user_info.id.clone(),
    );

    let account = modules::upsert_account(
        user_info.email.clone(),
        user_info.get_display_name(),
        token_data,
    )
    .map_err(|e| {
        modules::logger::log_error(&format!("保存账号失败: {}", e));
        e
    })?;

    modules::logger::log_info(&format!("账号添加成功: {}", account.email));
    modules::websocket::broadcast_data_changed("oauth_login");

    Ok(account)
}

#[tauri::command]
pub async fn prepare_oauth_url(app_handle: AppHandle) -> Result<String, String> {
    modules::oauth_server::prepare_oauth_url(app_handle).await
}

#[tauri::command]
pub async fn cancel_oauth_login() -> Result<(), String> {
    modules::oauth_server::cancel_oauth_flow();
    Ok(())
}
