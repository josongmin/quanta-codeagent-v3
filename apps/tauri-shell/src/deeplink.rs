//! B2 (jul-04) — OS custom-scheme deep link (`quanta://threads/{id}`).
//!
//! ⚠️ REBUILD-GATED / WRITE-ONLY: the OS-integration paths in this module
//! (scheme registration + the live `on_open_url` event) can only be exercised
//! by a SIGNED, installed `.app` — the scheme association is written into the
//! bundle's `Info.plist` at `tauri build` time. This source is reviewed and the
//! PURE forwarding helpers are unit-tested (`#[cfg(test)]` below), but "click a
//! `quanta://threads/x` link and see the webview banner" needs `cargo tauri
//! build` + codesign to verify. It is NOT runtime-verified here.
//!
//! Flow (mirrors `hotkey.rs`): the `tauri-plugin-deep-link` plugin fires
//! `on_open_url` with a list of URLs when the OS routes a `quanta://` link to
//! the running app. We pick the FIRST `quanta://threads/…` URL and forward it
//! into the main webview via BOTH a Tauri event (`quanta:deep-link`) AND a
//! `window.postMessage({ kind:"quanta:deep-link", url })` (the pattern the
//! frontend `ThreadDeeplinkBanner` already listens for). The frontend's pure
//! `resolveThreadRouteFromUri` then turns the address into a route intent — so
//! the SAME resolver contract governs the web-fallback URL and the native URI.
//!
//! Cold-start: a link that LAUNCHES the app is retrieved once at `setup` via
//! `get_current()` and forwarded the same way after the webview is ready.

#![allow(clippy::needless_return)]

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::error::{AppError, AppResult};

/// The event name the frontend listens for (Tauri event + postMessage `kind`).
pub const DEEP_LINK_EVENT: &str = "quanta:deep-link";

/// The native scheme + authority a thread deeplink uses. Mirrors the TS
/// `THREAD_DEEPLINK_PREFIX` (`@/scheduler/deeplink`). Kept as a const so the
/// Rust filter and the TS resolver cannot drift on the prefix.
pub const THREAD_DEEPLINK_PREFIX: &str = "quanta://threads/";

/// The `quanta:deep-link` payload forwarded to the webview.
#[derive(serde::Serialize, Clone)]
struct DeepLinkPayload {
    kind: &'static str,
    url: String,
}

/// Pure: pick the first URL that is a well-formed `quanta://threads/{non-empty}`
/// deeplink from a plugin-delivered list, or `None`. The plugin delivers a LIST
/// (macOS may batch), and a stray non-thread `quanta://…` URL (some other future
/// scheme use) must be ignored. Unit-tested below — this is the leaf logic the
/// punchcard covers without a build.
pub fn first_thread_uri<S: AsRef<str>>(urls: &[S]) -> Option<String> {
    for u in urls {
        let s = u.as_ref();
        if let Some(rest) = s.strip_prefix(THREAD_DEEPLINK_PREFIX) {
            // Non-empty id required (`quanta://threads/` with no id is not a
            // route — mirrors parseThreadDeeplink's empty-id rejection).
            if !rest.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Forward a single deep-link URL into the main webview: emit the Tauri event
/// AND `window.postMessage` (so the frontend banner receives it regardless of
/// which channel it subscribes to). Best-effort — a missing window / eval
/// failure is logged, never fatal (mirrors `hotkey.rs`).
fn forward_url<R: Runtime>(app: &AppHandle<R>, url: &str) -> AppResult<()> {
    let payload = DeepLinkPayload {
        kind: DEEP_LINK_EVENT,
        url: url.to_string(),
    };
    if let Err(err) = app.emit(DEEP_LINK_EVENT, &payload) {
        log::warn!(target: "quanta::deeplink", "event emit failed: {err}");
    }
    if let Some(window) = app.get_webview_window("main") {
        let payload_json = serde_json::to_string(&payload)
            .map_err(|e| AppError::Internal(format!("deeplink payload serialize failed: {e}")))?;
        let script = format!(
            "(function(){{ try {{ window.postMessage({payload_json}, '*'); }} \
             catch (e) {{ console.error('quanta deep-link postMessage failed', e); }} }})();"
        );
        if let Err(err) = window.eval(&script) {
            log::warn!(target: "quanta::deeplink", "postMessage eval failed: {err}");
        }
    }
    log::info!(target: "quanta::deeplink", "forwarded deep link to webview");
    Ok(())
}

/// Install the live `on_open_url` handler AND drain any cold-start URL. Called
/// from `main.rs` `setup`. Failure is non-fatal — deep-linking is additive; the
/// rest of the shell boots regardless (the `Err` is logged by the caller).
///
/// REBUILD-GATED: the handler only fires for a scheme-registered `.app`.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    // Live handler: fires while the app is already running.
    let live = app.clone();
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().into_iter().map(|u| u.to_string()).collect();
        if let Some(uri) = first_thread_uri(&urls) {
            if let Err(err) = forward_url(&live, &uri) {
                log::warn!(target: "quanta::deeplink", "forward (live) failed: {err}");
            }
        } else {
            log::debug!(
                target: "quanta::deeplink",
                "on_open_url with no quanta://threads/ URL ({} url(s)) — ignored",
                urls.len()
            );
        }
    });

    // Cold-start: a link that LAUNCHED the app is not delivered via the live
    // handler. Retrieve it once and forward after the webview is up.
    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            let list: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
            if let Some(uri) = first_thread_uri(&list) {
                if let Err(err) = forward_url(app, &uri) {
                    log::warn!(target: "quanta::deeplink", "forward (cold-start) failed: {err}");
                }
            }
        }
        Ok(None) => {}
        Err(err) => {
            log::warn!(target: "quanta::deeplink", "get_current failed: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_first_thread_uri() {
        let urls = ["quanta://threads/abc", "quanta://threads/def"];
        assert_eq!(first_thread_uri(&urls).as_deref(), Some("quanta://threads/abc"));
    }

    #[test]
    fn skips_non_thread_and_empty_id() {
        // Foreign scheme, foreign authority, and an empty id are all skipped;
        // the first VALID thread uri wins.
        let urls = [
            "https://threads/x",
            "quanta://inbox/y",
            "quanta://threads/", // empty id — rejected
            "quanta://threads/real",
        ];
        assert_eq!(first_thread_uri(&urls).as_deref(), Some("quanta://threads/real"));
    }

    #[test]
    fn none_when_no_thread_uri() {
        let urls = ["quanta://threads/", "quanta://other/z", "not-a-uri"];
        assert_eq!(first_thread_uri(&urls), None);
        let empty: [&str; 0] = [];
        assert_eq!(first_thread_uri(&empty), None);
    }

    #[test]
    fn preserves_encoded_id_verbatim() {
        // The forwarder must NOT decode — the frontend resolver owns decoding.
        // `buildThreadDeeplink("a/b c")` == "quanta://threads/a%2Fb%20c".
        let urls = ["quanta://threads/a%2Fb%20c"];
        assert_eq!(
            first_thread_uri(&urls).as_deref(),
            Some("quanta://threads/a%2Fb%20c")
        );
    }
}
