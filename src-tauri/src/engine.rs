//! The reliability core: connects to the vast.ai instance over SSH, polls the
//! training output folder, and downloads new `.safetensors` checkpoints as
//! they finish.
//!
//! Transport: the native Windows OpenSSH client (`ssh.exe`, already on Win11).
//! Measured against a live vast instance, `ssh` was ~28x faster than the
//! pure-Rust `russh` SFTP client (2.9 MB/s vs 0.1 MB/s), so we shell out to it.
//! Listing uses `ssh … find …`; each file is downloaded by streaming
//! `ssh … cat …` and writing the bytes to disk ourselves (this avoids `scp`'s
//! Windows bug where a local `C:\…` path is misread as a remote host, and it
//! lets us report live speed/ETA).
//!
//! Reliability (each maps to a failure mode of the old `while rsync` loop):
//!   * Native app, not a WSL terminal -> can't be killed by a closing window.
//!   * The poll loop can NEVER die silently: every error is caught, logged,
//!     and it reconnects with backoff and keeps going.
//!   * Downloads stream to `<name>.part`, the byte count is verified against
//!     the size reported by the remote, then atomically renamed into place.
//!   * A file already present locally at the right size is skipped, so restarts
//!     never re-download and never miss.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

/// Apply the Windows `CREATE_NO_WINDOW` flag so spawned console tools (ssh,
/// curl) don't flash a terminal window over the user's desktop.
#[cfg(windows)]
pub fn hide_console(cmd: &mut Command) {
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
pub fn hide_console(_cmd: &mut Command) {}

/// User-editable connection + sync settings. Persisted to disk as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Raw vast SSH command as pasted (host/port/username are parsed from it in
    /// the UI); kept only to redisplay it. Not used by the engine.
    #[serde(default)]
    pub ssh_command: String,
    /// Path to the OpenSSH private key file on this PC.
    pub key_path: String,
    /// Base directory ai-toolkit writes job outputs into.
    #[serde(default = "default_output_base")]
    pub output_base: String,
    /// Training job name (the folder under `output_base`).
    #[serde(default)]
    pub job_name: String,
    /// Legacy full remote directory (used only if `job_name` is empty).
    #[serde(default)]
    pub remote_dir: String,
    /// Local folder to save checkpoints to.
    pub local_dir: String,
    /// How often to poll the remote folder, in seconds.
    pub poll_secs: u64,
    /// Only files ending with this are downloaded (e.g. ".safetensors").
    pub extension: String,
    /// Optional vast.ai API key, used only to show account credit in the UI.
    #[serde(default)]
    pub vast_api_key: String,
}

impl Default for SyncConfig {
    fn default() -> Self {
        let home = dirs_home();
        Self {
            host: String::new(),
            port: 22,
            username: "root".into(),
            ssh_command: String::new(),
            key_path: home
                .join(".ssh")
                .join("vast_ai")
                .to_string_lossy()
                .into_owned(),
            output_base: default_output_base(),
            job_name: String::new(),
            remote_dir: String::new(),
            local_dir: String::new(),
            poll_secs: 60,
            extension: ".safetensors".into(),
            vast_api_key: String::new(),
        }
    }
}

fn default_output_base() -> String {
    "/workspace/ai-toolkit/output".into()
}

impl SyncConfig {
    /// The effective remote directory: `output_base/job_name` when a job name
    /// is set, otherwise the legacy `remote_dir` (for older saved configs).
    pub fn effective_remote_dir(&self) -> String {
        let job = self.job_name.trim().trim_matches('/');
        if !job.is_empty() {
            format!("{}/{}", self.output_base.trim_end_matches('/'), job)
        } else {
            self.remote_dir.trim_end_matches('/').to_string()
        }
    }
}

fn dirs_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Locate a bundled Windows tool (`ssh.exe`, `curl.exe`), falling back to PATH.
fn openssh_tool(name: &str) -> PathBuf {
    if let Some(windir) = std::env::var_os("WINDIR") {
        let sys32 = PathBuf::from(windir).join("System32");
        for candidate in [sys32.join("OpenSSH").join(name), sys32.join(name)] {
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from(name)
}

/// Standard ssh options for talking to ephemeral vast instances:
/// batch (never prompt/hang), no host-key pinning (keys change every rental),
/// and keepalives so a dead peer is noticed instead of hanging forever.
fn ssh_common_args(cfg: &SyncConfig) -> Vec<String> {
    vec![
        "-i".into(),
        cfg.key_path.clone(),
        "-o".into(),
        "StrictHostKeyChecking=no".into(),
        "-o".into(),
        "UserKnownHostsFile=NUL".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=20".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=4".into(),
        "-o".into(),
        "LogLevel=ERROR".into(),
    ]
}

/// Single-quote a string for a POSIX remote shell.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Snapshot of engine state, pushed to the UI on the `status` event.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub running: bool,
    pub connected: bool,
    /// Machine-readable phase: idle, connecting, listing, downloading,
    /// sleeping, error, stopped.
    pub phase: String,
    pub message: String,
    pub files_total: usize,
    pub files_done: usize,
    pub current_file: Option<String>,
    pub current_done: u64,
    pub current_total: u64,
    /// Current download speed in bytes/sec.
    pub speed_bps: u64,
    /// Estimated seconds remaining for the current file.
    pub eta_secs: u64,
    /// Seconds until the next poll (only meaningful while sleeping).
    pub next_poll_in: u64,
    pub cycles: u64,
    /// The most recently completed checkpoint (persists across updates so the
    /// UI can show it without scrolling the log).
    pub last_saved_name: Option<String>,
    pub last_saved_bytes: u64,
    pub last_saved_at: Option<String>,
    pub last_saved_speed_bps: u64,
}

impl Status {
    fn new() -> Self {
        Self {
            running: true,
            connected: false,
            phase: "connecting".into(),
            message: "Starting…".into(),
            files_total: 0,
            files_done: 0,
            current_file: None,
            current_done: 0,
            current_total: 0,
            speed_bps: 0,
            eta_secs: 0,
            next_poll_in: 0,
            cycles: 0,
            last_saved_name: None,
            last_saved_bytes: 0,
            last_saved_at: None,
            last_saved_speed_bps: 0,
        }
    }

    /// Default state when nothing is running.
    pub fn stopped() -> Self {
        let mut s = Self::new();
        s.running = false;
        s.phase = "stopped".into();
        s.message = "Idle — not running.".into();
        s
    }
}

/// Shared, emit-on-change status. Cloning is cheap (Arc).
#[derive(Clone)]
pub struct StatusReporter {
    app: AppHandle,
    inner: Arc<std::sync::Mutex<Status>>,
}

impl StatusReporter {
    /// `inner` is shared with the app state so the UI can also poll it.
    pub fn new(app: AppHandle, inner: Arc<std::sync::Mutex<Status>>) -> Self {
        *inner.lock().unwrap() = Status::new();
        Self { app, inner }
    }

    fn update(&self, f: impl FnOnce(&mut Status)) {
        let snapshot = {
            let mut s = self.inner.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        let _ = self.app.emit("status", snapshot);
    }

    fn log(&self, level: &str, msg: impl Into<String>) {
        let msg = msg.into();
        let line = LogLine {
            ts: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            level: level.to_string(),
            msg: msg.clone(),
        };
        eprintln!("[{}] {}: {}", line.ts, line.level, msg);
        let _ = self.app.emit("log", line);
    }
}

#[derive(Debug, Clone, Serialize)]
struct LogLine {
    ts: String,
    level: String,
    msg: String,
}

/// The public entry point: runs until `stop` is set. Never panics out; any
/// error is logged and retried. Returns only when stop is requested.
pub async fn run(cfg: SyncConfig, stop: Arc<AtomicBool>, reporter: StatusReporter) {
    reporter.log(
        "info",
        format!(
            "Sync started. {}@{}:{}  {}  ->  {}",
            cfg.username, cfg.host, cfg.port, cfg.effective_remote_dir(), cfg.local_dir
        ),
    );

    let mut backoff = 5u64;
    let mut cycles = 0u64;

    while !stop.load(Ordering::Relaxed) {
        match one_cycle(&cfg, &stop, &reporter, cycles).await {
            Ok(_) => {
                backoff = 5;
                cycles += 1;
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                sleep_interruptible(cfg.poll_secs, &stop, &reporter, cycles).await;
            }
            Err(e) => {
                reporter.update(|s| {
                    s.connected = false;
                    s.phase = "error".into();
                    s.current_file = None;
                    s.speed_bps = 0;
                    s.message = format!("Problem: {e}");
                });
                reporter.log("error", format!("Cycle failed: {e}. Retrying in {backoff}s."));
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                sleep_reconnect(backoff, &stop, &reporter).await;
                backoff = (backoff * 2).min(60);
            }
        }
    }

    reporter.update(|s| {
        s.running = false;
        s.connected = false;
        s.phase = "stopped".into();
        s.current_file = None;
        s.speed_bps = 0;
        s.next_poll_in = 0;
        s.message = "Stopped.".into();
    });
    reporter.log("info", "Sync stopped.");
}

/// One full list -> download-all cycle.
async fn one_cycle(
    cfg: &SyncConfig,
    stop: &Arc<AtomicBool>,
    reporter: &StatusReporter,
    cycles: u64,
) -> anyhow::Result<()> {
    let local_dir = PathBuf::from(&cfg.local_dir);
    if cfg.local_dir.trim().is_empty() {
        anyhow::bail!("Local download folder is not set");
    }
    tokio::fs::create_dir_all(&local_dir)
        .await
        .map_err(|e| anyhow::anyhow!("Cannot create local folder {}: {e}", local_dir.display()))?;

    reporter.update(|s| {
        s.phase = "listing".into();
        s.message = format!("Checking {}:{}…", cfg.host, cfg.port);
    });

    // --- Discover fast tunnel + list checkpoints (one ssh call) ----------
    let Discovery {
        token,
        tunnel,
        files: remote_files,
    } = discover_and_list(cfg, stop).await?;
    // Fast path is available only when we found both a tunnel URL and a token.
    let http = token.as_ref().zip(tunnel.as_ref());

    reporter.update(|s| s.connected = true);

    if cycles == 0 {
        match http {
            Some((_, t)) => reporter.log(
                "info",
                format!("Fast path enabled — downloading over Cloudflare tunnel ({t})."),
            ),
            None => reporter.log(
                "info",
                "No Cloudflare tunnel found — using direct SSH transfer (slower).",
            ),
        }
    }

    // Decide what still needs downloading. ai-toolkit writes each checkpoint
    // atomically (a file only appears once fully saved), so anything not
    // already present locally at the right size is downloaded immediately.
    let mut done_count = 0usize;
    let mut pending: Vec<(String, u64)> = Vec::new();
    for (name, size) in &remote_files {
        let local_path = local_dir.join(name);
        if let Ok(md) = std::fs::metadata(&local_path) {
            if md.len() == *size && *size > 0 {
                done_count += 1;
                continue;
            }
        }
        pending.push((name.clone(), *size));
    }

    let total = remote_files.len();
    reporter.update(|s| {
        s.phase = if pending.is_empty() { "idle".into() } else { "downloading".into() };
        s.files_total = total;
        s.files_done = done_count;
        s.message = if pending.is_empty() {
            format!("Up to date. {done_count}/{total} checkpoints present.")
        } else {
            format!("{} new checkpoint(s) to download.", pending.len())
        };
    });

    if pending.is_empty() && cycles == 0 {
        reporter.log(
            "info",
            format!("{done_count}/{total} checkpoints already present locally."),
        );
    }

    let remote_dir = cfg.effective_remote_dir();
    for (name, size) in pending {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let remote_path = format!("{}/{}", remote_dir, name);
        let final_path = local_dir.join(&name);

        reporter.log("info", format!("Downloading {name} ({})…", human(size)));
        reporter.update(|s| {
            s.phase = "downloading".into();
            s.current_file = Some(name.clone());
            s.current_done = 0;
            s.current_total = size;
            s.speed_bps = 0;
            s.message = format!("Downloading {name}");
        });

        let started = Instant::now();
        // Try the fast Cloudflare-tunnel HTTP path; fall back to SSH on failure.
        let result = match http {
            Some((tok, tun)) => {
                let abs = format!("{}/{}", remote_dir, name);
                let url = format!(
                    "{}/api/files/{}?token={}",
                    tun.trim_end_matches('/'),
                    encode_uri_component(&abs),
                    tok
                );
                match download_via_curl(&url, &final_path, size, stop, reporter, &name).await {
                    Err(e) if !stop.load(Ordering::Relaxed) => {
                        reporter.log(
                            "info",
                            format!("Tunnel download failed ({e}); falling back to SSH for {name}."),
                        );
                        download_via_ssh_cat(cfg, &remote_path, &final_path, size, stop, reporter, &name)
                            .await
                    }
                    other => other,
                }
            }
            None => {
                download_via_ssh_cat(cfg, &remote_path, &final_path, size, stop, reporter, &name).await
            }
        };

        match result {
            Ok(true) => {
                done_count += 1;
                let secs = started.elapsed().as_secs_f64().max(0.001);
                let avg = (size as f64) / secs;
                reporter.log(
                    "info",
                    format!("✔ Saved {name} ({}) at {}/s avg", human(size), human(avg as u64)),
                );
                let at = chrono::Local::now().format("%H:%M:%S").to_string();
                reporter.update(|s| {
                    s.files_done = done_count;
                    s.current_file = None;
                    s.speed_bps = 0;
                    s.last_saved_name = Some(name.clone());
                    s.last_saved_bytes = size;
                    s.last_saved_at = Some(at);
                    s.last_saved_speed_bps = avg as u64;
                });
            }
            Ok(false) => {
                reporter.log(
                    "info",
                    format!("Download of {name} interrupted (will resume next run)."),
                );
            }
            Err(e) => {
                reporter.log("error", format!("Failed to download {name}: {e}"));
                reporter.update(|s| {
                    s.current_file = None;
                    s.speed_bps = 0;
                });
            }
        }
    }

    reporter.update(|s| {
        s.current_file = None;
        s.speed_bps = 0;
        if s.phase != "stopped" {
            s.phase = "idle".into();
        }
    });

    Ok(())
}

/// Result of the per-cycle discovery + listing ssh call.
struct Discovery {
    /// Portal auth token (for the Cloudflare-tunnel HTTP download), if found.
    token: Option<String>,
    /// AI Toolkit Cloudflare tunnel base URL, if found.
    tunnel: Option<String>,
    /// Matching checkpoint files as `(filename, size)`.
    files: Vec<(String, u64)>,
}

/// One ssh call that: (1) prints the AI Toolkit portal token, (2) prints the
/// AI Toolkit Cloudflare tunnel URL (both come from the standard vast.ai
/// "portal-aio" image — used to download over Cloudflare's fast edge instead
/// of the slow direct-IP path), and (3) lists checkpoint files. If the token /
/// tunnel aren't found (non-vast image), those are None and we fall back to a
/// direct SSH transfer.
async fn discover_and_list(
    cfg: &SyncConfig,
    stop: &Arc<AtomicBool>,
) -> anyhow::Result<Discovery> {
    let ssh = openssh_tool("ssh.exe");

    let remote_cmd = format!(
        "printf 'TOKEN\\t%s\\n' \"$(printenv OPEN_BUTTON_TOKEN 2>/dev/null || grep -aoE '[a-f0-9]{{64}}' /etc/Caddyfile 2>/dev/null | head -1)\"; \
         printf 'TUNNEL\\t%s\\n' \"$(grep -a 'AI Toolkit' /var/log/portal/tunnel_manager.log 2>/dev/null | grep -aoE 'https://[a-z0-9.-]+\\.trycloudflare\\.com' | tail -1)\"; \
         find {dir} -maxdepth 1 -type f -name {pat} -printf 'FILE\\t%s\\t%f\\n'",
        dir = sh_quote(&cfg.effective_remote_dir()),
        pat = sh_quote(&format!("*{}", cfg.extension)),
    );

    let mut args = ssh_common_args(cfg);
    args.push("-p".into());
    args.push(cfg.port.to_string());
    args.push(format!("{}@{}", cfg.username, cfg.host));
    args.push(remote_cmd);

    let mut cmd = Command::new(&ssh);
    cmd.args(&args);
    hide_console(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(45), cmd.output())
        .await
        .map_err(|_| anyhow::anyhow!("Timed out contacting the instance"))?
        .map_err(|e| anyhow::anyhow!("Could not run ssh ({}): {e}", ssh.display()))?;

    if stop.load(Ordering::Relaxed) {
        return Ok(Discovery { token: None, tunnel: None, files: Vec::new() });
    }

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        anyhow::bail!(
            "ssh failed{}",
            if err.is_empty() { String::new() } else { format!(": {err}") }
        );
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut token = None;
    let mut tunnel = None;
    let mut files: Vec<(String, u64)> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(v) = line.strip_prefix("TOKEN\t") {
            let v = v.trim();
            if !v.is_empty() {
                token = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("TUNNEL\t") {
            let v = v.trim();
            if v.starts_with("https://") {
                tunnel = Some(v.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("FILE\t") {
            if let Some((size_str, name)) = rest.split_once('\t') {
                if let Ok(size) = size_str.trim().parse::<u64>() {
                    if !name.is_empty() {
                        files.push((name.to_string(), size));
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(Discovery { token, tunnel, files })
}

/// Percent-encodes a string the way JavaScript's `encodeURIComponent` does
/// (the UI builds download URLs as `/api/files/${encodeURIComponent(path)}`).
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        let unreserved = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if unreserved {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// Downloads one file over HTTP(S) using the bundled `curl.exe`, streaming to
/// `<final>.part` while reporting live speed, then verifying size and renaming.
/// Returns Ok(true) if complete, Ok(false) if interrupted by stop.
async fn download_via_curl(
    url: &str,
    final_path: &Path,
    expected: u64,
    stop: &Arc<AtomicBool>,
    reporter: &StatusReporter,
    name: &str,
) -> anyhow::Result<bool> {
    let curl = openssh_tool("curl.exe"); // same finder: System32\curl.exe, else PATH
    let part_path = with_part_extension(final_path);
    let _ = tokio::fs::remove_file(&part_path).await;

    let mut cmd = Command::new(&curl);
    cmd.arg("-sS")
        .arg("--fail")
        .arg("--location")
        .arg("--connect-timeout")
        .arg("30")
        // Abort (so we can retry / fall back) if the transfer stalls below
        // 50 KB/s for 30s — never hang forever.
        .arg("--speed-limit")
        .arg("51200")
        .arg("--speed-time")
        .arg("30")
        .arg("-o")
        .arg(&part_path)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow::anyhow!("Could not run curl ({}): {e}", curl.display()))?;

    let mut stderr = child.stderr.take().expect("stderr piped");

    let mut last_bytes: u64 = 0;
    let mut last_emit = Instant::now();
    let mut smoothed_bps: f64 = 0.0;

    loop {
        if stop.load(Ordering::Relaxed) {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = tokio::fs::remove_file(&part_path).await;
            return Ok(false);
        }

        if let Some(status) = child.try_wait().map_err(|e| anyhow::anyhow!("wait curl: {e}"))? {
            // Final progress tick.
            let written = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
            let mut err_buf = Vec::new();
            let _ = stderr.read_to_end(&mut err_buf).await;
            let err_msg = String::from_utf8_lossy(&err_buf).trim().to_string();

            if !status.success() {
                let _ = tokio::fs::remove_file(&part_path).await;
                anyhow::bail!(
                    "curl failed{}",
                    if err_msg.is_empty() { String::new() } else { format!(": {err_msg}") }
                );
            }
            if expected > 0 && written != expected {
                let _ = tokio::fs::remove_file(&part_path).await;
                anyhow::bail!("size mismatch: got {written} bytes, expected {expected}");
            }
            break;
        }

        tokio::time::sleep(Duration::from_millis(400)).await;
        let written = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        maybe_emit(
            reporter, name, written, expected, &mut smoothed_bps, &mut last_bytes, &mut last_emit, true,
        );
    }

    if tokio::fs::try_exists(final_path).await.unwrap_or(false) {
        let _ = tokio::fs::remove_file(final_path).await;
    }
    tokio::fs::rename(&part_path, final_path)
        .await
        .map_err(|e| anyhow::anyhow!("finalize (rename) failed: {e}"))?;

    reporter.update(|s| {
        s.current_done = expected;
        s.current_total = expected;
        s.speed_bps = 0;
    });
    Ok(true)
}

/// Downloads one remote file by streaming `ssh … cat` and writing the bytes to
/// `<final>.part`, then verifies the size and atomically renames it into place.
/// Returns Ok(true) if complete, Ok(false) if interrupted by stop.
async fn download_via_ssh_cat(
    cfg: &SyncConfig,
    remote_path: &str,
    final_path: &Path,
    expected: u64,
    stop: &Arc<AtomicBool>,
    reporter: &StatusReporter,
    name: &str,
) -> anyhow::Result<bool> {
    let ssh = openssh_tool("ssh.exe");
    let part_path = with_part_extension(final_path);

    let remote_cmd = format!("cat -- {}", sh_quote(remote_path));
    let mut args = ssh_common_args(cfg);
    args.push("-p".into());
    args.push(cfg.port.to_string());
    args.push(format!("{}@{}", cfg.username, cfg.host));
    args.push(remote_cmd);

    let mut cmd = Command::new(&ssh);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow::anyhow!("Could not run ssh ({}): {e}", ssh.display()))?;

    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");

    let mut out = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| anyhow::anyhow!("create {}: {e}", part_path.display()))?;

    let mut buf = vec![0u8; 1024 * 1024];
    let mut written: u64 = 0;
    let mut last_emit = Instant::now();
    let mut last_bytes: u64 = 0;
    let mut smoothed_bps: f64 = 0.0;

    let interrupted = loop {
        if stop.load(Ordering::Relaxed) {
            let _ = child.start_kill();
            break true;
        }

        // Read with a timeout so a stall doesn't block stop. `read` is
        // cancel-safe, so timing out never drops bytes.
        let n = match tokio::time::timeout(Duration::from_millis(500), stdout.read(&mut buf)).await {
            Ok(Ok(0)) => break false, // EOF
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(anyhow::anyhow!("read from ssh: {e}")),
            Err(_) => {
                // Timeout: refresh speed (likely 0) and loop to re-check stop.
                maybe_emit(reporter, name, written, expected, &mut smoothed_bps, &mut last_bytes, &mut last_emit, true);
                continue;
            }
        };

        out.write_all(&buf[..n])
            .await
            .map_err(|e| anyhow::anyhow!("write local: {e}"))?;
        written += n as u64;

        maybe_emit(reporter, name, written, expected, &mut smoothed_bps, &mut last_bytes, &mut last_emit, false);
    };

    out.flush().await.ok();
    let _ = out.sync_all().await;
    drop(out);

    if interrupted {
        let _ = child.wait().await;
        return Ok(false);
    }

    // Drain remaining stderr and reap the process.
    let mut err_buf = Vec::new();
    let _ = stderr.read_to_end(&mut err_buf).await;
    let status = child.wait().await.map_err(|e| anyhow::anyhow!("wait ssh: {e}"))?;
    let err_msg = String::from_utf8_lossy(&err_buf).trim().to_string();

    if !status.success() {
        let _ = tokio::fs::remove_file(&part_path).await;
        anyhow::bail!(
            "ssh exited with error{}",
            if err_msg.is_empty() { String::new() } else { format!(": {err_msg}") }
        );
    }

    if expected > 0 && written != expected {
        let _ = tokio::fs::remove_file(&part_path).await;
        anyhow::bail!(
            "size mismatch: got {written} bytes, expected {expected}. Discarded partial file.{}",
            if err_msg.is_empty() { String::new() } else { format!(" ({err_msg})") }
        );
    }

    if tokio::fs::try_exists(final_path).await.unwrap_or(false) {
        let _ = tokio::fs::remove_file(final_path).await;
    }
    tokio::fs::rename(&part_path, final_path)
        .await
        .map_err(|e| anyhow::anyhow!("finalize (rename) failed: {e}"))?;

    reporter.update(|s| {
        s.current_done = expected;
        s.current_total = expected;
        s.speed_bps = 0;
    });
    Ok(true)
}

/// Throttled progress emit with exponentially-smoothed speed + ETA.
#[allow(clippy::too_many_arguments)]
fn maybe_emit(
    reporter: &StatusReporter,
    name: &str,
    written: u64,
    expected: u64,
    smoothed_bps: &mut f64,
    last_bytes: &mut u64,
    last_emit: &mut Instant,
    force: bool,
) {
    let dt = last_emit.elapsed().as_secs_f64();
    if !force && dt < 0.4 {
        return;
    }
    if dt > 0.0 {
        let inst = (written.saturating_sub(*last_bytes)) as f64 / dt;
        // EMA to keep the number readable.
        *smoothed_bps = if *smoothed_bps == 0.0 {
            inst
        } else {
            0.6 * *smoothed_bps + 0.4 * inst
        };
    }
    *last_bytes = written;
    *last_emit = Instant::now();

    let bps = *smoothed_bps;
    let eta = if bps > 1.0 && expected > written {
        ((expected - written) as f64 / bps) as u64
    } else {
        0
    };

    let name = name.to_string();
    reporter.update(move |s| {
        s.current_file = Some(name);
        s.current_done = written;
        s.current_total = expected;
        s.speed_bps = bps as u64;
        s.eta_secs = eta;
    });
}

fn with_part_extension(final_path: &Path) -> PathBuf {
    let mut name = final_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.push_str(".part");
    final_path.with_file_name(name)
}

/// Sleep between successful polls while counting down for the UI.
async fn sleep_interruptible(
    secs: u64,
    stop: &Arc<AtomicBool>,
    reporter: &StatusReporter,
    cycles: u64,
) {
    reporter.update(|s| {
        s.cycles = cycles;
        if s.phase != "stopped" && s.phase != "error" {
            s.phase = "sleeping".into();
        }
        s.next_poll_in = secs;
        s.current_file = None;
        s.speed_bps = 0;
        s.message = format!("Waiting {secs}s until next check…");
    });

    let mut left = secs;
    while left > 0 {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        for _ in 0..4 {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        left = left.saturating_sub(1);
        reporter.update(|s| {
            if s.phase == "sleeping" {
                s.next_poll_in = left;
                s.message = format!("Waiting {left}s until next check…");
            }
        });
    }
}

/// Sleep during reconnect backoff, honouring stop quickly.
async fn sleep_reconnect(secs: u64, stop: &Arc<AtomicBool>, reporter: &StatusReporter) {
    let mut left = secs;
    while left > 0 {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        reporter.update(|s| {
            s.phase = "error".into();
            s.next_poll_in = left;
            s.message = format!("Retrying in {left}s…");
        });
        for _ in 0..4 {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        left = left.saturating_sub(1);
    }
}

/// Human-readable byte size.
fn human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.2} {}", UNITS[i])
    }
}
