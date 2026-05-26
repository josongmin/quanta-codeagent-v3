//! Global hotkey registration + capture pipeline.
//!
//! Default accelerator: `Cmd+Shift+Q` (configurable via future ADR knob).
//!
//! Default-OFF posture (ADR-0317): the hotkey is registered only after the
//! frontend explicitly invokes `enable_hotkey`. A freshly installed app
//! does NOT capture global key presses until the user opts in.
//!
//! On trigger:
//!   1. `ocr::list_windows` -> pick last-selected (or frontmost non-Quanta).
//!   2. `ocr::capture_window(id)` -> drive the Swift sidecar.
//!   3. Emit `quanta:hotkey-capture` event with the OCR payload to every
//!      webview. The bundled React app re-broadcasts via
//!      `window.postMessage({type:"quanta:hotkey-capture", payload:...})`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::error::{AppError, AppResult};
use crate::ocr::{self, LastSelection};

pub const DEFAULT_ACCELERATOR: &str = "CmdOrCtrl+Shift+Q";
pub const HOTKEY_EVENT: &str = "quanta:hotkey-capture";

/// Tracks whether the user has opted in to the hotkey. Default false; flip
/// via `enable_hotkey` / `disable_hotkey` commands.
#[derive(Clone, Default)]
pub struct HotkeyEnabled(pub Arc<AtomicBool>);

/// Payload broadcast to webviews when the hotkey fires.
///
/// `kind` is a literal so the on-wire shape matches what the React app's
/// `window.addEventListener("message")` discriminator checks for. The other
/// fields are extras — the frontend ignores unknown fields but they help
/// with debugging / future UI (e.g. showing which window was captured).
#[derive(Debug, Clone, Serialize)]
pub struct HotkeyCapturePayload {
    pub kind: &'static str,
    pub text: String,
    pub window_id: u32,
    pub line_count: usize,
}

/// Install the in-app state slot but DO NOT register the global shortcut.
/// Registration happens lazily via `enable`.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    app.manage(HotkeyEnabled::default());
}

/// Register the configured accelerator. Idempotent: if already enabled,
/// returns `Ok(())` without re-registering (avoids OS-level duplicates).
pub async fn enable<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let flag = app.state::<HotkeyEnabled>().inner().clone();
    if flag.0.load(Ordering::SeqCst) {
        return Ok(());
    }

    let app_for_handler = app.clone();
    app.global_shortcut()
        .on_shortcut(DEFAULT_ACCELERATOR, move |_app, _shortcut, event| {
            // Fire on Pressed only (Release would double-trigger).
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let app_handler = app_for_handler.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = on_hotkey_pressed(&app_handler).await {
                    log::warn!(target: "quanta::hotkey", "capture pipeline failed: {err}");
                }
            });
        })
        .map_err(|e| AppError::Hotkey {
            accelerator: DEFAULT_ACCELERATOR.to_string(),
            reason: e.to_string(),
        })?;

    flag.0.store(true, Ordering::SeqCst);
    log::info!(
        target: "quanta::hotkey",
        "registered global shortcut `{}`",
        DEFAULT_ACCELERATOR
    );
    Ok(())
}

/// Unregister the configured accelerator. Idempotent.
pub async fn disable<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let flag = app.state::<HotkeyEnabled>().inner().clone();
    if !flag.0.load(Ordering::SeqCst) {
        return Ok(());
    }
    app.global_shortcut()
        .unregister(DEFAULT_ACCELERATOR)
        .map_err(|e| AppError::Hotkey {
            accelerator: DEFAULT_ACCELERATOR.to_string(),
            reason: e.to_string(),
        })?;
    flag.0.store(false, Ordering::SeqCst);
    log::info!(
        target: "quanta::hotkey",
        "unregistered global shortcut `{}`",
        DEFAULT_ACCELERATOR
    );
    Ok(())
}

pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<HotkeyEnabled>().inner().0.load(Ordering::SeqCst)
}

async fn on_hotkey_pressed<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let windows = ocr::list_windows(app).await?;
    let prior = {
        let selection = app.state::<LastSelection>();
        let guard = selection
            .0
            .lock()
            .map_err(|e| AppError::Internal(format!("LastSelection mutex poisoned: {e}")))?;
        *guard
    };
    let window_id = ocr::pick_window(&windows, prior)?;
    let capture = ocr::capture_window(app, window_id).await?;
    {
        let selection = app.state::<LastSelection>();
        let mut guard = selection
            .0
            .lock()
            .map_err(|e| AppError::Internal(format!("LastSelection mutex poisoned: {e}")))?;
        *guard = Some(window_id);
    }
    let payload = HotkeyCapturePayload {
        kind: HOTKEY_EVENT,
        window_id,
        text: capture.text.clone(),
        line_count: capture.lines.len(),
    };
    // Channel 1: Tauri event system — for JS clients using @tauri-apps/api/event.
    app.emit(HOTKEY_EVENT, &payload)
        .map_err(|e| AppError::Internal(format!("event emit failed: {e}")))?;
    // Channel 2: window.postMessage — the bundled React app listens via
    // `window.addEventListener("message")` (browser-native, no Tauri JS dep).
    // We JSON-stringify server-side so the script literal is injection-safe.
    if let Some(window) = app.get_webview_window("main") {
        match serde_json::to_string(&payload) {
            Ok(payload_json) => {
                let script = format!(
                    "(function(){{ try {{ window.postMessage({payload_json}, '*'); }} \
                     catch (e) {{ console.error('quanta hotkey postMessage failed', e); }} }})();"
                );
                if let Err(err) = window.eval(&script) {
                    log::warn!(
                        target: "quanta::hotkey",
                        "postMessage eval failed: {err}"
                    );
                }
            }
            Err(err) => {
                log::warn!(
                    target: "quanta::hotkey",
                    "payload serialize for postMessage failed: {err}"
                );
            }
        }
    }
    log::info!(
        target: "quanta::hotkey",
        "captured window {} ({} lines)",
        window_id,
        capture.lines.len()
    );
    Ok(())
}
