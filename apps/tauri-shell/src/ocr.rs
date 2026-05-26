//! Screen-OCR sidecar driver.
//!
//! Wraps the Swift `screen-ocr` binary (worker E). Spawns it via Tauri's
//! `shell` plugin, which enforces the allowlist declared in
//! `capabilities/default.json`. Each invocation is one-shot: we collect
//! stdout/stderr to completion and parse the JSON envelope.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

use crate::error::{AppError, AppResult};

const SIDECAR_NAME: &str = "binaries/screen-ocr";

/// Window descriptor returned by `screen-ocr list-windows`. Field set is
/// intentionally minimal so the Swift sidecar can evolve without churn here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub id: u32,
    pub app: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ListWindowsEnvelope {
    windows: Vec<WindowInfo>,
}

/// Bounding box from OCR — pixel coordinates in the captured window's frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bbox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrLine {
    pub text: String,
    pub bbox: Bbox,
    pub conf: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureResult {
    pub text: String,
    pub lines: Vec<OcrLine>,
}

/// Spawn the sidecar, drain stdout/stderr, parse JSON.
///
/// `args` is forwarded directly to the sidecar; the capability ACL pins
/// the allowed argument shapes.
async fn run_sidecar<R: Runtime>(
    app: &AppHandle<R>,
    args: Vec<String>,
) -> AppResult<serde_json::Value> {
    let shell = app.shell();
    let command = shell
        .sidecar(SIDECAR_NAME)
        .map_err(|source| AppError::SidecarSpawn {
            name: SIDECAR_NAME,
            source,
        })?
        .args(args);

    let (mut rx, _child) = command
        .spawn()
        .map_err(|source| AppError::SidecarSpawn {
            name: SIDECAR_NAME,
            source,
        })?;

    let mut stdout = Vec::<u8>::new();
    let mut stderr = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout.extend_from_slice(&bytes),
            CommandEvent::Stderr(bytes) => {
                if let Ok(s) = std::str::from_utf8(&bytes) {
                    stderr.push_str(s);
                }
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            CommandEvent::Error(err) => {
                return Err(AppError::Internal(format!(
                    "sidecar `{SIDECAR_NAME}` event-stream error: {err}"
                )));
            }
            _ => {}
        }
    }

    let status = exit_code.unwrap_or(-1);
    if status != 0 {
        return Err(AppError::SidecarExit {
            name: SIDECAR_NAME,
            status,
            stderr,
        });
    }

    serde_json::from_slice::<serde_json::Value>(&stdout).map_err(|source| {
        AppError::SidecarJson {
            name: SIDECAR_NAME,
            source,
        }
    })
}

pub async fn list_windows<R: Runtime>(app: &AppHandle<R>) -> AppResult<Vec<WindowInfo>> {
    let value = run_sidecar(app, vec!["list-windows".to_string()]).await?;
    let envelope: ListWindowsEnvelope =
        serde_json::from_value(value).map_err(|source| AppError::SidecarJson {
            name: SIDECAR_NAME,
            source,
        })?;
    Ok(envelope.windows)
}

pub async fn capture_window<R: Runtime>(
    app: &AppHandle<R>,
    window_id: u32,
) -> AppResult<CaptureResult> {
    let value = run_sidecar(
        app,
        vec![
            "capture".to_string(),
            "--window-id".to_string(),
            window_id.to_string(),
        ],
    )
    .await?;
    let result: CaptureResult =
        serde_json::from_value(value).map_err(|source| AppError::SidecarJson {
            name: SIDECAR_NAME,
            source,
        })?;
    Ok(result)
}

/// In-memory store of the last window the user selected. The hotkey path
/// falls back to "frontmost non-Quanta window" when no prior selection.
#[derive(Default)]
pub struct LastSelection(pub std::sync::Mutex<Option<u32>>);

/// Pick a sensible window for the hotkey path:
///   1. If a prior selection exists AND that window is still listed -> use it
///   2. Else: first window whose `app` is NOT `Quanta` (or the literal product
///      name) -> closest available approximation of "the frontmost user
///      window". The Swift sidecar is expected to return the list already
///      sorted by z-order (frontmost first) — see worker E contract.
///   3. Else: first listed window
///   4. Else: error
pub fn pick_window(windows: &[WindowInfo], prior: Option<u32>) -> AppResult<u32> {
    if let Some(id) = prior {
        if windows.iter().any(|w| w.id == id) {
            return Ok(id);
        }
    }
    if let Some(w) = windows.iter().find(|w| !w.app.eq_ignore_ascii_case("Quanta")) {
        return Ok(w.id);
    }
    if let Some(w) = windows.first() {
        return Ok(w.id);
    }
    Err(AppError::InvalidArgument {
        arg: "window_list",
        reason: "screen-ocr returned an empty window list".to_string(),
    })
}

/// Initialise the `LastSelection` resource into the app state. Safe to call
/// from `tauri::Builder::setup`.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    app.manage(LastSelection::default());
}
