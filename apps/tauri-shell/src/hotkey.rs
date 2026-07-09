//! Global hotkeys: active-monitor screenshot + remote Send trigger +
//! webview zoom.
//!
//! Accelerators are registered together at boot. All fire on Press only
//! (Release would double-trigger). ALL of them are gated on the Quanta
//! window being focused (`main_window_focused`, UUX-6-08 / UUX-3-15):
//! a global accelerator fires system-wide, but capture/send/zoom are
//! per-window features — pre-guard, `Cmd+Ctrl+Shift+]` while typing in
//! another app silently submitted the draft, and `[` silently captured
//! the screen with zero visible feedback.
//!
//!  `Cmd+Ctrl+Shift+[` (`CmdOrCtrl+Shift+Ctrl+BracketLeft`)
//!     Capture the monitor that currently contains the mouse cursor as a
//!     full PNG (NOT OCR), ship it to the React frontend as
//!     `quanta:hotkey-image-capture`. The frontend stashes it on
//!     `pendingImage` exactly like a clipboard paste — the user can add
//!     text and press Send (or use the Send hotkey below) to attach the
//!     image to the next turn.
//!
//!  `Cmd+Ctrl+Shift+]` (`CmdOrCtrl+Shift+Ctrl+BracketRight`)
//!     Fires `quanta:hotkey-send` — the frontend treats it as an Enter
//!     press on the composer (submits the current draft + any pending
//!     image attachment). Lets the user complete the whole flow without
//!     touching the trackpad.
//!
//!  `Cmd+Shift+=` / `Cmd+Shift+-` / `Cmd+0`
//!     Webview zoom in / out / reset. Adjusts `set_zoom` on the main
//!     webview only when the Quanta window is focused — otherwise the
//!     press is ignored so we don't fight whichever app is in front.
//!
//! Pipeline for the capture hotkey:
//!   1. `app.cursor_position()` → physical position of the cursor.
//!   2. `app.monitor_from_point(x, y)` → the monitor containing it.
//!   3. Convert the monitor's physical rect to CG points
//!      (`physical / scale_factor`).
//!   4. `screencapture -R<x,y,w,h> -o -x /tmp/quanta-hotkey-<ts>.png` —
//!      macOS native CLI captures exactly that rectangle.
//!   5. Read PNG → base64 → emit via both Tauri event channel AND
//!      `window.postMessage`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::error::{AppError, AppResult};
use crate::ocr;

pub const CAPTURE_ACCELERATOR: &str = "CmdOrCtrl+Shift+Ctrl+BracketLeft";
pub const SEND_ACCELERATOR: &str = "CmdOrCtrl+Shift+Ctrl+BracketRight";
pub const ZOOM_IN_ACCELERATOR: &str = "CmdOrCtrl+Shift+Equal";
pub const ZOOM_OUT_ACCELERATOR: &str = "CmdOrCtrl+Shift+Minus";
pub const ZOOM_RESET_ACCELERATOR: &str = "CmdOrCtrl+0";
pub const HOTKEY_IMAGE_EVENT: &str = "quanta:hotkey-image-capture";
pub const HOTKEY_SEND_EVENT: &str = "quanta:hotkey-send";

// Multiplicative step matches the webkit/chromium default "one notch" feel.
const ZOOM_STEP: f64 = 1.1;
const ZOOM_MIN: f64 = 0.3;
const ZOOM_MAX: f64 = 3.0;
const ZOOM_DEFAULT: f64 = 1.0;

/// Tracks whether the hotkeys are currently registered. Auto-enabled at
/// boot; flipped via `enable_hotkey` / `disable_hotkey` commands.
#[derive(Clone, Default)]
pub struct HotkeyEnabled(pub Arc<AtomicBool>);

/// Current zoom factor for the main webview. Tauri's `WebviewWindow` has
/// no `get_zoom`, so we shadow the value ourselves and seed it to 1.0.
#[derive(Clone)]
pub struct ZoomLevel(pub Arc<Mutex<f64>>);

impl Default for ZoomLevel {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(ZOOM_DEFAULT)))
    }
}

/// Payload broadcast to webviews when the capture hotkey fires.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyImageCapturePayload {
    pub kind: &'static str,
    pub png_base64: String,
    pub monitor_name: String,
    pub captured_at_ms: u128,
    pub byte_size: usize,
}

/// Payload broadcast for the Send hotkey. No data — just the discriminator.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeySendPayload {
    pub kind: &'static str,
    pub triggered_at_ms: u128,
}

pub fn install<R: Runtime>(app: &AppHandle<R>) {
    app.manage(HotkeyEnabled::default());
    app.manage(ZoomLevel::default());
}

/// UUX-6-08 / UUX-3-15 — the ONE focus guard for the globally-registered
/// hotkeys. A global accelerator fires regardless of which app is in front,
/// but capture/send/zoom are Quanta-window features: firing them while
/// another app is focused silently screenshots / submits the draft with zero
/// visible feedback. Returns `true` when the press should be handled.
///
/// Policy (extracted verbatim from the zoom guard, now shared by all three):
///   - no main window ⇒ deny (nothing to act on / act into),
///   - `is_focused` == false ⇒ deny (don't fight the frontmost app),
///   - `is_focused` errored ⇒ ALLOW + debug-log (fail-open, matching the
///     zoom guard's pre-existing behaviour — a broken focus query must not
///     brick the hotkeys).
fn main_window_focused<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    match window.is_focused() {
        Ok(focused) => focused,
        Err(err) => {
            log::debug!(target: "quanta::hotkey", "is_focused query failed, handling anyway: {err}");
            true
        }
    }
}

/// Register both accelerators. Idempotent.
pub async fn enable<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let flag = app.state::<HotkeyEnabled>().inner().clone();
    if flag.0.load(Ordering::SeqCst) {
        return Ok(());
    }

    let app_for_capture = app.clone();
    app.global_shortcut()
        .on_shortcut(CAPTURE_ACCELERATOR, move |_app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            // UUX-6-08 — same focus guard as zoom: ignore the global press
            // while Quanta is not the focused app (no invisible screenshots).
            if !main_window_focused(&app_for_capture) {
                return;
            }
            let app_handler = app_for_capture.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = on_capture_hotkey_pressed(&app_handler).await {
                    log::warn!(target: "quanta::hotkey", "capture pipeline failed: {err}");
                }
            });
        })
        .map_err(|e| AppError::Hotkey {
            accelerator: CAPTURE_ACCELERATOR.to_string(),
            reason: e.to_string(),
        })?;

    let app_for_send = app.clone();
    app.global_shortcut()
        .on_shortcut(SEND_ACCELERATOR, move |_app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            // UUX-3-15 — same focus guard: never submit the draft while the
            // user is looking at (and typing in) another app.
            if !main_window_focused(&app_for_send) {
                return;
            }
            if let Err(err) = emit_send_event(&app_for_send) {
                log::warn!(target: "quanta::hotkey", "send emit failed: {err}");
            }
        })
        .map_err(|e| AppError::Hotkey {
            accelerator: SEND_ACCELERATOR.to_string(),
            reason: e.to_string(),
        })?;

    register_zoom(app, ZOOM_IN_ACCELERATOR, ZoomAction::In)?;
    register_zoom(app, ZOOM_OUT_ACCELERATOR, ZoomAction::Out)?;
    register_zoom(app, ZOOM_RESET_ACCELERATOR, ZoomAction::Reset)?;

    flag.0.store(true, Ordering::SeqCst);
    log::info!(
        target: "quanta::hotkey",
        "registered global shortcuts `{}` (capture), `{}` (send), `{}`/`{}`/`{}` (zoom in/out/reset)",
        CAPTURE_ACCELERATOR, SEND_ACCELERATOR,
        ZOOM_IN_ACCELERATOR, ZOOM_OUT_ACCELERATOR, ZOOM_RESET_ACCELERATOR
    );
    Ok(())
}

#[derive(Clone, Copy)]
enum ZoomAction {
    In,
    Out,
    Reset,
}

fn register_zoom<R: Runtime>(
    app: &AppHandle<R>,
    accelerator: &'static str,
    action: ZoomAction,
) -> AppResult<()> {
    let app_for_zoom = app.clone();
    app.global_shortcut()
        .on_shortcut(accelerator, move |_app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if let Err(err) = apply_zoom(&app_for_zoom, action) {
                log::warn!(target: "quanta::hotkey", "zoom apply failed: {err}");
            }
        })
        .map_err(|e| AppError::Hotkey {
            accelerator: accelerator.to_string(),
            reason: e.to_string(),
        })
}

fn apply_zoom<R: Runtime>(app: &AppHandle<R>, action: ZoomAction) -> AppResult<()> {
    // Only act on a focused Quanta window — these accelerators are
    // registered globally, but they're a per-window zoom feature. Shared
    // guard (UUX-6-08): the same rule now gates capture + send too.
    if !main_window_focused(app) {
        return Ok(());
    }
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let state = app.state::<ZoomLevel>();
    let mut current = state
        .0
        .lock()
        .map_err(|e| AppError::Internal(format!("zoom mutex poisoned: {e}")))?;
    let next = match action {
        ZoomAction::In => (*current * ZOOM_STEP).min(ZOOM_MAX),
        ZoomAction::Out => (*current / ZOOM_STEP).max(ZOOM_MIN),
        ZoomAction::Reset => ZOOM_DEFAULT,
    };
    if (next - *current).abs() < f64::EPSILON {
        return Ok(());
    }
    window
        .set_zoom(next)
        .map_err(|e| AppError::Internal(format!("set_zoom failed: {e}")))?;
    *current = next;
    log::info!(target: "quanta::hotkey", "webview zoom -> {:.2}", next);
    Ok(())
}

/// Unregister both accelerators. Idempotent.
pub async fn disable<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let flag = app.state::<HotkeyEnabled>().inner().clone();
    if !flag.0.load(Ordering::SeqCst) {
        return Ok(());
    }
    let shortcut = app.global_shortcut();
    if let Err(err) = shortcut.unregister(CAPTURE_ACCELERATOR) {
        log::warn!(
            target: "quanta::hotkey",
            "unregister `{}` failed: {}",
            CAPTURE_ACCELERATOR, err
        );
    }
    if let Err(err) = shortcut.unregister(SEND_ACCELERATOR) {
        log::warn!(
            target: "quanta::hotkey",
            "unregister `{}` failed: {}",
            SEND_ACCELERATOR, err
        );
    }
    for accel in [
        ZOOM_IN_ACCELERATOR,
        ZOOM_OUT_ACCELERATOR,
        ZOOM_RESET_ACCELERATOR,
    ] {
        if let Err(err) = shortcut.unregister(accel) {
            log::warn!(
                target: "quanta::hotkey",
                "unregister `{}` failed: {}",
                accel, err
            );
        }
    }
    flag.0.store(false, Ordering::SeqCst);
    log::info!(target: "quanta::hotkey", "unregistered global shortcuts");
    Ok(())
}

pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<HotkeyEnabled>().inner().0.load(Ordering::SeqCst)
}

async fn on_capture_hotkey_pressed<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    // 1. Try to pick the frontmost non-Quanta window via the screen-ocr
    //    sidecar. When the sidecar lacks Screen Recording permission (e.g.
    //    Quanta.app hasn't been added to System Settings → Privacy yet),
    //    `list_windows` returns 0 entries — fall back to capturing the main
    //    display so we still produce SOMETHING and the user can verify the
    //    end-to-end pipeline.
    let windows = ocr::list_windows(app).await.unwrap_or_default();
    let target_window = windows
        .iter()
        .find(|w| w.app != "Quanta" && w.app != "quanta-tauri-shell")
        .cloned();

    let captured_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("quanta-hotkey-{}.png", captured_at_ms));
    let path_str = path.to_string_lossy().to_string();

    // 2. screencapture: by-window if we have one, else full main display.
    //    `-o` strips macOS window shadow; `-x` suppresses shutter sound.
    let mut cmd = std::process::Command::new("/usr/sbin/screencapture");
    let label = match target_window.as_ref() {
        Some(w) => {
            cmd.args([
                "-l".to_string(),
                w.id.to_string(),
                "-o".to_string(),
                "-x".to_string(),
                path_str.clone(),
            ]);
            if w.title.is_empty() {
                w.app.clone()
            } else {
                format!("{} — {}", w.app, w.title)
            }
        }
        None => {
            // Main display fallback. `-m` = main display only; the global
            // shortcut handler ran in the user's session so this captures
            // exactly the monitor they were looking at.
            cmd.args(["-m".to_string(), "-x".to_string(), path_str.clone()]);
            "Main display (window-pick fallback)".to_string()
        }
    };
    let status = cmd
        .status()
        .map_err(|e| AppError::Internal(format!("screencapture spawn failed: {e}")))?;
    if !status.success() {
        return Err(AppError::Internal(format!(
            "screencapture exited non-zero: {status}"
        )));
    }

    // 3. Read PNG → base64. Clean up tmpfile either way.
    let bytes = std::fs::read(&path)
        .map_err(|e| AppError::Internal(format!("png read failed: {e}")))?;
    let _ = std::fs::remove_file(&path);
    let byte_size = bytes.len();
    let png_base64 = BASE64_STANDARD.encode(&bytes);

    // Repurpose `monitor_name` to carry the window label "app — title"
    // (or "Main display") so the existing frontend payload shape is
    // preserved.
    let monitor_name = label;
    let payload = HotkeyImageCapturePayload {
        kind: HOTKEY_IMAGE_EVENT,
        png_base64,
        monitor_name: monitor_name.clone(),
        captured_at_ms,
        byte_size,
    };

    if let Err(err) = app.emit(HOTKEY_IMAGE_EVENT, &payload) {
        log::warn!(target: "quanta::hotkey", "event emit failed: {err}");
    }
    if let Some(window) = app.get_webview_window("main") {
        match serde_json::to_string(&payload) {
            Ok(payload_json) => {
                let script = format!(
                    "(function(){{ try {{ window.postMessage({payload_json}, '*'); }} \
                     catch (e) {{ console.error('quanta hotkey image postMessage failed', e); }} }})();"
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
        "captured window `{}` ({} bytes)",
        monitor_name, byte_size
    );
    Ok(())
}

fn emit_send_event<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let triggered_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let payload = HotkeySendPayload {
        kind: HOTKEY_SEND_EVENT,
        triggered_at_ms,
    };
    if let Err(err) = app.emit(HOTKEY_SEND_EVENT, &payload) {
        log::warn!(target: "quanta::hotkey", "send event emit failed: {err}");
    }
    if let Some(window) = app.get_webview_window("main") {
        let payload_json = serde_json::to_string(&payload)
            .map_err(|e| AppError::Internal(format!("send payload serialize failed: {e}")))?;
        let script = format!(
            "(function(){{ try {{ window.postMessage({payload_json}, '*'); }} \
             catch (e) {{ console.error('quanta hotkey send postMessage failed', e); }} }})();"
        );
        if let Err(err) = window.eval(&script) {
            log::warn!(target: "quanta::hotkey", "send postMessage eval failed: {err}");
        }
    }
    log::info!(target: "quanta::hotkey", "send hotkey triggered");
    Ok(())
}
