//! VS Code GitHub Copilot token injection module.
//!
//! Enables one-click Copilot account switching in VS Code by directly
//! writing auth sessions into VS Code's state.vscdb database.
//!
//! ## Platform crypto model
//!
//! - Windows: Local State `os_crypt.encrypted_key` + DPAPI, payload is `v10` + AES-256-GCM
//! - macOS: Keychain "Code Safe Storage" password, payload is `v10` + AES-128-CBC
//! - Linux: Secret Service password for `v11` + AES-128-CBC, fallback `v10` fixed key
//!
//! This module decrypts the existing GitHub auth sessions, replaces the token,
//! re-encrypts, and writes back.

use std::path::{Path, PathBuf};
use std::process::Command;

use aes::Aes128;
#[cfg(target_os = "windows")]
use aes_gcm::aead::generic_array::GenericArray;
#[cfg(target_os = "windows")]
use aes_gcm::aead::{Aead, AeadCore, OsRng};
#[cfg(target_os = "windows")]
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
#[cfg(target_os = "windows")]
use base64::{engine::general_purpose, Engine as _};
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use pbkdf2::pbkdf2_hmac;
use rusqlite::Connection;
use sha1::Sha1;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{LocalFree, HLOCAL};
#[cfg(target_os = "windows")]
use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

type Aes128CbcEnc = cbc::Encryptor<Aes128>;
type Aes128CbcDec = cbc::Decryptor<Aes128>;

const V10_PREFIX: &[u8] = b"v10";
const V11_PREFIX: &[u8] = b"v11";
const CBC_IV: [u8; 16] = [b' '; 16];
const SALT: &[u8] = b"saltysalt";

// PBKDF2-HMAC-SHA1(1 iteration, key = "peanuts", salt = "saltysalt")
#[cfg(target_os = "linux")]
const LINUX_V10_KEY: [u8; 16] = [
    0xfd, 0x62, 0x1f, 0xe5, 0xa2, 0xb4, 0x02, 0x53, 0x9d, 0xfa, 0x14, 0x7c, 0xa9, 0x27, 0x27, 0x78,
];

// PBKDF2-HMAC-SHA1(1 iteration, key = "", salt = "saltysalt")
#[cfg(target_os = "linux")]
const LINUX_EMPTY_KEY: [u8; 16] = [
    0xd0, 0xd0, 0xec, 0x9c, 0x7d, 0x77, 0xd4, 0x3a, 0xc5, 0x41, 0x87, 0xfa, 0x48, 0x18, 0xd1, 0x7f,
];

fn get_vscode_data_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA")
            .map_err(|_| "Cannot read APPDATA environment variable".to_string())?;
        return Ok(PathBuf::from(appdata).join("Code"));
    }

    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or("Cannot locate home directory".to_string())?;
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("Code"));
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg_config_home) = std::env::var("XDG_CONFIG_HOME") {
            let trimmed = xdg_config_home.trim();
            if !trimmed.is_empty() {
                return Ok(PathBuf::from(trimmed).join("Code"));
            }
        }
        let home = dirs::home_dir().ok_or("Cannot locate home directory".to_string())?;
        return Ok(home.join(".config").join("Code"));
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}

fn resolve_vscode_data_root(user_data_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(raw) = user_data_dir {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    get_vscode_data_root()
}

fn get_vscode_db_path_from_data_root(data_root: &Path) -> Result<PathBuf, String> {
    let path = data_root
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("VS Code database not found: {}", path.display()))
    }
}

/// Get the path to VS Code's state.vscdb.
#[allow(dead_code)]
pub fn get_vscode_db_path() -> Result<PathBuf, String> {
    let data_root = resolve_vscode_data_root(None)?;
    get_vscode_db_path_from_data_root(&data_root)
}

#[cfg(target_os = "windows")]
fn get_local_state_path(data_root: &Path) -> Result<PathBuf, String> {
    let path = data_root.join("Local State");
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("VS Code Local State not found: {}", path.display()))
    }
}

#[cfg(target_os = "windows")]
fn get_windows_encryption_key(data_root: Option<&Path>) -> Result<Vec<u8>, String> {
    let owned_root;
    let root = if let Some(path) = data_root {
        path
    } else {
        owned_root = get_vscode_data_root()?;
        owned_root.as_path()
    };
    let path = get_local_state_path(root)?;
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read Local State: {}", e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Local State JSON: {}", e))?;

    let encrypted_key_b64 = json["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or("Cannot find os_crypt.encrypted_key in Local State")?;

    let encrypted_key_bytes = general_purpose::STANDARD
        .decode(encrypted_key_b64)
        .map_err(|e| format!("Base64 decode failed for encrypted_key: {}", e))?;

    if encrypted_key_bytes.len() < 6 {
        return Err("encrypted_key data too short".to_string());
    }

    let prefix = String::from_utf8_lossy(&encrypted_key_bytes[..5]);
    if prefix != "DPAPI" {
        return Err(format!(
            "encrypted_key prefix is not DPAPI, got: {}",
            prefix
        ));
    }

    let dpapi_blob = &encrypted_key_bytes[5..];
    let key = dpapi_decrypt(dpapi_blob)?;
    if key.len() != 32 {
        return Err(format!(
            "Decrypted AES key has unexpected length: {}",
            key.len()
        ));
    }
    Ok(key)
}

#[cfg(target_os = "windows")]
fn dpapi_decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: encrypted.len() as u32,
            pbData: encrypted.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };

        CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output)
            .map_err(|_| "DPAPI CryptUnprotectData call failed".to_string())?;

        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(HLOCAL(output.pbData as *mut _));
        Ok(result)
    }
}

#[cfg(target_os = "windows")]
fn decrypt_windows_gcm_v10(key: &[u8], encrypted: &[u8]) -> Result<Vec<u8>, String> {
    if encrypted.len() < 31 {
        return Err("Encrypted data too short".to_string());
    }
    if &encrypted[..3] != V10_PREFIX {
        return Err(format!(
            "Not Windows v10 format, prefix: {:?}",
            &encrypted[..3]
        ));
    }

    let nonce_bytes = &encrypted[3..15];
    let ciphertext = &encrypted[15..];

    let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("AES-GCM decryption failed: {}", e))
}

#[cfg(target_os = "windows")]
fn encrypt_windows_gcm_v10(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("AES-GCM encryption failed: {}", e))?;

    let mut result = Vec::with_capacity(3 + 12 + ciphertext.len());
    result.extend_from_slice(V10_PREFIX);
    result.extend_from_slice(nonce.as_slice());
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

fn decrypt_cbc_prefixed(
    encrypted: &[u8],
    expected_prefix: &[u8],
    key: &[u8; 16],
) -> Result<Vec<u8>, String> {
    if !encrypted.starts_with(expected_prefix) {
        return Err(format!(
            "Unexpected ciphertext prefix: {:?}",
            &encrypted[..encrypted.len().min(3)]
        ));
    }
    let raw = &encrypted[expected_prefix.len()..];
    let mut buf = raw.to_vec();
    let cipher = Aes128CbcDec::new_from_slices(key, &CBC_IV)
        .map_err(|e| format!("Failed to init AES-CBC decryptor: {}", e))?;
    let plaintext = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| format!("AES-CBC decryption failed: {}", e))?
        .to_vec();
    Ok(plaintext)
}

fn encrypt_cbc_prefixed(
    prefix: &[u8],
    key: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = Aes128CbcEnc::new_from_slices(key, &CBC_IV)
        .map_err(|e| format!("Failed to init AES-CBC encryptor: {}", e))?;

    let mut buf = plaintext.to_vec();
    let msg_len = buf.len();
    let pad_len = 16 - (msg_len % 16);
    buf.resize(msg_len + pad_len, 0);
    let ciphertext = cipher
        .encrypt_padded_mut::<Pkcs7>(&mut buf, msg_len)
        .map_err(|e| format!("AES-CBC encryption failed: {}", e))?
        .to_vec();

    let mut result = Vec::with_capacity(prefix.len() + ciphertext.len());
    result.extend_from_slice(prefix);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

fn pbkdf2_sha1_key(password: &str, iterations: u32) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(password.as_bytes(), SALT, iterations, &mut key);
    key
}

fn detect_prefix(encrypted: &[u8]) -> Option<&'static str> {
    if encrypted.starts_with(V10_PREFIX) {
        Some("v10")
    } else if encrypted.starts_with(V11_PREFIX) {
        Some("v11")
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn run_command_get_trimmed(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
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

#[cfg(target_os = "macos")]
fn get_macos_safe_storage_password() -> Result<String, String> {
    let candidates = [
        ("Code Safe Storage", "Code"),
        ("Code Safe Storage", "Code Safe Storage"),
        ("Visual Studio Code Safe Storage", "Visual Studio Code"),
        ("Code - OSS Safe Storage", "Code - OSS"),
        ("VSCodium Safe Storage", "VSCodium"),
    ];

    for (service, account) in candidates {
        if let Some(password) = run_command_get_trimmed(
            "security",
            &["find-generic-password", "-w", "-s", service, "-a", account],
        ) {
            return Ok(password);
        }
        if let Some(password) =
            run_command_get_trimmed("security", &["find-generic-password", "-w", "-s", service])
        {
            return Ok(password);
        }
    }

    Err("Failed to read VS Code Safe Storage password from Keychain".to_string())
}

#[cfg(target_os = "linux")]
fn run_command_get_trimmed(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
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
fn get_linux_v11_key() -> Option<[u8; 16]> {
    let app_names = ["code", "Code", "code-oss", "Code - OSS", "VSCodium"];

    for app in app_names {
        if let Some(password) =
            run_command_get_trimmed("secret-tool", &["lookup", "application", app])
        {
            return Some(pbkdf2_sha1_key(&password, 1));
        }
    }

    None
}

fn decrypt_secret_payload(encrypted: &[u8], data_root: Option<&Path>) -> Result<Vec<u8>, String> {
    #[cfg(not(target_os = "windows"))]
    let _ = data_root;

    #[cfg(target_os = "windows")]
    {
        let key = get_windows_encryption_key(data_root)?;
        return decrypt_windows_gcm_v10(&key, encrypted);
    }

    #[cfg(target_os = "macos")]
    {
        let password = get_macos_safe_storage_password()?;
        let key = pbkdf2_sha1_key(&password, 1003);
        return decrypt_cbc_prefixed(encrypted, V10_PREFIX, &key);
    }

    #[cfg(target_os = "linux")]
    {
        match detect_prefix(encrypted) {
            Some("v11") => {
                let key = get_linux_v11_key().ok_or(
                    "Cannot load Linux secret storage key for VS Code (v11 payload)".to_string(),
                )?;
                match decrypt_cbc_prefixed(encrypted, V11_PREFIX, &key) {
                    Ok(value) => Ok(value),
                    Err(_) => decrypt_cbc_prefixed(encrypted, V11_PREFIX, &LINUX_EMPTY_KEY),
                }
            }
            Some("v10") => match decrypt_cbc_prefixed(encrypted, V10_PREFIX, &LINUX_V10_KEY) {
                Ok(value) => Ok(value),
                Err(_) => decrypt_cbc_prefixed(encrypted, V10_PREFIX, &LINUX_EMPTY_KEY),
            },
            _ => Err(format!(
                "Unsupported Linux ciphertext prefix: {:?}",
                &encrypted[..encrypted.len().min(3)]
            )),
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = encrypted;
        let _ = data_root;
        Err("Unsupported platform".to_string())
    }
}

fn encrypt_secret_payload(
    plaintext: &[u8],
    preferred_prefix: Option<&str>,
    data_root: Option<&Path>,
) -> Result<Vec<u8>, String> {
    #[cfg(not(target_os = "linux"))]
    let _ = preferred_prefix;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let _ = data_root;

    #[cfg(target_os = "windows")]
    {
        let key = get_windows_encryption_key(data_root)?;
        return encrypt_windows_gcm_v10(&key, plaintext);
    }

    #[cfg(target_os = "macos")]
    {
        let password = get_macos_safe_storage_password()?;
        let key = pbkdf2_sha1_key(&password, 1003);
        return encrypt_cbc_prefixed(V10_PREFIX, &key, plaintext);
    }

    #[cfg(target_os = "linux")]
    {
        let target_prefix = if let Some(prefix) = preferred_prefix {
            prefix
        } else if get_linux_v11_key().is_some() {
            "v11"
        } else {
            "v10"
        };

        if target_prefix == "v11" {
            let key = get_linux_v11_key().ok_or(
                "Cannot load Linux secret storage key for VS Code (v11 payload)".to_string(),
            )?;
            return encrypt_cbc_prefixed(V11_PREFIX, &key, plaintext);
        }

        return encrypt_cbc_prefixed(V10_PREFIX, &LINUX_V10_KEY, plaintext);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (plaintext, preferred_prefix, data_root);
        Err("Unsupported platform".to_string())
    }
}

fn inject_copilot_token_with_data_root(
    data_root: &Path,
    username: &str,
    token: &str,
    github_user_id: Option<&str>,
) -> Result<String, String> {
    let db_path = get_vscode_db_path_from_data_root(data_root)?;
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open VS Code database: {}", e))?;

    let secret_key =
        r#"secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}"#;
    let existing: Option<String> = match conn.query_row(
        "SELECT value FROM ItemTable WHERE key = ?",
        [secret_key],
        |row| row.get(0),
    ) {
        Ok(val) => Some(val),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("Failed to query github.auth from database: {}", e)),
    };

    let (new_sessions, existing_prefix) = build_github_auth_sessions(
        existing.as_deref(),
        Some(data_root),
        username,
        token,
        github_user_id,
    )?;

    let sessions_json = serde_json::to_string(&new_sessions)
        .map_err(|e| format!("Failed to serialize sessions: {}", e))?;
    let encrypted =
        encrypt_secret_payload(sessions_json.as_bytes(), existing_prefix.as_deref(), Some(data_root))?;

    let buffer_json = serde_json::json!({
        "type": "Buffer",
        "data": encrypted
    });
    let buffer_str = serde_json::to_string(&buffer_json)
        .map_err(|e| format!("Failed to serialize Buffer: {}", e))?;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    tx.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        [secret_key, &buffer_str.as_str()],
    )
    .map_err(|e| format!("Failed to write github.auth: {}", e))?;

    tx.execute(
        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
        ["github.copilot-github", username],
    )
    .map_err(|e| format!("Failed to write github.copilot-github: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(format!("Successfully injected {} into VS Code", username))
}

fn decode_buffer_data(buffer: &serde_json::Value) -> Result<Vec<u8>, String> {
    let data_arr = buffer["data"]
        .as_array()
        .ok_or("Secret data is not in Buffer format")?;

    let mut encrypted_bytes: Vec<u8> = Vec::with_capacity(data_arr.len());
    for (idx, v) in data_arr.iter().enumerate() {
        let n = v
            .as_u64()
            .ok_or_else(|| format!("Secret data element at index {} is not an integer", idx))?;
        if n > 255 {
            return Err(format!(
                "Secret data element at index {} is out of range ({} > 255)",
                idx, n
            ));
        }
        encrypted_bytes.push(n as u8);
    }

    Ok(encrypted_bytes)
}

fn load_existing_sessions(
    existing_encrypted_value: Option<&str>,
    data_root: Option<&Path>,
) -> Result<(Vec<serde_json::Value>, Option<String>), String> {
    let Some(value) = existing_encrypted_value else {
        return Ok((Vec::new(), None));
    };

    let parsed: serde_json::Value = serde_json::from_str(value)
        .map_err(|e| format!("Failed to parse existing secret JSON: {}", e))?;

    if parsed.is_array() {
        let sessions: Vec<serde_json::Value> = serde_json::from_value(parsed)
            .map_err(|e| format!("Existing sessions JSON is invalid: {}", e))?;
        return Ok((sessions, None));
    }

    let encrypted_bytes = decode_buffer_data(&parsed)?;
    let prefix = detect_prefix(&encrypted_bytes).map(|s| s.to_string());
    let decrypted = decrypt_secret_payload(&encrypted_bytes, data_root)?;
    let json_str = String::from_utf8(decrypted)
        .map_err(|e| format!("Decrypted data is not valid UTF-8: {}", e))?;
    let sessions: Vec<serde_json::Value> = serde_json::from_str(&json_str)
        .map_err(|e| format!("Decrypted github.auth is not a valid sessions array: {}", e))?;

    Ok((sessions, prefix))
}

fn build_github_auth_sessions(
    existing_encrypted_value: Option<&str>,
    data_root: Option<&Path>,
    username: &str,
    token: &str,
    github_user_id: Option<&str>,
) -> Result<(serde_json::Value, Option<String>), String> {
    let (mut sessions, existing_prefix) =
        load_existing_sessions(existing_encrypted_value, data_root)?;

    let user_id = github_user_id.unwrap_or("0");
    let new_session = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "scopes": ["user:email"],
        "accessToken": token,
        "account": {
            "label": username,
            "id": user_id
        }
    });

    let mut replaced = false;
    for session in &mut sessions {
        if let Some(scopes) = session["scopes"].as_array() {
            let has_user_email = scopes.iter().any(|s| s.as_str() == Some("user:email"));
            if has_user_email {
                *session = new_session.clone();
                replaced = true;
                break;
            }
        }
    }
    if !replaced {
        sessions.push(new_session);
    }

    Ok((serde_json::Value::Array(sessions), existing_prefix))
}

/// Inject a Copilot account's GitHub token into VS Code's auth storage.
///
/// This replaces the `user:email` scoped session in the
/// `vscode.github-authentication` secret with the provided token,
/// effectively switching the logged-in GitHub account for Copilot.
pub fn inject_copilot_token(
    username: &str,
    token: &str,
    github_user_id: Option<&str>,
) -> Result<String, String> {
    let data_root = resolve_vscode_data_root(None)?;
    inject_copilot_token_with_data_root(&data_root, username, token, github_user_id)
}

pub fn inject_copilot_token_for_user_data_dir(
    user_data_dir: &str,
    username: &str,
    token: &str,
    github_user_id: Option<&str>,
) -> Result<String, String> {
    let data_root = resolve_vscode_data_root(Some(user_data_dir))?;
    inject_copilot_token_with_data_root(&data_root, username, token, github_user_id)
}
