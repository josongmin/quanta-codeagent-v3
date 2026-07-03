//! B5 (jul-04) — native OS notification on turn-complete.
//!
//! ⚠️ REBUILD-GATED / WRITE-ONLY: firing an actual macOS notification needs a
//! SIGNED, installed `.app` (the OS ties notification authorization to the
//! bundle identity, and unsigned/dev builds are silently dropped). The command
//! wiring + the `NotificationExt` builder call are reviewed here, and the PURE
//! title/body composition is unit-tested (`#[cfg(test)]`), but "see a banner in
//! Notification Center" needs `cargo tauri build` + codesign to verify.
//!
//! PRESENCE is decided on the FRONTEND (the `presence-probe` visibility+idle
//! rule that mirrors the CLI `computePresence`). The shell does NOT re-derive
//! presence: the webview only invokes `notify_turn_complete` when the frontend
//! has already decided the user is AWAY (`computeWebPresence(...) === false`).
//! This keeps ONE presence rule (the frontend's) and the shell as a dumb OS
//! adapter — symmetric with the CLI, where the OSC adapter is the dumb sink and
//! `shouldPush` owns the decision.

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::error::{AppError, AppResult};

/// Compose the (title, body) a completion notification shows. Pure — unit-
/// tested without the OS. `ok` picks the ✓/✗ glyph; `project` is the short cwd
/// label (may be empty ⇒ a generic title). Mirrors the CLI OSC title
/// (`✓ {proj} — done` / `✗ {proj} — failed`) so the two surfaces read alike.
pub fn resolve_notification_text(ok: bool, project: &str) -> (String, String) {
    let glyph = if ok { "✓" } else { "✗" };
    let outcome = if ok { "done" } else { "failed" };
    let proj = project.trim();
    let title = if proj.is_empty() {
        format!("{glyph} quanta — {outcome}")
    } else {
        format!("{glyph} {proj} — {outcome}")
    };
    let body = "The agent finished its turn.".to_string();
    (title, body)
}

/// Fire a native OS notification for a completed turn. Best-effort: a build /
/// permission failure surfaces as an `AppError` the frontend can log, but the
/// caller treats it as non-fatal (the in-app UI is the primary signal).
///
/// REBUILD-GATED: no banner appears from an unsigned dev build.
#[tauri::command]
pub fn notify_turn_complete<R: Runtime>(
    app: AppHandle<R>,
    ok: bool,
    project: String,
) -> AppResult<()> {
    let (title, body) = resolve_notification_text(ok, &project);
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| AppError::Internal(format!("notification show failed: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_title_with_project() {
        let (title, body) = resolve_notification_text(true, "my-proj");
        assert_eq!(title, "✓ my-proj — done");
        assert_eq!(body, "The agent finished its turn.");
    }

    #[test]
    fn failure_title_with_project() {
        let (title, _) = resolve_notification_text(false, "my-proj");
        assert_eq!(title, "✗ my-proj — failed");
    }

    #[test]
    fn empty_project_falls_back_to_generic() {
        let (title, _) = resolve_notification_text(true, "   ");
        assert_eq!(title, "✓ quanta — done");
        let (title2, _) = resolve_notification_text(false, "");
        assert_eq!(title2, "✗ quanta — failed");
    }
}
