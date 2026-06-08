import { useEffect, useState } from "react"
import { cx } from "../lib/classnames"

/**
 * Placeholder for the Tauri shell (Worker D) hotkey-capture integration.
 *
 * Listens for `window.postMessage` events of the shape:
 *   { kind: "quanta:hotkey-capture", text: string }
 *
 * When one arrives, shows a transient toast for ~2.5s acknowledging the
 * capture. The capture text is ALSO appended to the input bar by `App.tsx`
 * (which listens to the same event independently). This component is purely
 * UI feedback — it does NOT mutate any input state.
 *
 * Worker D fires this event from the native side via:
 *   window.postMessage({ kind: "quanta:hotkey-capture", text: "<captured>" }, "*")
 */
export const HotkeyToast = (): JSX.Element | null => {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const handler = (ev: MessageEvent<unknown>) => {
      if (!isHotkeyCapturePayload(ev.data)) return
      setVisible(true)
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => setVisible(false), 2500)
    }
    window.addEventListener("message", handler)
    return () => {
      window.removeEventListener("message", handler)
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    }
  }, [])

  if (!visible) return null

  return (
    <div
      className={cx(
        "pointer-events-none fixed bottom-20 right-6 z-50",
        "rounded-xl border border-line bg-surface-overlay px-3 py-2",
        "text-xs text-ink shadow-lg backdrop-blur",
      )}
      role="status"
    >
      Screen capture appended to draft
    </div>
  )
}

const isHotkeyCapturePayload = (
  value: unknown,
): value is { readonly kind: "quanta:hotkey-capture"; readonly text: string } => {
  if (value === null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    obj.kind === "quanta:hotkey-capture" && typeof obj.text === "string"
  )
}
