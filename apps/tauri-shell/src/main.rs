//! quanta desktop shell entrypoint (ADR-0317).
//!
//! Boot order:
//!   1. Install plugins (log, shell, process, global-shortcut).
//!   2. Install in-app state (DaemonHandle, LastSelection, HotkeyEnabled).
//!   3. Auto-start the bun web-daemon sidecar (spawn-and-supervise).
//!   4. Inject `window.__QUANTA_CONFIG__` into the main webview at boot.
//!   5. Hotkey registration is OPT-IN — frontend calls `enable_hotkey`.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
#![deny(unsafe_code)]

use quanta_tauri_shell_lib::{
    commands::{
        capture_window, daemon_info, daemon_status, disable_hotkey, enable_hotkey, hotkey_status,
        list_windows, start_daemon, stop_daemon,
    },
    daemon, hotkey, ocr,
};
use tauri::{Manager, RunEvent, WebviewWindow};

fn main() {
    let log_plugin = tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build();

    let result = tauri::Builder::default()
        .plugin(log_plugin)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            ocr::install(&handle);
            hotkey::install(&handle);
            daemon::install(&handle);

            // Kick off the daemon supervisor. If it fails, the frontend can
            // still come up — the user retries from the UI via
            // `start_daemon`. We log the failure and continue.
            tauri::async_runtime::spawn(async move {
                match daemon::start(&handle).await {
                    Ok(info) => {
                        log::info!(
                            target: "quanta::boot",
                            "daemon started on port {} (pid {:?})",
                            info.port,
                            info.pid
                        );
                        inject_config_into_main(&handle, &info);
                    }
                    Err(err) => {
                        log::warn!(target: "quanta::boot", "daemon auto-start failed: {err}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_windows,
            capture_window,
            start_daemon,
            stop_daemon,
            daemon_status,
            daemon_info,
            enable_hotkey,
            disable_hotkey,
            hotkey_status,
        ])
        .build(tauri::generate_context!());

    let app = match result {
        Ok(app) => app,
        Err(err) => {
            // Startup-time bail: there is no caller to receive an AppError.
            eprintln!("quanta-tauri-shell: fatal startup error: {err}");
            std::process::exit(1);
        }
    };

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            // SIGTERM the daemon synchronously-ish (we spawn the stop and
            // give the rx-loop a chance to clear). `app.run` blocks here so
            // we use a blocking-on-async pattern via the runtime.
            let handle = app_handle.clone();
            tauri::async_runtime::block_on(async move {
                if let Err(err) = daemon::stop(&handle).await {
                    log::warn!(target: "quanta::shutdown", "daemon stop failed: {err}");
                }
            });
        }
    });
}

/// Inject `window.__QUANTA_CONFIG__ = { wsUrl, httpUrl, authToken }` into the
/// main webview at boot. The React app reads it instead of falling back to
/// `import.meta.env` defaults (which would target the dev daemon, not this
/// per-app instance).
fn inject_config_into_main<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    info: &daemon::DaemonInfo,
) {
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
    // We JSON-stringify the payload server-side so the JS literal is safe
    // (no string concatenation, no user-controlled input).
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
