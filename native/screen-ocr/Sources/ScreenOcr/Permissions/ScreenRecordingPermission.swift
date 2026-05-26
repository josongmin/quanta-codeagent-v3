// TCC Screen Recording permission inspection.
//
// IMPORTANT: this file deliberately does NOT trigger the system prompt.
// Reading SCShareableContent.current is what triggers it, and that happens
// inside CaptureCommand / WindowEnumerator when the user actually calls those.
// The host (Tauri shell) decides when to provoke the prompt — we just report
// state for the `check-permission` subcommand.
//
import AppKit
import Foundation

@available(macOS 13.0, *)
enum ScreenRecordingPermission {
    /// Probe whether Screen Recording has been granted to *this* process.
    ///
    /// `CGPreflightScreenCaptureAccess()` returns true once the user has
    /// authorised this binary. It does NOT show a prompt. The companion
    /// `CGRequestScreenCaptureAccess()` *does* show a prompt — and we
    /// deliberately do not call it here.
    ///
    /// `needsPrompt` is true when access is not granted AND no prior decision
    /// has been recorded for this binary (heuristic: `CGPreflightScreenCaptureAccess`
    /// returns false in both "never asked" and "explicitly denied" states, so
    /// we conservatively report `needsPrompt = !granted`). The host can use this
    /// to decide whether to call `CGRequestScreenCaptureAccess()` itself or to
    /// surface a "go to System Settings" hint.
    static func probe() -> PermissionResponse {
        let granted = CGPreflightScreenCaptureAccess()
        return PermissionResponse(granted: granted, needsPrompt: !granted)
    }
}
