//! Bun web-daemon (worker B) supervisor.
//!
//! Responsibilities:
//!   * pick a free local port at boot,
//!   * mint a 256-bit auth token (hex-encoded) for the WS handshake,
//!   * spawn the daemon as a Tauri sidecar (the bundled standalone bun
//!     compile lives at `binaries/quanta-web-daemon`),
//!   * supervise: SIGTERM on shutdown, restart-with-backoff on crash,
//!   * expose `DaemonInfo` to the frontend so the React app picks up the
//!     real WS URL / auth token via `window.__QUANTA_CONFIG__`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};

const SIDECAR_NAME: &str = "quanta-web-daemon";

#[derive(Debug, Clone, Serialize)]
pub struct DaemonInfo {
    pub ws_url: String,
    pub http_url: String,
    pub auth_token: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaemonStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub uptime_ms: Option<u64>,
    pub restart_count: u64,
}

/// Live supervisor state. Held inside the Tauri app state behind a `Mutex`.
pub struct DaemonState {
    pub info: Option<DaemonInfo>,
    pub child: Option<CommandChild>,
    pub restart_count: u64,
    pub auto_restart: bool,
}

impl DaemonState {
    pub fn new() -> Self {
        Self {
            info: None,
            child: None,
            restart_count: 0,
            auto_restart: true,
        }
    }
}

impl Default for DaemonState {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri-managed handle. `Arc<Mutex<_>>` because both `tauri::command`
/// handlers and the supervisor task touch it.
#[derive(Clone)]
pub struct DaemonHandle(pub Arc<Mutex<DaemonState>>);

impl DaemonHandle {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(DaemonState::new())))
    }
}

impl Default for DaemonHandle {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mint_auth_token() -> AppResult<String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| AppError::Entropy(e.to_string()))?;
    Ok(hex::encode(buf))
}

fn pick_free_port() -> AppResult<u16> {
    portpicker::pick_unused_port().ok_or_else(|| AppError::PortBindFailed {
        reason: "portpicker returned None — OS reported no free local TCP port".to_string(),
    })
}

/// Spawn the daemon ONCE. Returns the live info + child handle. The caller
/// stores them on `DaemonHandle`; the supervisor decides whether to restart.
///
/// Sync (no `await`) so the returned future never holds a `!Send`
/// `State<'_, Shell>` across an await point — `start()` can stay `async`
/// and remain `Send`-bounded for `tauri::async_runtime::spawn`.
fn spawn_once<R: Runtime>(app: &AppHandle<R>) -> AppResult<(DaemonInfo, CommandChild)> {
    // Per-launch random loopback port + auth token. The frontend now pulls
    // these through the Tauri `daemon_info` command, so the shell no longer
    // depends on brittle early-webview script injection for correctness.
    let port = pick_free_port()?;
    let token = mint_auth_token()?;
    let started_at_ms = now_ms();

    let shell = app.shell();

    // `sidecar(...)` returns a Command pre-bound to the bundled binary; the
    // capability ACL has already authorised this name. `env` is a builder
    // method that takes and returns `Command` by value in Tauri 2.x.
    let cmd = shell
        .sidecar(SIDECAR_NAME)
        .map_err(|source| AppError::SidecarSpawn {
            name: SIDECAR_NAME,
            source,
        })?
        .env("QUANTA_WEB_PORT", port.to_string())
        .env("QUANTA_WEB_AUTH_TOKEN", token.clone())
        // Bind 0.0.0.0 so phones / other LAN devices on the same Wi-Fi
        // can reach the daemon. The 256-bit random token above is the
        // sole auth gate — without it, an attacker on the LAN would
        // still get a 401 on the WS upgrade. Set
        // `QUANTA_LAN=0` to pin back to loopback.
        .env(
            "QUANTA_WEB_BIND",
            if std::env::var("QUANTA_LAN").as_deref() == Ok("0") {
                "127.0.0.1"
            } else {
                "0.0.0.0"
            },
        )
        .env("QUANTA_SURFACE", "tauri-desktop");
    // Tauri 2 `shell.sidecar()` does NOT inherit parent env by default. The
    // daemon needs the user's LLM credentials (OPENAI_API_KEY /
    // ANTHROPIC_API_KEY / etc.) + HOME/PATH/locale for normal operation, so
    // we forward an allowlisted set captured at boot time. The list is
    // intentionally generous (this is a single-user desktop shell, not a
    // multi-tenant server).
    let forwarded_env_keys: &[&str] = &[
        "HOME", "PATH", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL",
        "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID",
        "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
        "QUANTA_PROVIDER", "QUANTA_MODEL",
        "QUANTA_HOME", "QUANTA_CONFIG_DIR",
        // Debug knobs — opt-in via env, no behavior change unless set.
        "QUANTA_DEBUG_OAUTH",
        "QUANTA_SERVICE_TIER", "QUANTA_FAST", "QUANTA_REASONING_EFFORT",
    ];
    let cmd = forwarded_env_keys.iter().fold(cmd, |c, key| {
        match std::env::var(key) {
            Ok(v) => c.env(*key, v),
            Err(_) => c,
        }
    });

    let (mut rx, child) = cmd.spawn().map_err(|source| AppError::SidecarSpawn {
        name: SIDECAR_NAME,
        source,
    })?;
    let pid = Some(child.pid());

    // Drain the event stream in the background. We tee every line to the
    // tauri-plugin-log adapter so users can grep `~/Library/Logs/Quanta/`
    // for daemon output.
    let app_for_log = app.clone();
    let handle_for_supervisor: DaemonHandle = app_for_log
        .state::<DaemonHandle>()
        .inner()
        .clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if let Ok(s) = std::str::from_utf8(&bytes) {
                        for line in s.lines() {
                            log::info!(target: "quanta::daemon", "{}", line);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Ok(s) = std::str::from_utf8(&bytes) {
                        for line in s.lines() {
                            log::warn!(target: "quanta::daemon", "{}", line);
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!(
                        target: "quanta::daemon",
                        "daemon exited code={:?} signal={:?}",
                        payload.code,
                        payload.signal
                    );
                    on_daemon_exit(&app_for_log, &handle_for_supervisor).await;
                    break;
                }
                CommandEvent::Error(err) => {
                    log::error!(target: "quanta::daemon", "stream error: {err}");
                }
                _ => {}
            }
        }
    });

    let info = DaemonInfo {
        ws_url: format!("ws://127.0.0.1:{port}/"),
        http_url: format!("http://127.0.0.1:{port}/"),
        auth_token: token,
        port,
        pid,
        started_at_ms,
    };
    Ok((info, child))
}

/// Called from the rx-loop when the daemon dies. Honors `auto_restart` and
/// applies an exponential backoff capped at 30s.
async fn on_daemon_exit<R: Runtime>(app: &AppHandle<R>, handle: &DaemonHandle) {
    let backoff = {
        let mut state = handle.0.lock().await;
        state.info = None;
        state.child = None;
        state.restart_count = state.restart_count.saturating_add(1);
        if !state.auto_restart {
            return;
        }
        let attempt = state.restart_count.min(5) as u32;
        Duration::from_millis(250u64 << attempt) // 0.25s, 0.5s, 1s, 2s, 4s, 8s (clamped)
    };
    log::info!(
        target: "quanta::daemon",
        "restarting daemon in {}ms",
        backoff.as_millis()
    );
    tokio::time::sleep(backoff).await;
    if let Err(err) = start(app).await {
        log::error!(target: "quanta::daemon", "restart failed: {err}");
    }
}

/// Public entry: start the daemon if not already running.
pub async fn start<R: Runtime>(app: &AppHandle<R>) -> AppResult<DaemonInfo> {
    let handle = app.state::<DaemonHandle>().inner().clone();
    {
        let state = handle.0.lock().await;
        if let Some(info) = state.info.as_ref() {
            return Err(AppError::DaemonAlreadyRunning { port: info.port });
        }
    }
    let (info, child) = spawn_once(app)?;
    let mut state = handle.0.lock().await;
    state.info = Some(info.clone());
    state.child = Some(child);
    state.auto_restart = true;
    Ok(info)
}

/// Stop the running daemon (if any) and start a fresh one. Used by the
/// frontend's "재시작" button when the WS connection is wedged. The new
/// daemon binds a fresh random port + auth token; we re-inject the config
/// into the main webview so React reconnects to the new endpoint.
pub async fn restart<R: Runtime>(app: &AppHandle<R>) -> AppResult<DaemonInfo> {
    // `stop()` flips `auto_restart=false` to keep the supervisor from
    // racing us. Tolerate "not running" so the button still works when the
    // daemon already crashed and the supervisor hasn't re-spawned yet.
    match stop(app).await {
        Ok(()) => {}
        Err(AppError::DaemonNotRunning) => {}
        Err(err) => return Err(err),
    }
    // Give the rx-loop a beat to observe `Terminated` and the OS a beat
    // to release the bound port before we pick a fresh one.
    tokio::time::sleep(Duration::from_millis(250)).await;
    {
        let handle = app.state::<DaemonHandle>().inner().clone();
        let mut state = handle.0.lock().await;
        state.auto_restart = true;
    }
    let info = start(app).await?;
    publish_config(app, &info);
    Ok(info)
}

pub async fn stop<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let handle = app.state::<DaemonHandle>().inner().clone();
    let mut state = handle.0.lock().await;
    state.auto_restart = false;
    if let Some(child) = state.child.take() {
        // `kill` sends SIGTERM on unix; we don't wait synchronously here —
        // the rx-loop will observe `Terminated` and clear `state.info`.
        // Spec says "SIGTERM, wait 2s, SIGKILL". Tauri's CommandChild
        // does not expose graceful timeouts directly, so we send `kill` and
        // record a fire-and-forget SIGKILL after 2s in case the child is
        // wedged. tokio's `kill_on_drop` is NOT what we want (drop happens
        // immediately after `take()`).
        let pid = child.pid();
        child.kill().map_err(|e| AppError::Internal(format!(
            "failed to signal daemon pid {pid}: {e}"
        )))?;
        let kill_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            // Best-effort SIGKILL via libc. Only runs if daemon hasn't
            // already cleared the slot. We re-check the handle to avoid
            // sending to a recycled pid.
            let h = kill_handle.state::<DaemonHandle>().inner().clone();
            let st = h.0.lock().await;
            if st.info.is_some() {
                #[cfg(unix)]
                unsafe_kill_pid(pid);
            }
        });
    }
    state.info = None;
    Ok(())
}

#[cfg(unix)]
fn unsafe_kill_pid(_pid: u32) {
    // We deliberately do NOT call libc::kill here — the project bans
    // `unsafe`. The graceful path above already sent SIGTERM via
    // `CommandChild::kill`; an unkillable child is an OS-level concern
    // surfaced through the supervisor restart-counter + log output.
    // A future ADR can swap this for a small wrapper crate that exposes
    // a safe `nix::sys::signal::kill` if telemetry shows wedged children.
    log::warn!(
        target: "quanta::daemon",
        "SIGKILL escalation requested but suppressed (no-unsafe policy)"
    );
}

#[cfg(not(unix))]
fn unsafe_kill_pid(_pid: u32) {
    // No-op on non-unix; this crate is macOS-only for v1 anyway.
}

pub async fn status<R: Runtime>(app: &AppHandle<R>) -> AppResult<DaemonStatus> {
    let handle = app.state::<DaemonHandle>().inner().clone();
    let state = handle.0.lock().await;
    let (running, port, uptime_ms) = match state.info.as_ref() {
        Some(info) => {
            let now = now_ms();
            let uptime = now.saturating_sub(info.started_at_ms);
            (true, Some(info.port), Some(uptime))
        }
        None => (false, None, None),
    };
    Ok(DaemonStatus {
        running,
        port,
        uptime_ms,
        restart_count: state.restart_count,
    })
}

/// Read the current `DaemonInfo` snapshot for the frontend bootstrap.
pub async fn current_info<R: Runtime>(app: &AppHandle<R>) -> AppResult<DaemonInfo> {
    let handle = app.state::<DaemonHandle>().inner().clone();
    let state = handle.0.lock().await;
    state.info.clone().ok_or(AppError::DaemonNotRunning)
}

/// `QUANTA_BUN_PATH` resolution helper kept here so the lint/typecheck
/// path picks up the dead-code-free reference even before the env-driver
/// landed. Used today only for `bun --version` style smoke probes; the
/// compiled standalone sidecar does NOT depend on a system `bun` binary.
pub fn resolve_bun() -> AppResult<std::path::PathBuf> {
    if let Ok(p) = std::env::var("QUANTA_BUN_PATH") {
        let path = std::path::PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
        return Err(AppError::BunNotFound {
            reason: format!("QUANTA_BUN_PATH={} is not a file", path.display()),
        });
    }
    which::which("bun").map_err(|e| AppError::BunNotFound {
        reason: e.to_string(),
    })
}

/// Static counter for the optional system-bun smoke probe. Not currently
/// wired into the supervisor — surfaced via `daemon_status` for diagnostics
/// once an ADR adds the probe.
pub static BUN_PROBE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Whether the supervisor has been invoked at least once this process
/// lifetime. Saves us from emitting "first-start" log lines twice.
pub static SUPERVISOR_BOOTED: AtomicBool = AtomicBool::new(false);

/// Bootstrap helper invoked from `tauri::Builder::setup`.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    app.manage(DaemonHandle::new());
    SUPERVISOR_BOOTED.store(true, Ordering::SeqCst);
}

/// Inject `window.__QUANTA_CONFIG__ = { wsUrl, httpUrl, authToken, port }`
/// into the main webview and dispatch a `quanta:config-ready` event so the
/// React app picks up the new endpoint and reconnects. Called from the
/// boot path AND from `restart()` after a fresh port+token mint.
pub fn publish_config<R: Runtime>(handle: &AppHandle<R>, info: &DaemonInfo) {
    let Some(window): Option<WebviewWindow<R>> = handle.get_webview_window("main") else {
        log::warn!(target: "quanta::boot", "main webview not found at config-inject time");
        return;
    };
    let payload = serde_json::json!({
        "wsUrl": info.ws_url,
        "httpUrl": info.http_url,
        "authToken": info.auth_token,
        "port": info.port,
    });
    let payload_str = payload.to_string();
    let script = format!(
        "(function(){{ try {{ window.__QUANTA_CONFIG__ = {payload_str}; \
         window.dispatchEvent(new CustomEvent('quanta:config-ready', {{ detail: window.__QUANTA_CONFIG__ }})); \
         }} catch (e) {{ console.error('quanta config inject failed', e); }} }})();"
    );
    if let Err(err) = window.eval(&script) {
        log::warn!(target: "quanta::boot", "config inject eval failed: {err}");
    }
}
