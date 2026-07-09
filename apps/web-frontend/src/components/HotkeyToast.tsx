import { useEffect, useState } from "react"
import { isHotkeyImagePayload } from "../composer/image-attachment"
import { cx } from "../lib/classnames"

/**
 * Transient feedback toast for the Tauri shell's global hotkeys.
 *
 * Listens for `window.postMessage` events of two shapes:
 *   - `{ kind: "quanta:hotkey-capture", text }` — OCR text capture; App.tsx
 *     appends the text to the input bar independently, this is UI feedback.
 *   - `{ kind: "quanta:hotkey-image-capture", … }` — UUX-3-16: the image
 *     capture (Cmd+Ctrl+Shift+[). The Rust pipeline (hotkey.rs) postMessages
 *     the payload; before this listener the capture succeeded (or silently
 *     fell back from a failed window pick to the MAIN display) with zero web
 *     feedback. The toast names what was captured, and calls out the
 *     window-pick → main-display fallback explicitly.
 *
 * Purely UI feedback — never mutates input/attachment state (App.tsx routes
 * the same events into the composer independently). The toast hides ~2.5s
 * after the last event.
 */
export const HotkeyToast = ({
  initialMessage,
}: {
  /** SSR test seam (mirrors ThreadPicker's `initialSnapshot`): static markup
   *  cannot deliver window messages, so tests pin the render path by seeding
   *  the visible message. Production callers omit it. */
  readonly initialMessage?: string
} = {}): JSX.Element | null => {
  const [message, setMessage] = useState<string | null>(initialMessage ?? null)

  useEffect(() => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const show = (text: string): void => {
      setMessage(text)
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => setMessage(null), 2500)
    }
    const handler = (ev: MessageEvent<unknown>) => {
      if (isHotkeyCapturePayload(ev.data)) {
        show("Screen capture appended to draft")
        return
      }
      if (isHotkeyImagePayload(ev.data)) {
        show(imageCaptureToastText(ev.data))
      }
    }
    window.addEventListener("message", handler)
    return () => {
      window.removeEventListener("message", handler)
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    }
  }, [])

  if (message === null) return null

  return (
    <div
      className={cx(
        "pointer-events-none fixed bottom-20 right-6 z-50",
        "rounded-xl border border-line bg-surface-overlay px-3 py-2",
        "text-xs text-ink shadow-lg backdrop-blur",
      )}
      role="status"
    >
      {message}
    </div>
  )
}

/** hotkey.rs:342 — the EXACT `monitor_name` label Rust sends when the window
 *  pick failed and the pipeline captured the main display instead. Pinned by a
 *  unit test; if the Rust wording drifts, update both in lock-step. */
const WINDOW_PICK_FALLBACK_LABEL = "Main display (window-pick fallback)"

/**
 * UUX-3-16 — derive the toast line for one image-capture payload. Success
 * names WHAT was captured (`monitor_name` carries the window label "app —
 * title" or the display name); the silent main-display fallback becomes an
 * explicit "window pick failed" notice.
 */
export const imageCaptureToastText = (payload: { readonly monitorName: string }): string => {
  if (payload.monitorName === WINDOW_PICK_FALLBACK_LABEL) {
    return "Window pick failed — captured the main display instead · attaching to next turn"
  }
  const what = payload.monitorName.length > 0 ? payload.monitorName : "screen"
  return `Captured ${what} · attaching to next turn`
}

const isHotkeyCapturePayload = (
  value: unknown,
): value is { readonly kind: "quanta:hotkey-capture"; readonly text: string } => {
  if (value === null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return obj.kind === "quanta:hotkey-capture" && typeof obj.text === "string"
}
