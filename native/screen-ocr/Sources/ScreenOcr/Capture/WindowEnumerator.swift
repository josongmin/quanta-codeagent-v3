// On-screen window enumeration via CGWindowList.
//
// We use the legacy CGWindowList* API rather than SCShareableContent here for
// two reasons:
//   1. CGWindowList does NOT require Screen Recording permission to *list*
//      windows (only titles get redacted when permission is missing — but the
//      window id + bounds + owner are still exposed). That keeps `list-windows`
//      usable as a probe before the user grants permission.
//   2. We get bounds + layer + owner PID in a single call, which matches the
//      shape we want to emit.
//
import AppKit
import CoreGraphics
import Foundation

enum WindowEnumerator {
    /// Enumerate on-screen windows the host can target. Filters:
    ///   - layer != 0 dropped (utility / menubar / dock / wallpapers)
    ///   - empty title dropped (untitled overlays, transient sheets)
    ///   - own process dropped (so a self-targeting capture loop is impossible)
    ///
    /// Ordering: windows owned by `NSWorkspace.frontmostApplication` are
    /// emitted first (preserving their internal z-order), then everything
    /// else. CGWindowList's native z-order does not reliably surface the
    /// user-perceived frontmost app on macOS 14+, so callers that want
    /// "the app the user was looking at" — e.g. the global capture hotkey —
    /// can just take `windows[0]` and trust it.
    static func enumerate() -> ListWindowsResponse {
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        // kCGNullWindowID asks for all on-screen windows in z-order.
        guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
            Output.debug("CGWindowListCopyWindowInfo returned nil")
            return ListWindowsResponse(windows: [])
        }

        let ownPid = ProcessInfo.processInfo.processIdentifier
        let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        var frontWindows: [WindowInfo] = []
        var otherWindows: [WindowInfo] = []
        frontWindows.reserveCapacity(raw.count)
        otherWindows.reserveCapacity(raw.count)

        for entry in raw {
            guard let info = parseEntry(entry, ownPid: ownPid) else { continue }
            let entryPid = (entry[kCGWindowOwnerPID as String] as? Int32) ?? 0
            if frontmostPid != 0 && entryPid == frontmostPid {
                frontWindows.append(info)
            } else {
                otherWindows.append(info)
            }
        }

        return ListWindowsResponse(windows: frontWindows + otherWindows)
    }

    /// Pure parse — split out so we can keep `enumerate()` short.
    private static func parseEntry(_ entry: [String: Any], ownPid: Int32) -> WindowInfo? {
        // Owner PID — skip self.
        if let pid = entry[kCGWindowOwnerPID as String] as? Int32, pid == ownPid {
            return nil
        }

        // Layer — only layer 0 (normal app windows). Menubar=25, Dock=20, etc.
        guard let layerNum = entry[kCGWindowLayer as String] as? NSNumber else { return nil }
        let layer = layerNum.intValue
        if layer != 0 { return nil }

        // Title — drop empty / missing.
        let title = (entry[kCGWindowName as String] as? String) ?? ""
        if title.isEmpty { return nil }

        // Window id.
        guard let idNum = entry[kCGWindowNumber as String] as? NSNumber else { return nil }
        let id = idNum.intValue

        // App / owner name.
        let app = (entry[kCGWindowOwnerName as String] as? String) ?? ""

        // Bounds — comes back as a CGRect serialised to a CFDictionary.
        let bounds = parseBounds(entry[kCGWindowBounds as String])

        return WindowInfo(id: id, app: app, title: title, bounds: bounds, layer: layer)
    }

    /// Best-effort CGRect dict parse. Returns a zero-rect on any failure
    /// (CGWindowListCopyWindowInfo always populates bounds for real windows,
    /// so a zero here means corrupt entry — we don't drop the row over it).
    private static func parseBounds(_ raw: Any?) -> PixelBounds {
        guard
            let dict = raw as? [String: Any],
            let cfDict = dict as CFDictionary?,
            let rect = CGRect(dictionaryRepresentation: cfDict)
        else {
            return PixelBounds(x: 0, y: 0, w: 0, h: 0)
        }
        return PixelBounds(
            x: Int(rect.origin.x),
            y: Int(rect.origin.y),
            w: Int(rect.size.width),
            h: Int(rect.size.height)
        )
    }
}
