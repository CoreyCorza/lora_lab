mod engine;

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

use engine::{Status, StatusReporter, SyncConfig};

// ------------------------- python analysis bridge ---------------------------

/// The analysis backend, embedded at compile time so distributed builds are
/// self-contained. Materialized to the temp dir on first use (and whenever it
/// changes between versions).
const TOOL_PY: &str = include_str!("../../python/lora_tool.py");

fn ensure_script() -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join("lora_lab_tool.py");
    let stale = match std::fs::read_to_string(&path) {
        Ok(existing) => existing != TOOL_PY,
        Err(_) => true,
    };
    if stale {
        std::fs::write(&path, TOOL_PY).map_err(|e| format!("failed to write tool script: {e}"))?;
    }
    Ok(path)
}

fn spawn_python(python: &str, script: &std::path::Path, args: &[String]) -> std::io::Result<std::process::Output> {
    let mut cmd = Command::new(python);
    cmd.arg(script).args(args);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    cmd.output()
}

#[tauri::command]
async fn run_tool(python: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let script = ensure_script()?;
        // Fall back to a PATH python if the configured interpreter can't launch,
        // so fresh installs work without touching settings first.
        let out = spawn_python(&python, &script, &args)
            .or_else(|first_err| {
                if python != "python" {
                    spawn_python("python", &script, &args).map_err(|_| first_err)
                } else {
                    Err(first_err)
                }
            })
            .map_err(|e| {
                format!("failed to launch python ({python}): {e} — set a python path (any python with numpy) in the gear menu")
            })?;
        if !out.status.success() && out.stdout.is_empty() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----------------------- autodownload (vast.ai sync) -------------------------

/// Handle to the currently running sync engine (if any).
struct EngineHandle {
    stop: Arc<AtomicBool>,
    #[allow(dead_code)]
    task: tauri::async_runtime::JoinHandle<()>,
}

/// Application state shared across commands.
struct AppState {
    engine: Mutex<Option<EngineHandle>>,
    /// Live status snapshot, shared with the running engine's reporter.
    status: Arc<Mutex<Status>>,
}

fn config_file(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    dir.join("sync_config.json")
}

fn load_config(app: &AppHandle) -> SyncConfig {
    let path = config_file(app);
    if let Ok(txt) = std::fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<SyncConfig>(&txt) {
            return cfg;
        }
    }
    SyncConfig::default()
}

fn save_config_to_disk(app: &AppHandle, cfg: &SyncConfig) -> Result<(), String> {
    let path = config_file(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let txt = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, txt).map_err(|e| e.to_string())
}

#[tauri::command]
fn sync_get_config(app: AppHandle) -> SyncConfig {
    load_config(&app)
}

#[tauri::command]
fn sync_save_config(app: AppHandle, config: SyncConfig) -> Result<(), String> {
    save_config_to_disk(&app, &config)
}

#[tauri::command]
fn sync_status(state: State<'_, AppState>) -> Status {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
fn start_sync(app: AppHandle, config: SyncConfig) -> Result<(), String> {
    begin_sync(&app, config)
}

/// Validates config and spawns the sync engine. Shared by the Start button and
/// the LORALAB_AUTOSYNC launch path.
fn begin_sync(app: &AppHandle, config: SyncConfig) -> Result<(), String> {
    if config.host.trim().is_empty() {
        return Err("Host / IP is required — paste the vast SSH command.".into());
    }
    if config.username.trim().is_empty() {
        return Err("Username is required (usually 'root' for vast.ai).".into());
    }
    if config.key_path.trim().is_empty() || !std::path::Path::new(&config.key_path).exists() {
        return Err(format!("SSH key file not found: {}", config.key_path));
    }
    if config.effective_remote_dir().trim().is_empty() {
        return Err("Training job name (or remote folder) is required.".into());
    }
    if config.local_dir.trim().is_empty() {
        return Err("Local download folder is required.".into());
    }
    if config.poll_secs == 0 {
        return Err("Poll interval must be at least 1 second.".into());
    }

    let state = app.state::<AppState>();
    let mut guard = state.engine.lock().unwrap();
    if guard.is_some() {
        return Err("Autodownload is already running.".into());
    }

    save_config_to_disk(app, &config)?;

    let stop = Arc::new(AtomicBool::new(false));
    let reporter = StatusReporter::new(app.clone(), state.status.clone());

    let stop_for_task = stop.clone();
    let task = tauri::async_runtime::spawn(async move {
        engine::run(config, stop_for_task, reporter).await;
    });

    *guard = Some(EngineHandle { stop, task });
    Ok(())
}

#[tauri::command]
fn stop_sync(state: State<'_, AppState>) -> Result<(), String> {
    let handle = state.engine.lock().unwrap().take();
    if let Some(h) = handle {
        h.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(&path)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct CreditInfo {
    credit: f64,
    email: Option<String>,
}

/// Fetches the vast.ai account credit via the public API (using bundled curl).
#[tauri::command]
async fn get_vast_credit(api_key: String) -> Result<CreditInfo, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("No API key set".into());
    }

    let curl = std::env::var_os("WINDIR")
        .map(|w| PathBuf::from(w).join("System32").join("curl.exe"))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("curl.exe"));

    let url = format!(
        "https://console.vast.ai/api/v0/users/current/?api_key={}",
        urlencode(key)
    );

    // No --fail: on an HTTP error vast returns a JSON body with a useful
    // message, which we want to surface instead of a generic curl error.
    let mut cmd = tokio::process::Command::new(&curl);
    cmd.arg("-sS").arg("--max-time").arg("20").arg(&url);
    engine::hide_console(&mut cmd);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Could not run curl: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "Network error contacting vast.ai".into()
        } else {
            err
        });
    }

    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("Unexpected API response: {e}"))?;

    match v.get("credit").and_then(|c| c.as_f64()) {
        Some(credit) => {
            let email = v.get("email").and_then(|e| e.as_str()).map(String::from);
            Ok(CreditInfo { credit, email })
        }
        None => {
            let msg = v
                .get("msg")
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str())
                .unwrap_or("vast.ai API returned no credit (check the API key)");
            Err(msg.to_string())
        }
    }
}

/// Minimal percent-encoding for an API key placed in a query string.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// --------------------------------- setup ------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState {
            engine: Mutex::new(None),
            status: Arc::new(Mutex::new(Status::stopped())),
        })
        .invoke_handler(tauri::generate_handler![
            run_tool,
            sync_get_config,
            sync_save_config,
            sync_status,
            start_sync,
            stop_sync,
            open_folder,
            get_vast_credit,
        ])
        .setup(|app| {
            // ---- System tray so autodownload survives closing the window ----
            let show = MenuItemBuilder::with_id("show", "Show window").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit (stops downloads)").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("LoRA Lab")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Optional: auto-start downloading on launch (e.g. pinned to Windows
            // startup) if LORALAB_AUTOSYNC is set and saved settings are complete.
            if std::env::var("LORALAB_AUTOSYNC").is_ok() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    let cfg = load_config(&handle);
                    match begin_sync(&handle, cfg) {
                        Ok(()) => eprintln!("[autosync] started"),
                        Err(e) => eprintln!("[autosync] not started: {e}"),
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray ONLY while an autodownload run is active, so a
            // download keeps going overnight. With no run active, close quits
            // like a normal app.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let running = {
                    let state = window.app_handle().state::<AppState>();
                    let guard = state.engine.lock().unwrap();
                    guard.is_some()
                };
                if running {
                    let _ = window.hide();
                    api.prevent_close();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
