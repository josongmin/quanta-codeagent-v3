import type { PromptPayload, PromptSource } from "@/runner"
import type { IdleMonitor } from "../idle-monitor"
import type { RejectCounter } from "../reject-counter"
import type { StatusBar } from "../status-bar"

/** Wrap an inner CLI {@link PromptSource} with the Cursor-inspired idle /
 *  snooze gate + reject-counter graceful exit. Extracted from `runRepl` so
 *  that host stays under biome's cognitive-complexity budget.
 *
 *  Order in the `next` loop:
 *   1. `rejects.shouldAutoExit()` ⇒ return `null` (graceful loop exit —
 *      the `runRepl` `finally` still shuts MCP and tears down the status
 *      bar; we do NOT call `process.exit`).
 *   2. `idle.isSnoozed()` ⇒ paint hint banner; the inner read still fires
 *      so the user can type `/resume` to wake.
 *   3. `idle.isIdle()` ⇒ soft hint only (no gate — blocking on idle would
 *      deadlock since a keystroke IS the wake event).
 *   4. After a non-null line: if still snoozed, decline + loop back;
 *      otherwise `idle.markActive()` and return. */
export const wrapPromptSourceWithIdleGate = (args: {
  readonly inner: PromptSource
  readonly idle: IdleMonitor
  readonly rejects: RejectCounter
  readonly statusBar: StatusBar
}): PromptSource => {
  const { inner, idle, rejects, statusBar } = args
  const paintGateBanners = (): void => {
    if (idle.isSnoozed()) {
      statusBar.transient("⏸ snoozed — type /resume to wake", 4000)
      process.stderr.write("[snoozed — type /resume to wake, or wait for the snooze window]\n")
      return
    }
    if (idle.isIdle()) {
      statusBar.transient("[idle 60s — auto-paused. type or /resume]", 3000)
    }
  }
  /** One read cycle: returns the next prompt payload, `null` for loop exit,
   *  or `undefined` to signal "retry" (snoozed declined input). Splitting
   *  this off keeps `next` flat enough for the biome complexity budget.
   *  Returns the {@link PromptPayload} verbatim so a multi-modal payload
   *  (`{ text, images }`) flows through this idle/reject gate unchanged. */
  const readOneGated = async (signal?: AbortSignal): Promise<PromptPayload | null | undefined> => {
    if (rejects.shouldAutoExit()) {
      process.stderr.write("\n[20 consecutive denials — exiting. To re-enable, restart quanta]\n")
      return null
    }
    paintGateBanners()
    const next = await inner.next(signal)
    if (next === null) return null
    if (idle.isSnoozed()) {
      process.stderr.write("(snoozed — input declined; type /resume to wake)\n")
      return undefined
    }
    idle.markActive()
    return next
  }
  return {
    next: async (signal) => {
      while (signal?.aborted !== true) {
        const out = await readOneGated(signal)
        if (out === null) return null
        if (out !== undefined) return out
      }
      return null
    },
  }
}
