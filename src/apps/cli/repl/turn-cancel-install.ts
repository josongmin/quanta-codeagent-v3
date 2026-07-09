import { emitKeypressEvents } from "node:readline"
import { KB_BACKGROUND, KB_CANCEL_TURN, KB_QUIT, type KeybindTruth } from "../keybind-truth"
import type { StatusBar } from "../status-bar"

/** WS-E (jul-10, UUX-2-02) — the chord→action copy for the chords THIS
 *  installer binds, re-exported from the keybind-truth SSOT so the copy sits
 *  ADJACENT to the FSM it describes. The FSM behavior below is pinned by
 *  `turn-cancel-install-hellgate` (Ctrl+C ⇒ onAbort/quit, Esc-Esc ⇒ onCancel,
 *  Ctrl+B ⇒ onBackground); the help/welcome renders are pinned to these
 *  entries by `help-keybind-truth.hellgate` — an inversion regression
 *  (UUX-2-02 shipped `/help` with Ctrl+C and Esc-Esc SWAPPED) goes RED. */
export const TURN_CANCEL_KEYBINDS: Readonly<
  Record<"cancelTurn" | "quit" | "background", KeybindTruth>
> = {
  cancelTurn: KB_CANCEL_TURN,
  quit: KB_QUIT,
  background: KB_BACKGROUND,
} as const

/** Two cancellation gestures the per-turn raw-mode keypress listener honors.
 *  Codified so the FSM is one named type per state rather than inline
 *  branching — every transition is at the call site, no escCount math
 *  scattered through `onKey`. The FSM has four observable states:
 *
 *    - `idle`        — initial; any non-esc keypress also returns here
 *    - `first-esc`   — Esc seen once; second within `escWindowMs` ⇒ soft cancel
 *    - `second-esc`  — turnAbort fired; back to `idle` for the next turn
 *    - `ctrl-c`      — outer abort fired; surface-wide hard exit
 *
 *  Each named state is one decision in the FSM rather than two `let`s of math. */
export type CancelFsmState = "idle" | "first-esc" | "second-esc" | "ctrl-c"

/** Slice-C dependencies bag for {@link installTurnCancel}. Each field is an
 *  EXPLICIT param so the FSM owns NO closure captures over the surface state —
 *  the host can swap `onCancel` / `onAbort` per call without re-allocating
 *  the keypress listener implementation. */
export interface InstallTurnCancelDeps {
  readonly statusBar: StatusBar
  /** Esc-Esc window; same 2000 ms default the prior inline closure used.
   *  Param (not env-read here) so the call site reads as intent + so tests
   *  can shrink the window. */
  readonly escWindowMs: number
  /** Fired when the user types Esc twice within `escWindowMs` (soft per-turn
   *  cancel ⇒ tear down THIS turn but keep the REPL alive). */
  readonly onCancel: () => void
  /** Fired when the user types Ctrl+C (hard surface-wide exit ⇒ tear down
   *  the WHOLE REPL on the next loop iteration). */
  readonly onAbort: () => void
  /** Ticket 18 (V1) — fired when the user types Ctrl+B to move the running turn
   *  to the background (the body keeps streaming, owned by the portal; the REPL
   *  returns to a fresh prompt). OPTIONAL + default-OFF: when absent the Ctrl+B
   *  branch is SKIPPED entirely so the FSM is byte-identical (it falls through to
   *  the Esc/idle branches exactly as before). Sits ABOVE the Esc branch and
   *  BELOW Ctrl+C so a hard abort always wins. */
  readonly onBackground?: () => void
}

/** Install a stdin keypress listener for the duration of one turn.
 *  Returns a `dispose()` the caller MUST invoke (try/finally) to restore
 *  the previous terminal state.
 *
 *  Raw mode is REQUIRED for keypress events to fire while the LLM streams
 *  (terminal would otherwise line-buffer input). On non-TTY stdin we no-op —
 *  there is no interactive cancellation to wire up. The function is a
 *  byte-identical relocation of the prior inline `installTurnCancel` closure
 *  in `runRepl`, with the two abort sinks now explicit (`onCancel` / `onAbort`)
 *  rather than captured from the enclosing scope. */
export const installTurnCancel = (deps: InstallTurnCancelDeps): { dispose: () => void } => {
  const { statusBar, escWindowMs, onCancel, onAbort, onBackground } = deps
  const stdin = process.stdin
  if (stdin.isTTY !== true) return { dispose: (): void => undefined }
  let state: CancelFsmState = "idle"
  let lastEsc = 0
  type Key = { name?: string; ctrl?: boolean }
  const onKey = (_str: string | undefined, key: Key | undefined): void => {
    if (key === undefined) return
    if (key.ctrl === true && key.name === "c") {
      state = "ctrl-c"
      statusBar.transient("⛔ interrupted — exiting…", 1500)
      onAbort()
      return
    }
    // Ticket 18 (V1) — Ctrl+B moves the running turn to the background. ABOVE
    // the Esc branch, BELOW Ctrl+C (abort always wins). Default-OFF: when the
    // host did NOT wire `onBackground`, this branch is skipped and the FSM falls
    // through to the Esc/idle branches byte-identically.
    if (key.ctrl === true && key.name === "b" && onBackground !== undefined) {
      statusBar.transient("⏭ moved to background", 1500)
      onBackground()
      return
    }
    if (key.name !== "escape") {
      state = "idle"
      return
    }
    const now = Date.now()
    if (state === "first-esc" && now - lastEsc < escWindowMs) {
      state = "second-esc"
      statusBar.transient("⛔ turn cancelled", 1500)
      onCancel()
      state = "idle"
      return
    }
    state = "first-esc"
    lastEsc = now
    statusBar.transient("Press Esc again within 2s to cancel · Ctrl+C to exit", escWindowMs)
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
