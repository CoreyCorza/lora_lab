use std::process::Command;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![run_tool])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
