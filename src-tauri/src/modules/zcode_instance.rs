use chrono::Utc;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use uuid::Uuid;

use crate::models::{DefaultInstanceSettings, InstanceProfile, InstanceStore};
use crate::modules::{self, instance_store};

pub use crate::modules::instance_store::{CreateInstanceParams, UpdateInstanceParams};

const INSTANCES_FILE: &str = "zcode_instances.json";
const PROFILE_MARKER_PREFIX: &str = "--cockpit-zcode-profile=";

static STORE_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));

fn instances_path() -> Result<PathBuf, String> {
    Ok(modules::account::get_data_dir()?.join(INSTANCES_FILE))
}

pub fn load_instance_store() -> Result<InstanceStore, String> {
    instance_store::load_instance_store(&instances_path()?, INSTANCES_FILE)
}

pub fn save_instance_store(store: &InstanceStore) -> Result<(), String> {
    instance_store::save_instance_store(&instances_path()?, INSTANCES_FILE, store)
}

pub fn load_default_settings() -> Result<DefaultInstanceSettings, String> {
    Ok(load_instance_store()?.default_settings)
}

pub fn update_default_settings(
    bind_account_id: Option<Option<String>>,
    extra_args: Option<String>,
    _follow_local_account: Option<bool>,
) -> Result<DefaultInstanceSettings, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "获取 ZCode 实例锁失败")?;
    let mut store = load_instance_store()?;
    if let Some(bind) = bind_account_id {
        store.default_settings.bind_account_id = bind;
        store.default_settings.follow_local_account = false;
    }
    if let Some(args) = extra_args {
        store.default_settings.extra_args = args.trim().to_string();
    }
    let value = store.default_settings.clone();
    save_instance_store(&store)?;
    Ok(value)
}

fn default_user_data_dir_for(
    platform: &str,
    home: Option<&Path>,
    app_data: Option<&Path>,
) -> Result<PathBuf, String> {
    match platform {
        "macos" => Ok(home
            .ok_or_else(|| "无法获取用户主目录".to_string())?
            .join("Library/Application Support/ZCode")),
        "windows" => Ok(app_data
            .ok_or_else(|| "无法获取 APPDATA".to_string())?
            .join("ZCode")),
        "linux" => Ok(home
            .ok_or_else(|| "无法获取用户主目录".to_string())?
            .join(".config/ZCode")),
        _ => Err("ZCode 多开仅支持 macOS、Windows 和 Linux".to_string()),
    }
}

pub fn get_default_user_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir();
        return default_user_data_dir_for("macos", home.as_deref(), None);
    }
    #[cfg(target_os = "windows")]
    {
        let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
        return default_user_data_dir_for("windows", None, app_data.as_deref());
    }
    #[cfg(target_os = "linux")]
    {
        let home = dirs::home_dir();
        return default_user_data_dir_for("linux", home.as_deref(), None);
    }
    #[allow(unreachable_code)]
    Err("ZCode 多开仅支持 macOS、Windows 和 Linux".to_string())
}

pub fn get_instances_root_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "无法获取用户主目录".to_string())?
        .join(".antigravity_cockpit/instances/zcode"))
}

pub fn get_instance_defaults() -> Result<modules::instance::InstanceDefaults, String> {
    Ok(modules::instance::InstanceDefaults {
        root_dir: get_instances_root_dir()?.to_string_lossy().to_string(),
        default_user_data_dir: get_default_user_data_dir()?.to_string_lossy().to_string(),
    })
}

fn is_non_empty_dir(path: &Path) -> bool {
    path.exists()
        && path.is_dir()
        && fs::read_dir(path)
            .ok()
            .and_then(|mut entries| entries.next())
            .is_some()
}

fn initialize_empty_root(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join("electron/session"))
        .map_err(|error| format!("创建 ZCode Electron 实例目录失败: {}", error))?;
    fs::create_dir_all(root.join("data/.zcode/v2"))
        .map_err(|error| format!("创建 ZCode 数据实例目录失败: {}", error))
}

fn sanitize_managed_setting(root: &Path) -> Result<(), String> {
    let path = root.join("data/.zcode/v2/setting.json");
    if !path.exists() {
        return Ok(());
    }
    let content =
        fs::read_to_string(&path).map_err(|error| format!("读取 ZCode 实例设置失败: {}", error))?;
    let mut value: Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析 ZCode 实例设置失败: {}", error))?;
    let Some(object) = value.as_object_mut() else {
        return Err("ZCode 实例 setting.json 必须是 JSON 对象".to_string());
    };
    if object.remove("dataBaseDir").is_none() {
        return Ok(());
    }
    let content = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("序列化 ZCode 实例设置失败: {}", error))?;
    modules::atomic_write::write_string_atomic(&path, &content)
        .map_err(|error| format!("保存 ZCode 实例设置失败: {}", error))
}

fn copy_default_to_root(root: &Path) -> Result<(), String> {
    let electron_source = get_default_user_data_dir()?;
    if electron_source.exists() {
        instance_store::copy_dir_recursive(&electron_source, &root.join("electron"))?;
    } else {
        fs::create_dir_all(root.join("electron"))
            .map_err(|error| format!("创建 ZCode Electron 实例目录失败: {}", error))?;
    }
    let zcode_source = modules::zcode_account::default_data_root_dir()?;
    if zcode_source.exists() {
        instance_store::copy_dir_recursive(&zcode_source, &root.join("data/.zcode"))?;
    } else {
        fs::create_dir_all(root.join("data/.zcode/v2"))
            .map_err(|error| format!("创建 ZCode 数据实例目录失败: {}", error))?;
    }
    sanitize_managed_setting(root)
}

pub fn create_instance(params: CreateInstanceParams) -> Result<InstanceProfile, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "获取 ZCode 实例锁失败")?;
    let mut store = load_instance_store()?;
    let name = instance_store::normalize_name(&params.name)?;
    let root = PathBuf::from(params.user_data_dir.trim());
    if params.user_data_dir.trim().is_empty() {
        return Err("实例目录不能为空".to_string());
    }
    instance_store::ensure_unique(&store, &name, &params.user_data_dir, None)?;
    let mode = params
        .init_mode
        .as_deref()
        .unwrap_or("copy")
        .to_ascii_lowercase();
    if mode == "existingdir" || mode == "existing_dir" {
        if !root.is_dir() {
            return Err("所选 ZCode 实例目录不存在或不是目录".to_string());
        }
    } else {
        if is_non_empty_dir(&root) {
            return Err(format!(
                "ZCode 实例目标目录必须为空: {}",
                instance_store::display_path(&root)
            ));
        }
        if mode == "empty" {
            initialize_empty_root(&root)?;
        } else if let Some(source_id) = params
            .copy_source_instance_id
            .as_deref()
            .filter(|value| *value != "__default__")
        {
            let source = store
                .instances
                .iter()
                .find(|instance| instance.id == source_id)
                .ok_or_else(|| "复制来源实例不存在".to_string())?;
            instance_store::copy_dir_recursive(Path::new(&source.user_data_dir), &root)?;
        } else {
            copy_default_to_root(&root)?;
        }
    }

    let instance = InstanceProfile {
        id: Uuid::new_v4().to_string(),
        name,
        user_data_dir: root.to_string_lossy().to_string(),
        working_dir: params.working_dir,
        extra_args: params.extra_args.trim().to_string(),
        bind_account_id: params.bind_account_id,
        launch_mode: crate::models::InstanceLaunchMode::App,
        app_speed: crate::models::codex::CodexAppSpeed::Standard,
        created_at: Utc::now().timestamp_millis(),
        last_launched_at: None,
        last_pid: None,
    };
    store.instances.push(instance.clone());
    save_instance_store(&store)?;
    Ok(instance)
}

pub fn update_instance(params: UpdateInstanceParams) -> Result<InstanceProfile, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "获取 ZCode 实例锁失败")?;
    let mut store = load_instance_store()?;
    let index = store
        .instances
        .iter()
        .position(|instance| instance.id == params.instance_id)
        .ok_or_else(|| "ZCode 实例不存在".to_string())?;
    let current = store.instances[index].clone();
    if let Some(name) = params.name.as_deref() {
        let name = instance_store::normalize_name(name)?;
        instance_store::ensure_unique(&store, &name, &current.user_data_dir, Some(&current.id))?;
        store.instances[index].name = name;
    }
    if let Some(working_dir) = params.working_dir {
        store.instances[index].working_dir = if working_dir.trim().is_empty() {
            None
        } else {
            Some(working_dir.trim().to_string())
        };
    }
    if let Some(args) = params.extra_args {
        store.instances[index].extra_args = args.trim().to_string();
    }
    if let Some(bind) = params.bind_account_id {
        store.instances[index].bind_account_id = bind;
    }
    let value = store.instances[index].clone();
    save_instance_store(&store)?;
    Ok(value)
}

pub fn delete_instance(instance_id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "获取 ZCode 实例锁失败")?;
    let mut store = load_instance_store()?;
    let index = store
        .instances
        .iter()
        .position(|instance| instance.id == instance_id)
        .ok_or_else(|| "ZCode 实例不存在".to_string())?;
    modules::instance::delete_instance_directory(Path::new(&store.instances[index].user_data_dir))?;
    store.instances.remove(index);
    save_instance_store(&store)
}

fn update_pid(instance_id: Option<&str>, pid: Option<u32>, launched: bool) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "获取 ZCode 实例锁失败")?;
    let mut store = load_instance_store()?;
    if let Some(id) = instance_id {
        let instance = store
            .instances
            .iter_mut()
            .find(|instance| instance.id == id)
            .ok_or_else(|| "ZCode 实例不存在".to_string())?;
        instance.last_pid = pid;
        if launched {
            instance.last_launched_at = Some(Utc::now().timestamp_millis());
        }
    } else {
        store.default_settings.last_pid = pid;
    }
    save_instance_store(&store)
}

pub fn mark_started(instance_id: Option<&str>, pid: u32) -> Result<(), String> {
    update_pid(instance_id, Some(pid), true)
}

pub fn mark_stopped(instance_id: Option<&str>) -> Result<(), String> {
    update_pid(instance_id, None, false)
}

pub fn clear_all_pids() -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "获取 ZCode 实例锁失败")?;
    let mut store = load_instance_store()?;
    store.default_settings.last_pid = None;
    for instance in &mut store.instances {
        instance.last_pid = None;
    }
    save_instance_store(&store)
}

pub fn resolve_executable() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from(
        "/Applications/ZCode.app/Contents/MacOS/ZCode",
    ));
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs/ZCode/ZCode.exe"));
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("ZCode/ZCode.exe"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr/bin/zcode"));
        candidates.push(PathBuf::from("/opt/ZCode/zcode"));
        candidates.push(PathBuf::from("/opt/zcode/zcode"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "未找到 ZCode 客户端，请先安装 ZCode".to_string())
}

fn is_main_process(process: &sysinfo::Process) -> bool {
    let name = process.name().to_string_lossy().to_ascii_lowercase();
    let command = process
        .cmd()
        .iter()
        .map(|value| value.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    (name == "zcode" || name == "zcode.exe")
        && !command.contains("--type=")
        && !command.contains("crashpad_handler")
}

fn command_matches_profile(command: &[std::ffi::OsString], profile_id: Option<&str>) -> bool {
    match profile_id {
        Some(profile_id) => {
            let expected = format!("{}{}", PROFILE_MARKER_PREFIX, profile_id);
            command.iter().any(|argument| argument == expected.as_str())
        }
        None => command.iter().all(|argument| {
            !argument
                .to_string_lossy()
                .starts_with(PROFILE_MARKER_PREFIX)
        }),
    }
}

pub fn resolve_pid(profile_id: Option<&str>, last_pid: Option<u32>) -> Option<u32> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
    let matches = |process: &sysinfo::Process| {
        if !is_main_process(process) {
            return false;
        }
        command_matches_profile(process.cmd(), profile_id)
    };
    if let Some(pid) = last_pid {
        if system
            .process(sysinfo::Pid::from_u32(pid))
            .is_some_and(matches)
        {
            return Some(pid);
        }
    }
    system
        .processes()
        .iter()
        .find_map(|(pid, process)| matches(process).then(|| pid.as_u32()))
}

fn base_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00000200 | 0x00000008);
    }
    command
}

fn configure_managed_environment(
    command: &mut Command,
    root: &Path,
    instance_name: &str,
    real_home: &Path,
) {
    let electron = root.join("electron");
    let session = electron.join("session");
    let data = root.join("data");
    command
        .env("ZCODE_DESKTOP_USER_DATA_DIR", electron)
        .env("ZCODE_DESKTOP_SESSION_DATA_DIR", session)
        .env("ZCODE_DATA_BASE_DIR", &data)
        .env("ZCODE_DESKTOP_HOME_DIR", &data)
        .env(
            "ZCODE_CREDENTIAL_SECRET",
            modules::zcode_account::credential_secret_for_home(real_home),
        )
        .env("HOME", &data)
        .env("USERPROFILE", &data)
        .env(
            "ZCODE_DESKTOP_APPLICATION_NAME",
            format!("ZCode [{}]", instance_name),
        );
}

pub fn start_default(extra_args: &[String]) -> Result<u32, String> {
    let executable = resolve_executable()?;
    let mut command = base_command(&executable);
    command.args(extra_args);
    let child = command
        .spawn()
        .map_err(|error| format!("启动 ZCode 失败: {}", error))?;
    Ok(child.id())
}

pub fn start_managed(instance: &InstanceProfile, extra_args: &[String]) -> Result<u32, String> {
    let executable = resolve_executable()?;
    let root = Path::new(&instance.user_data_dir);
    initialize_empty_root(root)?;
    sanitize_managed_setting(root)?;
    let real_home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    let mut command = base_command(&executable);
    configure_managed_environment(&mut command, root, &instance.name, &real_home);
    command
        .arg(format!("{}{}", PROFILE_MARKER_PREFIX, instance.id))
        .args(extra_args);
    if let Some(working_dir) = instance
        .working_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.current_dir(working_dir);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("启动 ZCode 多开实例失败: {}", error))?;
    Ok(child.id())
}

pub fn close_all() -> Result<(), String> {
    let store = load_instance_store()?;
    let mut errors = Vec::new();
    if let Some(pid) = resolve_pid(None, store.default_settings.last_pid) {
        if let Err(error) = modules::process::close_pid(pid, 20) {
            errors.push(format!("默认实例: {}", error));
        }
    }
    for instance in &store.instances {
        if let Some(pid) = resolve_pid(Some(&instance.id), instance.last_pid) {
            if let Err(error) = modules::process::close_pid(pid, 20) {
                errors.push(format!("{}: {}", instance.name, error));
            }
        }
    }
    if errors.is_empty() {
        clear_all_pids()
    } else {
        Err(format!("部分 ZCode 实例关闭失败: {}", errors.join("; ")))
    }
}

pub fn is_profile_initialized(root: &Path, is_default: bool) -> bool {
    if is_default {
        return root.exists()
            && modules::zcode_account::default_credentials_path().is_ok_and(|path| path.exists());
    }
    modules::zcode_account::credentials_path_for_instance_root(root).exists()
        || is_non_empty_dir(&root.join("electron"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn default_user_data_paths_match_electron_conventions() {
        let unix_home = Path::new("/Users/zcode-user");
        assert_eq!(
            default_user_data_dir_for("macos", Some(unix_home), None).unwrap(),
            unix_home.join("Library/Application Support/ZCode")
        );
        assert_eq!(
            default_user_data_dir_for("linux", Some(unix_home), None).unwrap(),
            unix_home.join(".config/ZCode")
        );

        let app_data = Path::new(r"C:\Users\zcode-user\AppData\Roaming");
        assert_eq!(
            default_user_data_dir_for("windows", None, Some(app_data)).unwrap(),
            app_data.join("ZCode")
        );
        assert!(default_user_data_dir_for("freebsd", Some(unix_home), None).is_err());
    }

    #[test]
    fn managed_instance_roots_initialize_isolated_electron_and_data_dirs() {
        let parent = make_temp_dir("zcode-instance-isolation");
        let first = parent.join("first");
        let second = parent.join("second");
        initialize_empty_root(&first).unwrap();
        initialize_empty_root(&second).unwrap();

        for root in [&first, &second] {
            assert!(root.join("electron/session").is_dir());
            assert!(root.join("data/.zcode/v2").is_dir());
        }
        let first_credentials = modules::zcode_account::credentials_path_for_instance_root(&first);
        let second_credentials =
            modules::zcode_account::credentials_path_for_instance_root(&second);
        assert_eq!(
            first_credentials,
            first.join("data/.zcode/v2/credentials.json")
        );
        assert_eq!(
            second_credentials,
            second.join("data/.zcode/v2/credentials.json")
        );
        assert_ne!(first_credentials, second_credentials);

        fs::write(&first_credentials, "{}").unwrap();
        assert!(is_profile_initialized(&first, false));
        assert!(is_profile_initialized(&second, false));
        assert!(!second_credentials.exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn managed_setting_cannot_override_instance_data_root() {
        let root = make_temp_dir("zcode-instance-setting");
        initialize_empty_root(&root).unwrap();
        let setting = root.join("data/.zcode/v2/setting.json");
        fs::write(
            &setting,
            r#"{"dataBaseDir":"/Users/shared","desktopChromiumHardwareAccelerationEnabled":false}"#,
        )
        .unwrap();

        sanitize_managed_setting(&root).unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(setting).unwrap()).unwrap();
        assert!(value.get("dataBaseDir").is_none());
        assert_eq!(
            value
                .get("desktopChromiumHardwareAccelerationEnabled")
                .and_then(Value::as_bool),
            Some(false)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_environment_isolates_home_and_preserves_credential_key_material() {
        let root = Path::new("/tmp/zcode-managed-profile");
        let real_home = Path::new("/Users/zcode-user");
        let mut command = Command::new("zcode");
        configure_managed_environment(&mut command, root, "Work", real_home);
        let env: std::collections::HashMap<_, _> = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
            .collect();

        assert_eq!(
            env.get(std::ffi::OsStr::new("HOME")),
            Some(&root.join("data").into_os_string())
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("ZCODE_DATA_BASE_DIR")),
            Some(&root.join("data").into_os_string())
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("ZCODE_DESKTOP_USER_DATA_DIR")),
            Some(&root.join("electron").into_os_string())
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("ZCODE_DESKTOP_SESSION_DATA_DIR")),
            Some(&root.join("electron/session").into_os_string())
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("ZCODE_DESKTOP_APPLICATION_NAME")),
            Some(&std::ffi::OsString::from("ZCode [Work]"))
        );
        assert!(env
            .get(std::ffi::OsStr::new("ZCODE_CREDENTIAL_SECRET"))
            .is_some_and(|value| !value.is_empty()));
    }

    #[test]
    fn process_profile_matching_distinguishes_default_and_managed_instances() {
        let default = vec![
            std::ffi::OsString::from("/Applications/ZCode.app/Contents/MacOS/ZCode"),
            std::ffi::OsString::from("--enable-feature"),
        ];
        assert!(command_matches_profile(&default, None));
        assert!(!command_matches_profile(&default, Some("profile-a")));

        let managed = vec![
            std::ffi::OsString::from("/Applications/ZCode.app/Contents/MacOS/ZCode"),
            std::ffi::OsString::from("--cockpit-zcode-profile=profile-a"),
        ];
        assert!(!command_matches_profile(&managed, None));
        assert!(command_matches_profile(&managed, Some("profile-a")));
        assert!(!command_matches_profile(&managed, Some("profile-b")));
        assert!(!command_matches_profile(&managed, Some("profile")));
    }
}
