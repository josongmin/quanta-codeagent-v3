/**
 * UUX-3-16 web half (jul-10 W4) — the Tauri capture hotkey IS observable from
 * the frontend (`quanta:hotkey-image-capture` postMessage, hotkey.rs), but the
 * web surface showed nothing: no success feedback, and the silent
 * window-pick → main-display fallback (hotkey.rs `"Main display (window-pick
 * fallback)"`) was indistinguishable from a real window capture.
 *
 * Now `HotkeyToast` also listens for the image-capture payload and toasts:
 *   - success  → names WHAT was captured (window label / monitor name)
 *   - fallback → says the window pick failed and the MAIN DISPLAY was captured
 *
 * Node env, no DOM events: the message-derivation is a pure exported helper
 * (`imageCaptureToastText`); the render path is pinned via the SSR
 * `initialMessage` seam (same pattern as ThreadPicker's `initialSnapshot`).
 */

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { HotkeyToast, imageCaptureToastText } from "./HotkeyToast"

const payload = (monitorName: string) => ({
  kind: "quanta:hotkey-image-capture" as const,
  pngBase64: "aGk=",
  monitorName,
  capturedAtMs: 1,
  byteSize: 2,
})

describe("imageCaptureToastText (UUX-3-16)", () => {
  it("names the captured window/monitor on success", () => {
    expect(imageCaptureToastText(payload("Safari — Docs"))).toBe(
      "Captured Safari — Docs · attaching to next turn",
    )
  })

  it("surfaces the window-pick → main-display fallback honestly (hotkey.rs marker)", () => {
    // Pins the EXACT label Rust sends for the fallback arm (hotkey.rs:342) —
    // if that wording drifts, this test must be updated in lock-step.
    expect(imageCaptureToastText(payload("Main display (window-pick fallback)"))).toBe(
      "Window pick failed — captured the main display instead · attaching to next turn",
    )
  })

  it("empty monitor name degrades to a generic-but-honest label", () => {
    expect(imageCaptureToastText(payload(""))).toBe("Captured screen · attaching to next turn")
  })
})

describe("HotkeyToast render path", () => {
  it("renders the toast body via the SSR seam (role=status, message text)", () => {
    const markup = renderToStaticMarkup(
      <HotkeyToast initialMessage="Captured Safari — Docs · attaching to next turn" />,
    )
    expect(markup).toContain('role="status"')
    expect(markup).toContain("Captured Safari — Docs")
  })

  it("renders nothing without a message (default hidden)", () => {
    expect(renderToStaticMarkup(<HotkeyToast />)).toBe("")
  })
})
