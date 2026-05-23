import { buildCostDashboard, renderDashboardText } from "@/observability"
import { runOnce } from "@/runner"
import { assembleConfig } from "../internal"
import type { ReplContext } from "./assemble-context"
import { snapshotAndFlushLifecyclePills } from "./lifecycle-wire"
import { installTurnCancel } from "./turn-cancel"

/** One-shot `turn()` body — the argv-prompt branch of `runRepl`. Drives a
 *  single runOnce call with Esc-Esc cancel + cost dashboard + turn-summary
 *  panel + lifecycle-pills flush wired around it. Byte-identical relocation
 *  of the prior `turn` closure inside `runRepl`. */
export const runOneShotTurn = async (ctx: ReplContext, text: string): Promise<void> => {
  const {
    sessionDeps,
    abort,
    statusBar,
    turnIndicator,
    turnSummary,
    lifecyclePills,
    lifecycleTaskRegistry,
    lifecycleFollowUpQueue,
    metrics,
    model,
    slog,
    state,
    idMeta,
  } = ctx

  const turnAbort = new AbortController()
  const turnSignal = AbortSignal.any([abort.signal, turnAbort.signal])
  const cancel = installTurnCancel(turnAbort, abort, statusBar)
  turnIndicator.start()
  const onAbortStopIndicator = (): void => turnIndicator.stop()
  turnSignal.addEventListener("abort", onAbortStopIndicator, { once: true })

  try {
    const seedImages = ctx.pendingImages
    ctx.pendingImages = []
    const turnDeps = { ...sessionDeps, signal: turnSignal }
    const result = await runOnce({
      deps: turnDeps,
      assembleConfig,
      history: ctx.history,
      prompt: text,
      pendingImages: seedImages,
      state,
      idMeta,
    })
    ctx.history = result.messages
    if (metrics) {
      const snap = metrics.snapshot()
      slog.info("metrics.snapshot", { snapshot: snap })
      process.stderr.write(`${renderDashboardText(buildCostDashboard(snap, { model }))}\n`)
    }
    const summary = turnSummary.render(result.outcome)
    if (summary !== "") process.stderr.write(summary)
    turnSummary.reset()
    snapshotAndFlushLifecyclePills(lifecyclePills, lifecycleTaskRegistry, lifecycleFollowUpQueue)
  } catch (e) {
    turnIndicator.stop()
    if (turnAbort.signal.aborted && !abort.signal.aborted) return
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`\n\x1b[31merror:\x1b[0m ${msg}\n`)
    statusBar.transient(`error: ${msg.slice(0, 120)}`, 4000)
  } finally {
    turnSignal.removeEventListener("abort", onAbortStopIndicator)
    turnIndicator.stop()
    cancel.dispose()
    turnSummary.reset()
  }
}
