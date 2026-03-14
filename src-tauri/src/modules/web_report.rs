//! 本地网页查询服务
//! 提供 /report?token=... 查询多平台账号用量摘要

use crate::models::codebuddy::CodebuddyAccount;
use serde::Serialize;
use serde_json::Value;
use std::sync::{OnceLock, RwLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{timeout, Duration};
use url::Url;

use super::config::PORT_RANGE;

const MAX_HTTP_REQUEST_BYTES: usize = 32 * 1024;
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);

static ACTUAL_REPORT_PORT: OnceLock<RwLock<Option<u16>>> = OnceLock::new();

#[derive(Debug, Clone, Copy)]
enum ReportFormat {
    Markdown,
    Yaml,
}

#[derive(Debug, Clone, Serialize)]
struct ReportRow {
    service: String,
    account: String,
    metric: String,
    used: String,
    remaining: String,
    reset_cycle: String,
    status: String,
    note: String,
}

fn report_port_state() -> &'static RwLock<Option<u16>> {
    ACTUAL_REPORT_PORT.get_or_init(|| RwLock::new(None))
}

fn set_actual_port(port: Option<u16>) {
    if let Ok(mut guard) = report_port_state().write() {
        *guard = port;
    }
}

pub fn get_actual_port() -> Option<u16> {
    report_port_state().read().ok().and_then(|guard| *guard)
}

pub async fn start_server() {
    let cfg = super::config::get_user_config();
    if !cfg.report_enabled {
        set_actual_port(None);
        super::logger::log_info("[WebReport] 网页查询服务未启用，跳过启动");
        return;
    }

    let token = cfg.report_token.trim().to_string();
    if token.is_empty() {
        set_actual_port(None);
        super::logger::log_warn("[WebReport] 配置了启用但 token 为空，网页查询服务未启动");
        return;
    }

    let preferred_port = cfg.report_port;
    let mut port = preferred_port;
    let mut listener = None;

    for attempt in 0..PORT_RANGE {
        let addr = format!("0.0.0.0:{}", port);
        match TcpListener::bind(&addr).await {
            Ok(bound) => {
                listener = Some(bound);
                if attempt > 0 {
                    super::logger::log_info(&format!(
                        "[WebReport] 配置端口 {} 被占用，已切换至 {}",
                        preferred_port, port
                    ));
                }
                break;
            }
            Err(err) => {
                if attempt < PORT_RANGE - 1 {
                    port += 1;
                } else {
                    super::logger::log_error(&format!(
                        "[WebReport] 无法绑定端口 ({}-{})，最后错误: {}",
                        preferred_port,
                        preferred_port + PORT_RANGE - 1,
                        err
                    ));
                    set_actual_port(None);
                    return;
                }
            }
        }
    }

    let listener = match listener {
        Some(v) => v,
        None => {
            set_actual_port(None);
            return;
        }
    };

    set_actual_port(Some(port));
    super::logger::log_info(&format!(
        "[WebReport] 网页查询服务已启动: http://0.0.0.0:{}/report?token=***",
        port
    ));

    while let Ok((stream, addr)) = listener.accept().await {
        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, port).await {
                super::logger::log_warn(&format!("[WebReport] 请求处理失败 {}: {}", addr, err));
            }
        });
    }
}

async fn handle_connection(mut stream: TcpStream, port: u16) -> Result<(), String> {
    let raw_request = read_http_request(&mut stream).await?;
    let (method, target) = parse_request_target(&raw_request)?;

    if method.eq_ignore_ascii_case("OPTIONS") {
        write_response(
            &mut stream,
            "200 OK",
            "text/plain; charset=utf-8",
            "",
        )
        .await?;
        return Ok(());
    }

    if !method.eq_ignore_ascii_case("GET") {
        write_response(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            "Only GET is allowed",
        )
        .await?;
        return Ok(());
    }

    let parsed_url = parse_request_url(&target, port)?;
    if parsed_url.path() != "/report" {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            "Not Found",
        )
        .await?;
        return Ok(());
    }

    let request_token = parsed_url
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let config_token = super::config::get_user_config().report_token.trim().to_string();
    if config_token.is_empty() || request_token != config_token {
        write_response(
            &mut stream,
            "401 Unauthorized",
            "text/plain; charset=utf-8",
            "Unauthorized",
        )
        .await?;
        return Ok(());
    }

    let format = parsed_url
        .query_pairs()
        .find(|(key, _)| key == "format")
        .map(|(_, value)| value.to_string())
        .unwrap_or_else(|| "md".to_string());
    let report_format = if format.eq_ignore_ascii_case("yaml") || format.eq_ignore_ascii_case("yml")
    {
        ReportFormat::Yaml
    } else {
        ReportFormat::Markdown
    };

    let now = chrono::Utc::now().to_rfc3339();
    let mut rows = build_report_rows();
    rows.sort_by(|left, right| {
        left.service
            .cmp(&right.service)
            .then(left.account.cmp(&right.account))
            .then(left.metric.cmp(&right.metric))
    });

    let (content_type, body) = match report_format {
        ReportFormat::Markdown => ("text/markdown; charset=utf-8", render_markdown(&now, &rows)),
        ReportFormat::Yaml => ("application/x-yaml; charset=utf-8", render_yaml(&now, &rows)),
    };

    write_response(&mut stream, "200 OK", content_type, &body).await?;
    Ok(())
}

async fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    let header = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status,
        content_type,
        body.as_bytes().len()
    );
    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|err| format!("写响应头失败: {}", err))?;
    stream
        .write_all(body.as_bytes())
        .await
        .map_err(|err| format!("写响应体失败: {}", err))?;
    stream
        .flush()
        .await
        .map_err(|err| format!("刷新响应失败: {}", err))
}

async fn read_http_request(stream: &mut TcpStream) -> Result<String, String> {
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];

    loop {
        let bytes_read = timeout(REQUEST_READ_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| "读取请求超时".to_string())?
            .map_err(|err| format!("读取请求失败: {}", err))?;
        if bytes_read == 0 {
            break;
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n")
            || buffer.len() >= MAX_HTTP_REQUEST_BYTES
        {
            break;
        }
    }

    if buffer.is_empty() {
        return Err("请求为空".to_string());
    }

    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

fn parse_request_target(request: &str) -> Result<(String, String), String> {
    let request_line = request
        .lines()
        .next()
        .ok_or_else(|| "请求行为空".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "缺少 method".to_string())?
        .to_string();
    let target = parts
        .next()
        .ok_or_else(|| "缺少 target".to_string())?
        .to_string();
    Ok((method, target))
}

fn parse_request_url(target: &str, port: u16) -> Result<Url, String> {
    if target.starts_with("http://") || target.starts_with("https://") {
        return Url::parse(target).map_err(|err| format!("URL 解析失败: {}", err));
    }
    Url::parse(&format!("http://127.0.0.1:{}{}", port, target))
        .map_err(|err| format!("URL 解析失败: {}", err))
}

fn build_report_rows() -> Vec<ReportRow> {
    let mut rows = Vec::new();
    append_antigravity_rows(&mut rows);
    append_codex_rows(&mut rows);
    append_github_copilot_rows(&mut rows);
    append_windsurf_rows(&mut rows);
    append_kiro_rows(&mut rows);
    append_cursor_rows(&mut rows);
    append_gemini_rows(&mut rows);
    append_codebuddy_rows(&mut rows, "CodeBuddy", super::codebuddy_account::list_accounts());
    append_codebuddy_rows(
        &mut rows,
        "CodeBuddy CN",
        super::codebuddy_cn_account::list_accounts(),
    );
    append_qoder_rows(&mut rows);
    append_trae_rows(&mut rows);

    if rows.is_empty() {
        rows.push(make_row(
            "System",
            "-",
            "-",
            "-",
            "-",
            "-",
            "normal",
            "No accounts available",
        ));
    }

    rows
}

fn append_antigravity_rows(rows: &mut Vec<ReportRow>) {
    match super::account::list_accounts() {
        Ok(accounts) => {
            for account in accounts {
                let status = if account.disabled { "disabled" } else { "normal" };
                let account_name = account.email.clone();
                if let Some(quota) = account.quota {
                    if quota.models.is_empty() {
                        rows.push(make_row(
                            "Antigravity",
                            &account_name,
                            "Models",
                            "-",
                            "-",
                            "-",
                            status,
                            "Quota exists but model list is empty",
                        ));
                        continue;
                    }

                    for model in quota.models {
                        let remaining = clamp_percent(model.percentage as f64);
                        let used = 100.0 - remaining;
                        let metric = model
                            .display_name
                            .clone()
                            .unwrap_or_else(|| model.name.clone());
                        let mut note = String::new();
                        if let Some(reason) = account.disabled_reason.as_deref() {
                            note = reason.to_string();
                        }
                        rows.push(make_row(
                            "Antigravity",
                            &account_name,
                            &metric,
                            &percent_text(used),
                            &percent_text(remaining),
                            &normalize_reset_text(&model.reset_time),
                            status,
                            &note,
                        ));
                    }
                } else {
                    rows.push(make_row(
                        "Antigravity",
                        &account_name,
                        "Models",
                        "-",
                        "-",
                        "-",
                        status,
                        "Quota not fetched yet",
                    ));
                }
            }
        }
        Err(err) => rows.push(make_row(
            "Antigravity",
            "-",
            "-",
            "-",
            "-",
            "-",
            "error",
            &err,
        )),
    }
}

fn append_codex_rows(rows: &mut Vec<ReportRow>) {
    let accounts = super::codex_account::list_accounts();
    for account in accounts {
        let account_name = account.email.clone();
        let mut status = "normal".to_string();
        let mut note = String::new();
        if let Some(err) = account.quota_error.as_ref() {
            status = "quota_error".to_string();
            note = err.message.clone();
        }

        if let Some(quota) = account.quota {
            let main_label = quota
                .hourly_window_minutes
                .map(|mins| format!("Main window ({}m)", mins))
                .unwrap_or_else(|| "Main window".to_string());
            let weekly_label = quota
                .weekly_window_minutes
                .map(|mins| format!("Weekly window ({}m)", mins))
                .unwrap_or_else(|| "Weekly window".to_string());

            let main_remaining = clamp_percent(quota.hourly_percentage as f64);
            let weekly_remaining = clamp_percent(quota.weekly_percentage as f64);

            rows.push(make_row(
                "Codex",
                &account_name,
                &main_label,
                &percent_text(100.0 - main_remaining),
                &percent_text(main_remaining),
                &format_unix_timestamp(quota.hourly_reset_time),
                &status,
                &note,
            ));
            rows.push(make_row(
                "Codex",
                &account_name,
                &weekly_label,
                &percent_text(100.0 - weekly_remaining),
                &percent_text(weekly_remaining),
                &format_unix_timestamp(quota.weekly_reset_time),
                &status,
                &note,
            ));
        } else {
            rows.push(make_row(
                "Codex",
                &account_name,
                "Quota",
                "-",
                "-",
                "-",
                &status,
                if note.is_empty() {
                    "Quota not fetched yet"
                } else {
                    &note
                },
            ));
        }
    }
}

fn append_github_copilot_rows(rows: &mut Vec<ReportRow>) {
    let accounts = super::github_copilot_account::list_accounts();
    for account in accounts {
        let account_name = account
            .github_email
            .clone()
            .unwrap_or_else(|| account.github_login.clone());
        let reset = pick_copilot_reset_text(
            account.copilot_limited_user_reset_date,
            account.copilot_quota_reset_date.as_deref(),
        );
        let mut pushed = 0usize;
        if let Some(snapshots) = account.copilot_quota_snapshots.as_ref() {
            pushed = append_copilot_snapshot_rows(
                rows,
                "GitHub Copilot",
                &account_name,
                snapshots,
                &reset,
                "normal",
            );
        }

        if pushed == 0 {
            rows.push(make_row(
                "GitHub Copilot",
                &account_name,
                "Quota",
                "-",
                "-",
                &reset,
                "normal",
                "Quota snapshot unavailable",
            ));
        }
    }
}

fn append_windsurf_rows(rows: &mut Vec<ReportRow>) {
    let accounts = super::windsurf_account::list_accounts();
    for account in accounts {
        let account_name = account
            .github_email
            .clone()
            .unwrap_or_else(|| account.github_login.clone());
        let reset = pick_copilot_reset_text(
            account.copilot_limited_user_reset_date,
            account.copilot_quota_reset_date.as_deref(),
        );
        let mut pushed = 0usize;
        if let Some(snapshots) = account.copilot_quota_snapshots.as_ref() {
            pushed = append_copilot_snapshot_rows(
                rows,
                "Windsurf",
                &account_name,
                snapshots,
                &reset,
                "normal",
            );
        }

        if pushed == 0 {
            rows.push(make_row(
                "Windsurf",
                &account_name,
                "Quota",
                "-",
                "-",
                &reset,
                "normal",
                "Quota snapshot unavailable",
            ));
        }
    }
}

fn append_kiro_rows(rows: &mut Vec<ReportRow>) {
    let accounts = super::kiro_account::list_accounts();
    for account in accounts {
        let account_name = account.email.clone();
        let status = account.status.as_deref().unwrap_or("normal");
        let reset = format_unix_timestamp(account.usage_reset_at);
        let mut pushed = false;

        if let (Some(total), Some(used)) = (account.credits_total, account.credits_used) {
            if total > 0.0 {
                let used_percent = clamp_percent((used / total) * 100.0);
                let remaining = (total - used).max(0.0);
                rows.push(make_row(
                    "Kiro",
                    &account_name,
                    "Credits",
                    &format!("{:.2}/{:.2} ({})", used, total, percent_text(used_percent)),
                    &format!("{:.2}", remaining),
                    &reset,
                    status,
                    "",
                ));
                pushed = true;
            }
        }

        if let (Some(total), Some(used)) = (account.bonus_total, account.bonus_used) {
            if total > 0.0 {
                let used_percent = clamp_percent((used / total) * 100.0);
                let remaining = (total - used).max(0.0);
                rows.push(make_row(
                    "Kiro",
                    &account_name,
                    "Bonus credits",
                    &format!("{:.2}/{:.2} ({})", used, total, percent_text(used_percent)),
                    &format!("{:.2}", remaining),
                    &reset,
                    status,
                    "",
                ));
                pushed = true;
            }
        }

        if !pushed {
            rows.push(make_row(
                "Kiro",
                &account_name,
                "Usage",
                "-",
                "-",
                &reset,
                status,
                account
                    .status_reason
                    .as_deref()
                    .unwrap_or("Credits data unavailable"),
            ));
        }
    }
}

fn append_qoder_rows(rows: &mut Vec<ReportRow>) {
    let accounts = super::qoder_account::list_accounts();
    for account in accounts {
        let account_name = account.email.clone();
        if let (Some(total), Some(used)) = (account.credits_total, account.credits_used) {
            if total > 0.0 {
                let remaining = account.credits_remaining.unwrap_or((total - used).max(0.0));
                let used_percent = account
                    .credits_usage_percent
                    .unwrap_or((used / total) * 100.0);
                rows.push(make_row(
                    "Qoder",
                    &account_name,
                    "Credits",
                    &format!("{:.2}/{:.2} ({})", used, total, percent_text(used_percent)),
                    &format!("{:.2}", remaining.max(0.0)),
                    "-",
                    "normal",
                    account.plan_type.as_deref().unwrap_or(""),
                ));
                continue;
            }
        }

        rows.push(make_row(
            "Qoder",
            &account_name,
            "Usage",
            "-",
            "-",
            "-",
            "normal",
            account.plan_type.as_deref().unwrap_or("Credits data unavailable"),
        ));
    }
}

fn append_cursor_rows(rows: &mut Vec<ReportRow>) {
    let accounts = super::cursor_account::list_accounts();
    for account in accounts {
        let account_name = account.email.clone();
        let status = account.status.as_deref().unwrap_or("normal");

        if let Some(raw_usage) = account.cursor_usage_raw.as_ref() {
            let used_percent = pick_first_number(
                raw_usage,
                &[
                    &["individualUsage", "plan", "totalPercentUsed"],
                    &["individual_usage", "plan", "total_percent_used"],
                    &["planUsage", "totalPercentUsed"],
                    &["plan_usage", "total_percent_used"],
                ],
            );
            let fallback_used = compute_cursor_used_percent_from_amount(raw_usage);
            let resolved_used = used_percent.or(fallback_used);

            let reset = pick_first_string(
                raw_usage,
                &[&["billingCycleEnd"], &["billing_cycle_end"]],
            )
            .unwrap_or_else(|| "-".to_string());

            if let Some(percent) = resolved_used {
                let normalized = clamp_percent(percent);
                rows.push(make_row(
                    "Cursor",
                    &account_name,
                    "Plan usage",
                    &percent_text(normalized),
                    &percent_text(100.0 - normalized),
                    &normalize_reset_text(&reset),
                    status,
                    "",
                ));
                continue;
            }
        }

        rows.push(make_row(
            "Cursor",
            &account_name,
            "Usage",
            "-",
            "-",
            "-",
            status,
            account
                .status_reason
                .as_deref()
                .unwrap_or("Usage data unavailable"),
        ));
    }
}

fn append_gemini_rows(rows: &mut Vec<ReportRow>) {
    let accounts = super::gemini_account::list_accounts();
    for account in accounts {
        let account_name = account.email.clone();
        let status = account.status.as_deref().unwrap_or("normal");
        let mut pushed = false;

        if let Some(raw_usage) = account.gemini_usage_raw.as_ref() {
            if let Some(buckets) = get_nested_value(raw_usage, &["buckets"]).and_then(Value::as_array)
            {
                for bucket in buckets {
                    let Some(model_id) = get_nested_value(bucket, &["modelId"])
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    else {
                        continue;
                    };

                    let Some(remaining_fraction) = get_nested_value(bucket, &["remainingFraction"])
                        .and_then(as_f64)
                    else {
                        continue;
                    };

                    let remaining = clamp_percent(remaining_fraction * 100.0);
                    let used = 100.0 - remaining;
                    let reset = parse_reset_value(get_nested_value(bucket, &["resetTime"]));

                    rows.push(make_row(
                        "Gemini",
                        &account_name,
                        model_id,
                        &percent_text(used),
                        &percent_text(remaining),
                        &reset,
                        status,
                        "",
                    ));
                    pushed = true;
                }
            }
        }

        if !pushed {
            rows.push(make_row(
                "Gemini",
                &account_name,
                "Usage",
                "-",
                "-",
                "-",
                status,
                account
                    .status_reason
                    .as_deref()
                    .unwrap_or("Usage data unavailable"),
            ));
        }
    }
}

fn append_codebuddy_rows(rows: &mut Vec<ReportRow>, service: &str, accounts: Vec<CodebuddyAccount>) {
    for account in accounts {
        let account_name = account.email.clone();
        let status = account.status.as_deref().unwrap_or("normal");
        let resources = extract_codebuddy_resources(&account);
        let mut pushed = false;

        for item in resources {
            let total = pick_number_in_item(
                item,
                &[
                    "CycleCapacitySizePrecise",
                    "CycleCapacitySize",
                    "CapacitySizePrecise",
                    "CapacitySize",
                ],
            );
            let remaining = pick_number_in_item(
                item,
                &[
                    "CycleCapacityRemainPrecise",
                    "CycleCapacityRemain",
                    "CapacityRemainPrecise",
                    "CapacityRemain",
                ],
            );

            let (Some(total), Some(remaining)) = (total, remaining) else {
                continue;
            };
            if total <= 0.0 {
                continue;
            }

            let used = (total - remaining).max(0.0);
            let used_percent = clamp_percent((used / total) * 100.0);
            let metric = pick_string_in_item(item, &["PackageName", "PackageCode"])
                .unwrap_or_else(|| "Package".to_string());
            let reset = pick_string_in_item(item, &["CycleEndTime", "ExpiredTime"])
                .unwrap_or_else(|| "-".to_string());

            rows.push(make_row(
                service,
                &account_name,
                &metric,
                &format!("{:.2}/{:.2} ({})", used, total, percent_text(used_percent)),
                &format!("{:.2}", remaining.max(0.0)),
                &normalize_reset_text(&reset),
                status,
                "",
            ));
            pushed = true;
        }

        if !pushed {
            let fallback_note = account
                .dosage_notify_zh
                .as_deref()
                .or(account.dosage_notify_en.as_deref())
                .or(account.status_reason.as_deref())
                .unwrap_or("Usage data unavailable");
            rows.push(make_row(
                service,
                &account_name,
                "Usage",
                "-",
                "-",
                "-",
                status,
                fallback_note,
            ));
        }
    }
}

fn append_trae_rows(rows: &mut Vec<ReportRow>) {
    let accounts = super::trae_account::list_accounts();
    for account in accounts {
        let account_name = account.email.clone();
        let status = account.status.as_deref().unwrap_or("normal");
        let reset = format_unix_timestamp(account.plan_reset_at);
        let note = account
            .plan_type
            .as_deref()
            .or(account.status_reason.as_deref())
            .unwrap_or("Usage data unavailable");

        rows.push(make_row(
            "Trae",
            &account_name,
            "Plan",
            "-",
            "-",
            &reset,
            status,
            note,
        ));
    }
}

fn append_copilot_snapshot_rows(
    rows: &mut Vec<ReportRow>,
    service: &str,
    account: &str,
    snapshots: &Value,
    reset: &str,
    status: &str,
) -> usize {
    let metrics = [
        ("completions", "Completions"),
        ("chat", "Chat"),
        ("premium_interactions", "Premium"),
    ];
    let mut count = 0usize;

    for (key, label) in metrics {
        let Some(snapshot) = get_nested_value(snapshots, &[key]) else {
            continue;
        };
        let Some(remaining) = get_nested_value(snapshot, &["percent_remaining"]).and_then(as_f64)
        else {
            continue;
        };

        let remaining = clamp_percent(remaining);
        rows.push(make_row(
            service,
            account,
            label,
            &percent_text(100.0 - remaining),
            &percent_text(remaining),
            reset,
            status,
            "",
        ));
        count += 1;
    }

    count
}

fn pick_copilot_reset_text(reset_unix: Option<i64>, reset_iso: Option<&str>) -> String {
    if let Some(ts) = reset_unix {
        let formatted = format_unix_timestamp(Some(ts));
        if formatted != "-" {
            return formatted;
        }
    }

    reset_iso
        .map(normalize_reset_text)
        .filter(|text| text != "-")
        .unwrap_or_else(|| "-".to_string())
}

fn extract_codebuddy_resources(account: &CodebuddyAccount) -> Vec<&serde_json::Map<String, Value>> {
    let mut out = Vec::new();

    if let Some(quota_raw) = account.quota_raw.as_ref() {
        if let Some(list) = get_nested_value(quota_raw, &["userResource", "data", "Response", "Data", "Accounts"])
            .and_then(Value::as_array)
        {
            for item in list {
                if let Some(obj) = item.as_object() {
                    out.push(obj);
                }
            }
        }
    }

    if out.is_empty() {
        if let Some(usage_raw) = account.usage_raw.as_ref() {
            if let Some(list) = get_nested_value(usage_raw, &["data", "Response", "Data", "Accounts"])
                .and_then(Value::as_array)
            {
                for item in list {
                    if let Some(obj) = item.as_object() {
                        out.push(obj);
                    }
                }
            }
        }
    }

    out
}

fn pick_number_in_item(
    item: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<f64> {
    for key in keys {
        if let Some(value) = item.get(*key).and_then(as_f64) {
            return Some(value);
        }
    }
    None
}

fn pick_string_in_item(
    item: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(value) = item.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn compute_cursor_used_percent_from_amount(raw_usage: &Value) -> Option<f64> {
    let used = pick_first_number(
        raw_usage,
        &[
            &["individualUsage", "plan", "used"],
            &["individual_usage", "plan", "used"],
            &["planUsage", "used"],
            &["plan_usage", "used"],
            &["individualUsage", "plan", "totalSpend"],
            &["individual_usage", "plan", "total_spend"],
        ],
    )?;
    let limit = pick_first_number(
        raw_usage,
        &[
            &["individualUsage", "plan", "limit"],
            &["individual_usage", "plan", "limit"],
            &["planUsage", "limit"],
            &["plan_usage", "limit"],
        ],
    )?;
    if limit <= 0.0 {
        return None;
    }
    Some((used / limit) * 100.0)
}

fn pick_first_number(value: &Value, paths: &[&[&str]]) -> Option<f64> {
    for path in paths {
        if let Some(parsed) = get_nested_value(value, path).and_then(as_f64) {
            return Some(parsed);
        }
    }
    None
}

fn pick_first_string(value: &Value, paths: &[&[&str]]) -> Option<String> {
    for path in paths {
        if let Some(text) = get_nested_value(value, path).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn get_nested_value<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn make_row(
    service: &str,
    account: &str,
    metric: &str,
    used: &str,
    remaining: &str,
    reset_cycle: &str,
    status: &str,
    note: &str,
) -> ReportRow {
    ReportRow {
        service: normalize_text(service),
        account: normalize_text(account),
        metric: normalize_text(metric),
        used: normalize_text(used),
        remaining: normalize_text(remaining),
        reset_cycle: normalize_text(reset_cycle),
        status: normalize_text(status),
        note: normalize_text(note),
    }
}

fn normalize_text(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        "-".to_string()
    } else {
        trimmed.to_string()
    }
}

fn clamp_percent(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 100.0)
}

fn percent_text(value: f64) -> String {
    format!("{}%", value.round() as i64)
}

fn normalize_reset_text(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "-".to_string();
    }

    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return parsed.with_timezone(&chrono::Utc).to_rfc3339();
    }
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
        let parsed =
            chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc);
        return parsed.to_rfc3339();
    }

    trimmed.to_string()
}

fn parse_reset_value(value: Option<&Value>) -> String {
    let Some(raw) = value else {
        return "-".to_string();
    };

    if let Some(number) = as_f64(raw) {
        return format_unix_timestamp(Some(number as i64));
    }
    if let Some(text) = raw.as_str() {
        return normalize_reset_text(text);
    }
    "-".to_string()
}

fn format_unix_timestamp(value: Option<i64>) -> String {
    let Some(raw) = value else {
        return "-".to_string();
    };
    if raw <= 0 {
        return "-".to_string();
    }

    let seconds = if raw > 10_000_000_000 { raw / 1000 } else { raw };
    let Some(naive) = chrono::NaiveDateTime::from_timestamp_opt(seconds, 0) else {
        return "-".to_string();
    };
    let dt = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc);
    dt.to_rfc3339()
}

fn render_markdown(generated_at: &str, rows: &[ReportRow]) -> String {
    let mut output = String::new();
    output.push_str("# Cockpit Tools Usage Report\n\n");
    output.push_str(&format!("- Generated at: {}\n", markdown_cell(generated_at)));
    output.push_str(&format!("- Rows: {}\n\n", rows.len()));
    output.push_str(
        "| Service | Account | Metric | Used | Remaining | Reset Cycle | Status | Note |\n",
    );
    output.push_str(
        "| --- | --- | --- | --- | --- | --- | --- | --- |\n",
    );

    for row in rows {
        output.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} |\n",
            markdown_cell(&row.service),
            markdown_cell(&row.account),
            markdown_cell(&row.metric),
            markdown_cell(&row.used),
            markdown_cell(&row.remaining),
            markdown_cell(&row.reset_cycle),
            markdown_cell(&row.status),
            markdown_cell(&row.note),
        ));
    }

    output
}

fn markdown_cell(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('\n', "<br/>")
}

fn render_yaml(generated_at: &str, rows: &[ReportRow]) -> String {
    let mut output = String::new();
    output.push_str(&format!("generated_at: {}\n", yaml_quote(generated_at)));
    output.push_str(&format!("row_count: {}\n", rows.len()));
    output.push_str("rows:\n");
    for row in rows {
        output.push_str("  - service: ");
        output.push_str(&yaml_quote(&row.service));
        output.push('\n');
        output.push_str("    account: ");
        output.push_str(&yaml_quote(&row.account));
        output.push('\n');
        output.push_str("    metric: ");
        output.push_str(&yaml_quote(&row.metric));
        output.push('\n');
        output.push_str("    used: ");
        output.push_str(&yaml_quote(&row.used));
        output.push('\n');
        output.push_str("    remaining: ");
        output.push_str(&yaml_quote(&row.remaining));
        output.push('\n');
        output.push_str("    reset_cycle: ");
        output.push_str(&yaml_quote(&row.reset_cycle));
        output.push('\n');
        output.push_str("    status: ");
        output.push_str(&yaml_quote(&row.status));
        output.push('\n');
        output.push_str("    note: ");
        output.push_str(&yaml_quote(&row.note));
        output.push('\n');
    }
    output
}

fn yaml_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}
