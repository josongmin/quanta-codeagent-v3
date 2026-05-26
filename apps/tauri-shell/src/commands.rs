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
