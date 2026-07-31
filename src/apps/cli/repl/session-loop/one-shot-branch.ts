import type { AgentOutcome } from "@/agent"
import type { Message } from "@/llm"
import { lastTurnOutcomeFromAgentOutcome } from "@/reactor"
import { updateSessionState } from "../session-state"
import { runOneTurn } from "../turn-runner"
import type { OneShotBranchCtx } from "./branch-context"
import { ESC_WINDOW_MS, notifyTurnComplete } from "./turn-helpers"
import { recordTurnSnapshot } from "./wiring-installs"

/** One-shot dispatch: drive a SINGLE turn through `runOneTurn` then return.
 *  Extracted verbatim from `runSessionLoop`; the `try/finally` (turn then
 *  `drainCloseStack`), the `onAfterResult` fold, and the notify ordering are
 *  byte-identical. Mutable surface/outcome state flows through the ctx setters
 *  (the former `let` reassignments). */
export const runOneShotBranch = async (ctx: OneShotBranchCtx): Promise<void> => {
  const {
    setup,
    sinks,
    withInTurnCapture,
    runSessionTurn,
    externalPromptQueue,
    convCheckpointWire,
    notify,
    notifyCwdBasename,
    drainCloseStack,
    getSurfaceState,
    setSurfaceState,
    setLastTurnOutcome,
  } = ctx
  const { abort, statusBar, turnIndicator, turnSummary } = setup
  try {
    // #8 last-mile (jun-6) — the concurrent in-turn reader wraps the awaited
    // turn (no-op passthrough when capture is off ⇒ byte-identical).
    const out = await withInTurnCapture(() =>
      runOneTurn<{
        readonly messages: readonly Message[]
        readonly outcomeReason?: AgentOutcome["reason"]
      }>(
        {
          outerAbort: abort,
          statusBar,
          turnIndicator,
          turnSummary,
          escWindowMs: ESC_WINDOW_MS,
          body: async (turnSignal) =>
            await runSessionTurn({ text: setup.argPrompt as string, turnSignal }),
        },
        {
          onAfterResult: (result) => {
            setSurfaceState(updateSessionState(getSurfaceState(), { history: result.messages }))
            // The host-injected `renderTurnDashboard` sink does the metrics
            // snapshot fold + dashboard write + cost-panel fold internally
            // (host wires it to the SAME inline code the prior `turn` closure
            // ran). One-shot AND interactive funnel through this single sink
            // so the per-turn render is byte-identical across both paths.
            sinks.renderTurnDashboard()
            sinks.renderAndResetSummary(result)
            sinks.flushLifecyclePills({ externalQueued: externalPromptQueue.size() })
            if (result.outcomeReason !== undefined) {
              setLastTurnOutcome(
                lastTurnOutcomeFromAgentOutcome({
                  reason: result.outcomeReason,
                }),
              )
            }
            // ADR-0292 — turn-end snapshot. No-op when the wire is null.
            recordTurnSnapshot(convCheckpointWire, result.messages)
          },
          onError: sinks.renderTurnError,
        },
      ),
    )
    // RFC-09 (A) — turn-completion notify (one-shot path). Fires BEFORE the
    // finally drains the close stack (which restores the title via dispose).
    notifyTurnComplete(notify, out, notifyCwdBasename ?? "")
  } finally {
    // L5 H-7 — single teardown authority. Drains session.close +
    // runtimeFacade.close + playbookSeam.detach (registered above) LIFO,
    // even if the turn body threw before completing.
    await drainCloseStack()
  }
}
