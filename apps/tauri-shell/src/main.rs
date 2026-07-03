//! quanta desktop shell entrypoint (ADR-0317).
//!
//! Boot order:
//!   1. Install plugins (log, shell, process, global-shortcut).
//!   2. Install in-app state (DaemonHandle, LastSelection, HotkeyEnabled).
//!   3. Auto-start the bun web-daemon sidecar (spawn-and-supervise).
//!   4. Inject `window.__QUANTA_CONFIG__` into the main webview at boot.
//!   5. Auto-enable the active-monitor capture hotkey
//!      (`Cmd+Ctrl+Shift+[`) and Send-trigger hotkey
//!      (`Cmd+Ctrl+Shift+]`) at boot.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
#![deny(unsafe_code)]

use quanta_tauri_shell_lib::{commands, daemon, deeplink, hotkey, notify, ocr};
use tauri::{Manager, RunEvent};

fn main() {
    let log_plugin = tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build();

    let result = tauri::Builder::default()
        .plugin(log_plugin)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // B2 (jul-04) — custom-scheme deep link (`quanta://threads/{id}`).
        // Scheme association lives in tauri.conf.json > plugins.deep-link.
        // REBUILD-GATED: only a signed, installed .app registers the scheme.
        .plugin(tauri_plugin_deep_link::init())
        // B5 (jul-04) — native OS notification (presence decided on the
        // frontend; the shell is a dumb sink). REBUILD-GATED.
        .plugin(tauri_plugin_notification::init())
        .on_page_load(|webview, _payload| {
            if webview.label() != "main" {
                return;
            }
            let handle = webview.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                match daemon::current_info(&handle).await {
                    Ok(info) => daemon::publish_config(&handle, &info),
                    Err(err) => {
                        log::warn!(
                            target: "quanta::boot",
                            "page-load config inject skipped: {err}"
                        );
                    }
                }
            });
        })
        .setup(|app| {
            let handle = app.handle().clone();
            ocr::install(&handle);
            hotkey::install(&handle);
            daemon::install(&handle);
            // B2 (jul-04) — register the deep-link `on_open_url` handler and
            // drain any cold-start `quanta://threads/{id}` that launched the
            // app. Non-fatal / rebuild-gated (see deeplink.rs).
            deeplink::install(&handle);

            // Auto-enable the active-monitor capture (`Cmd+Ctrl+Shift+[`)
            // and Send-trigger (`Cmd+Ctrl+Shift+]`) hotkeys. Default-ON
            // per user request — the hotkeys ARE the feature surface.
            // Failure is non-fatal: the rest of the app boots regardless.
            let h_hotkey = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = hotkey::enable(&h_hotkey).await {
                    log::warn!(
                        target: "quanta::boot",
                        "hotkey auto-enable failed: {err}"
                    );
                }
            });

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
                        // Best-effort fallback only. The frontend's primary
                        // bootstrap path now pulls config via `daemon_info`;
                        // this injection just keeps older browser-only code
                        // paths working when the webview is already ready.
                        daemon::publish_config(&handle, &info);
                    }
                    Err(err) => {
                        log::warn!(target: "quanta::boot", "daemon auto-start failed: {err}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_windows,
            commands::capture_window,
            commands::start_daemon,
            commands::stop_daemon,
            commands::restart_daemon,
            commands::daemon_status,
            commands::daemon_info,
            commands::enable_hotkey,
            commands::disable_hotkey,
            commands::hotkey_status,
            commands::open_external_url,
            notify::notify_turn_complete,
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

