//! `#[tauri::command]` surface — the only entry points the frontend invokes.
//!
//! Every command returns `Result<T, AppError>`. The error type's `Serialize`
//! impl (see `error.rs`) lands on the JS side as `{ code, message }`.

use tauri::{AppHandle, Runtime};

use crate::daemon::{self, DaemonInfo, DaemonStatus};
use crate::error::AppResult;
use crate::hotkey;
use crate::ocr::{self, CaptureResult, WindowInfo};

#[tauri::command]
pub async fn list_windows<R: Runtime>(app: AppHandle<R>) -> AppResult<Vec<WindowInfo>> {
    ocr::list_windows(&app).await
}

#[tauri::command]
pub async fn capture_window<R: Runtime>(
    app: AppHandle<R>,
    window_id: u32,
) -> AppResult<CaptureResult> {
    ocr::capture_window(&app, window_id).await
}

#[tauri::command]
pub async fn start_daemon<R: Runtime>(app: AppHandle<R>) -> AppResult<DaemonInfo> {
    daemon::start(&app).await
}

#[tauri::command]
pub async fn stop_daemon<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    daemon::stop(&app).await
}

#[tauri::command]
pub async fn restart_daemon<R: Runtime>(app: AppHandle<R>) -> AppResult<DaemonInfo> {
    daemon::restart(&app).await
}

#[tauri::command]
pub async fn daemon_status<R: Runtime>(app: AppHandle<R>) -> AppResult<DaemonStatus> {
    daemon::status(&app).await
}

#[tauri::command]
pub async fn daemon_info<R: Runtime>(app: AppHandle<R>) -> AppResult<DaemonInfo> {
    daemon::current_info(&app).await
}

#[tauri::command]
pub async fn enable_hotkey<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    hotkey::enable(&app).await
}

#[tauri::command]
pub async fn disable_hotkey<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    hotkey::disable(&app).await
}

#[tauri::command]
pub fn hotkey_status<R: Runtime>(app: AppHandle<R>) -> AppResult<bool> {
    Ok(hotkey::is_enabled(&app))
}

/// Open `url` in the user's default OS browser (macOS `open`). Used by the
/// frontend's `/login` slash to escape the Tauri webview — `window.open`
/// is silently no-op'd by WKWebView for `_blank` targets without explicit
/// capability, and a normal browser's popup-blocker bites in `async`
/// contexts. So we shell out from Rust, which has no such restriction.
///
/// URL host is allowlisted to OpenAI / ChatGPT issuers so a compromised
/// frontend asset can't weaponize this command for arbitrary navigation.
#[tauri::command]
pub fn open_external_url(url: String) -> AppResult<()> {
    use crate::error::AppError;
    // Parse without `url` crate so we don't add a transitive dep just for
    // host extraction. The host allowlist below is the security boundary.
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| AppError::Internal(format!("only https urls allowed: {url}")))?;
    let host_end = rest
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    let host_and_port = &rest[..host_end];
    let host = host_and_port.split(':').next().unwrap_or(host_and_port);
    let allowed = matches!(
        host,
        "auth.openai.com"
            | "chat.openai.com"
            | "chatgpt.com"
            | "openai.com"
            | "platform.openai.com"
    );
    if !allowed {
        return Err(AppError::Internal(format!(
            "host not allowlisted for open_external_url: {host}"
        )));
    }
    std::process::Command::new("/usr/bin/open")
        .arg(&url)
        .status()
        .map_err(|e| AppError::Internal(format!("open spawn failed: {e}")))?;
    Ok(())
}
