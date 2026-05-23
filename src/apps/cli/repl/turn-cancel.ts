import { emitKeypressEvents } from "node:readline"
import type { StatusBar } from "../status-bar"

/** Install a stdin keypress listener for the duration of one turn.
 *  Returns a `dispose()` that the caller MUST invoke (try/finally) to
 *  restore the previous terminal state. Two cancellation gestures:
 *
 *    - **Ctrl+C** ⇒ hard exit (outer `abort.abort()`).
 *    - **Esc (twice within 2 s)** ⇒ soft cancel of the current turn
 *      via `turnAbort.abort()`. The first Esc paints a hint; the
 *      second within the window triggers the abort.
 *
 *  Raw mode is REQUIRED for keypress events to fire while the LLM
 *  streams (terminal would otherwise line-buffer input). On non-TTY
 *  stdin we no-op — there's no interactive cancellation to wire up.
 *
 *  Extracted from `runRepl` so the host stays under biome's cognitive-
 *  complexity budget. The `outerAbort` is the surface-scoped controller
 *  (Ctrl+C maps onto it); `turnAbort` is the per-turn controller
 *  (Esc-Esc maps onto it). */
export const installTurnCancel = (
  turnAbort: AbortController,
  outerAbort: AbortController,
  status: StatusBar,
): { dispose: () => void } => {
  const stdin = process.stdin
  if (stdin.isTTY !== true) return { dispose: (): void => undefined }
  let escCount = 0
  let lastEsc = 0
  const ESC_WINDOW_MS = 2000
  type Key = { name?: string; ctrl?: boolean }
  const onKey = (_str: string | undefined, key: Key | undefined): void => {
    if (key === undefined) return
    if (key.ctrl === true && key.name === "c") {
      status.transient("⛔ interrupted — exiting…", 1500)
      outerAbort.abort()
      return
    }
    if (key.name !== "escape") {
      escCount = 0
      return
    }
    const now = Date.now()
    if (escCount === 1 && now - lastEsc < ESC_WINDOW_MS) {
      status.transient("⛔ turn cancelled", 1500)
      turnAbort.abort()
      escCount = 0
      return
    }
    escCount = 1
    lastEsc = now
    status.transient("Press Esc again within 2s to cancel · Ctrl+C to exit", ESC_WINDOW_MS)
  }
  emitKeypressEvents(stdin)
  const wasRaw = stdin.isRaw ?? false
  stdin.setRawMode(true)
  stdin.resume()
  stdin.on("keypress", onKey)
  return {
    dispose: (): void => {
      stdin.removeListener("keypress", onKey)
      stdin.setRawMode(wasRaw)
      stdin.pause()
    },
  }
}
