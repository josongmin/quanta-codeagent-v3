import type { AgentOutcome } from "@/agent"
import type { Message } from "@/llm"
import { lastTurnOutcomeFromAgentOutcome } from "@/reactor"
import { normalizeCliPromptInput } from "../prompt-types"
import { updateSessionState } from "../session-state"
import { runOneTurn } from "../turn-runner"
import type { InteractiveBranchCtx } from "./branch-context"
import type { InteractiveWiring } from "./interactive-setup"
import {
  ESC_WINDOW_MS,
  handleMovedToBackground,
  notifyTurnComplete,
  shouldWireBackground,
} from "./turn-helpers"
import { recordTurnSnapshot } from "./wiring-installs"

/** The interactive input/turn loop: `promptSource.next → runOneTurn → fold`
 *  until the outer abort fires or the source ends. Extracted verbatim from
 *  `runSessionLoop`; every await point, early `continue`/`break`, the Ctrl+B
 *  wiring, the SSOT outcome labeling, and the fold ordering are byte-identical.
 *  Mutable surface/outcome state flows through the ctx callbacks. */
export const runInteractiveLoop = async (
  ctx: InteractiveBranchCtx,
  wiring: InteractiveWiring,
): Promise<void> => {
  const {
    setup,
    sinks,
    withInTurnCapture,
    runSessionTurn,
    externalPromptQueue,
    convCheckpointWire,
    notify,
    notifyCwdBasename,
    backgroundPortal,
    inboundMode,
    conversationActions,
    getSurfaceState,
    setSurfaceState,
    setLastTurnOutcome,
  } = ctx
  const { abort, statusBar, turnIndicator, turnSummary } = setup
  const { promptSource, ndjson, promptSuggestionTurnCompletion } = wiring
  while (abort.signal.aborted !== true) {
    const next = await promptSource.next(abort.signal)
    if (next === null) break
    const prompt = normalizeCliPromptInput(next)
    // Ticket 18 (V1) — discoverable turn-start hint. Painted ONLY when the
    // Ctrl+B detach is actually wired for THIS turn (portal present + WEAVE
    // guard satisfied) so the affordance never advertises a no-op key.
    if (
      shouldWireBackground({
        portal: backgroundPortal,
        inboundMode,
        conversationActions,
      })
    ) {
      process.stderr.write("\x1b[2m· Ctrl+B background · Esc Esc cancel\x1b[0m\n")
    }
    // #8 last-mile (jun-6) — the concurrent in-turn reader wraps the awaited
    // turn (no-op passthrough when capture is off ⇒ byte-identical). The
    // turn-boundary reader (`promptSource.next` above) has already resolved +
    // detached, so the in-turn reader is the ONLY stdin consumer for the turn.
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
            await runSessionTurn({
              text: prompt.text,
              images: prompt.images,
              turnSignal,
            }),
          // Ticket 18 (V1) — Ctrl+B detach. Wired ONLY when the portal exists
          // AND the WEAVE guard allows it (see `shouldWireBackground`): in
          // weave / mid-interrupt the sink is omitted ⇒ Ctrl+B is a no-op and
          // the FSM is byte-identical. On detach: register the LIVE body
          // promise + the turn's AbortController with the portal; the body
          // keeps streaming, the loop returns to a fresh prompt (the
          // `out.backgrounded` skip below), and the portal fires the existing
          // notify port on completion.
          ...(shouldWireBackground({
            portal: backgroundPortal,
            inboundMode,
            conversationActions,
          })
            ? {
                // Detach side-effects (portal register + WS-H capture tee +
                // breadcrumbs + notify reuse) live in the free helper so the
                // branch stays out of this function's god-fn budget.
                onMovedToBackground: (handle) =>
                  handleMovedToBackground({
                    portal: backgroundPortal,
                    capture: setup.backgroundStreamCapture,
                    promptText: prompt.text,
                    notify,
                    notifyCwdBasename,
                    write: (s) => process.stderr.write(s),
                    handle,
                  }),
              }
            : {}),
        },
        {
          onAfterResult: (result) => {
            setSurfaceState(updateSessionState(getSurfaceState(), { history: result.messages }))
            sinks.renderTurnDashboard()
            sinks.renderAndResetSummary(result)
            sinks.flushLifecyclePills({ externalQueued: externalPromptQueue.size() })
            if (result.outcomeReason !== undefined) {
              setLastTurnOutcome(
                lastTurnOutcomeFromAgentOutcome({
                  reason: result.outcomeReason,
                } as AgentOutcome),
              )
            }
            recordTurnSnapshot(convCheckpointWire, result.messages)
            // ADR-0468 — mirror the turn boundary to the introspection sink.
            // No-op (no alloc) when the sink is the default-OFF NullNdjsonSink.
            ndjson.sink.emit({
              type: "turn.complete",
              ts: Date.now(),
              messageCount: result.messages.length,
            })
          },
          onError: sinks.renderTurnError,
        },
      ),
    )
    // Ticket 18 (V1) — the turn was moved to the background (Ctrl+B). The
    // portal now owns the live body promise; skip the history fold / notify
    // / suggestion and return to `promptSource.next` for a FRESH prompt. V1
    // does NOT fold a backgrounded turn into surface `history` (the SDK
    // session is SSOT — documented limitation, not a bug).
    if (out.backgrounded === true) continue
    process.stderr.write("\n")
    // ALBB-18 (1) — label fidelity: an Esc-Esc / turn-abort is the SAME
    // terminal reason (`"aborted"`) the happy path routes through the SSOT
    // classifier, which maps it to `"partial"` — so route the abort branch
    // through the SAME SSOT rather than hardcoding `"fail"` (which disagreed
    // with the classifier for the identical reason). A genuine no-result /
    // error with NO abort stays `"fail"`. No behavioral effect today (self-
    // wake Guard 3 blocks both `"fail"` AND `"partial"`); this pins the label
    // to the SSOT so a future Guard-3 loosening cannot make the mislabel
    // silently load-bearing.
    if (out.turnAborted) {
      setLastTurnOutcome(lastTurnOutcomeFromAgentOutcome({ reason: "aborted" } as AgentOutcome))
    } else if (out.result === undefined) {
      setLastTurnOutcome("fail")
    }
    // RFC-09 (A) — turn-completion notify (interactive path).
    notifyTurnComplete(notify, out, notifyCwdBasename ?? "")
    // ADR-0467 — prompt suggestion (pre-next-prompt). No-op when the wire
    // is null (default-OFF). No-throw: run() always resolves.
    await promptSuggestionTurnCompletion?.run({
      messages: getSurfaceState().history,
      signal: abort.signal,
    })
  }
}
