import type { AgentOutcome } from "@/agent"
import type { Message } from "@/llm"
import { asObjectiveReadPort } from "@/objective"
import { lastTurnOutcomeFromAgentOutcome } from "@/reactor"
import { beginObjectiveProgress, finishObjectiveProgress } from "../objective-progress"
import { normalizeCliPromptInput } from "../prompt-types"
import { updateSessionState } from "../session-state"
import { type RunOneTurnResult, runOneTurn } from "../turn-runner"
import type { InteractiveBranchCtx } from "./branch-context"
import type { InteractiveWiring } from "./interactive-setup"
import {
  ESC_WINDOW_MS,
  handleMovedToBackground,
  notifyTurnComplete,
  shouldWireBackground,
} from "./turn-helpers"
import { recordTurnSnapshot } from "./wiring-installs"

const emitObjectiveProgress = (
  ndjson: InteractiveWiring["ndjson"],
  receipt: ReturnType<typeof finishObjectiveProgress>,
): void => {
  if (receipt === undefined) return
  ndjson.sink.emit({
    type: "objective.progress",
    ts: receipt.recordedAt,
    attemptKey: receipt.attemptKey,
    revisionBefore: receipt.objectiveRevisionBefore,
    revisionAfter: receipt.objectiveRevisionAfter,
    outcome: receipt.turnOutcome,
    criterionTransitions: receipt.criterionTransitions,
    verifierReceiptRefs: receipt.verifierReceiptRefs,
    ...(receipt.sourceDigest !== undefined ? { sourceDigest: receipt.sourceDigest } : {}),
    remainingCriterionIds: receipt.remainingCriterionIds,
  })
}

const isStaleGoalContinuation = (
  prompt: ReturnType<typeof normalizeCliPromptInput>,
  objectiveStore: InteractiveBranchCtx["objectiveStore"],
): boolean => {
  const meta = prompt.goalContinuation
  if (meta === undefined) return false
  if (objectiveStore === undefined) return true
  const domain = asObjectiveReadPort(objectiveStore).readDomain(meta.threadId)
  return (
    domain.state === null ||
    domain.state.objective.status !== "active" ||
    domain.revision !== meta.objectiveRevision
  )
}

const writeBackgroundHint = (args: {
  readonly portal: InteractiveBranchCtx["backgroundPortal"]
  readonly inboundMode: InteractiveBranchCtx["inboundMode"]
  readonly conversationActions: InteractiveBranchCtx["conversationActions"]
}): void => {
  if (
    shouldWireBackground({
      portal: args.portal,
      inboundMode: args.inboundMode,
      conversationActions: args.conversationActions,
    })
  ) {
    process.stderr.write("\x1b[2m· Ctrl+B background · Esc Esc cancel\x1b[0m\n")
  }
}

const settledProgressOutcomeReason = (out: {
  readonly turnAborted: boolean
  readonly result: { readonly outcomeReason?: AgentOutcome["reason"] } | undefined
}): AgentOutcome["reason"] | undefined => {
  if (out.turnAborted) return "aborted"
  return out.result?.outcomeReason
}

type InteractiveTurnResult = {
  readonly messages: readonly Message[]
  readonly outcomeReason?: AgentOutcome["reason"]
}

const settleForegroundTurn = async (args: {
  readonly ctx: InteractiveBranchCtx
  readonly wiring: InteractiveWiring
  readonly prompt: ReturnType<typeof normalizeCliPromptInput>
  readonly objectiveProgress: ReturnType<typeof beginObjectiveProgress>
  readonly out: RunOneTurnResult<InteractiveTurnResult>
}): Promise<void> => {
  const { ctx, wiring, prompt, objectiveProgress, out } = args
  const outcomeReason = settledProgressOutcomeReason(out)
  emitObjectiveProgress(
    wiring.ndjson,
    finishObjectiveProgress({
      objective: ctx.objectiveStore,
      prompt,
      started: objectiveProgress,
      ...(outcomeReason !== undefined ? { outcomeReason } : {}),
    }),
  )
  ctx.goalWakeSlot?.current?.onTurnSettled()
  process.stderr.write("\n")
  if (out.turnAborted) {
    ctx.setLastTurnOutcome(lastTurnOutcomeFromAgentOutcome({ reason: "aborted" }))
  } else if (out.result === undefined) {
    ctx.setLastTurnOutcome("fail")
  }
  notifyTurnComplete(ctx.notify, out, ctx.notifyCwdBasename ?? "")
  await wiring.promptSuggestionTurnCompletion?.run({
    messages: ctx.getSurfaceState().history,
    signal: ctx.setup.abort.signal,
  })
}

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
    objectiveStore,
    notify,
    notifyCwdBasename,
    goalWakeSlot,
    backgroundPortal,
    inboundMode,
    conversationActions,
    getSurfaceState,
    setSurfaceState,
    setLastTurnOutcome,
  } = ctx
  const { abort, statusBar, turnIndicator, turnSummary } = setup
  const { promptSource, ndjson } = wiring
  while (abort.signal.aborted !== true) {
    const next = await promptSource.next(abort.signal)
    if (next === null) break
    const prompt = normalizeCliPromptInput(next)
    if (isStaleGoalContinuation(prompt, objectiveStore)) {
      // A queued continuation is data, not proof. Drop an old revision before
      // it can start an agent body, then let the current authority state arm a
      // fresh quiet-window attempt if it remains active.
      goalWakeSlot?.current?.onGoalMutation()
      continue
    }
    const objectiveProgress = beginObjectiveProgress(objectiveStore, setup.sessionId, prompt)
    // Ticket 18 (V1) — discoverable turn-start hint. Painted ONLY when the
    // Ctrl+B detach is actually wired for THIS turn (portal present + WEAVE
    // guard satisfied) so the affordance never advertises a no-op key.
    writeBackgroundHint({ portal: backgroundPortal, inboundMode, conversationActions })
    // #8 last-mile (jun-6) — the concurrent in-turn reader wraps the awaited
    // turn (no-op passthrough when capture is off ⇒ byte-identical). The
    // turn-boundary reader (`promptSource.next` above) has already resolved +
    // detached, so the in-turn reader is the ONLY stdin consumer for the turn.
    const out = await withInTurnCapture(() =>
      runOneTurn<InteractiveTurnResult>(
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
                onMovedToBackground: (handle) => {
                  // The REPL wrapper returns immediately after Ctrl+B, but the
                  // body promise is still the authority for outcome evidence.
                  handle.body.then(
                    (result) =>
                      emitObjectiveProgress(
                        ndjson,
                        finishObjectiveProgress({
                          objective: objectiveStore,
                          prompt,
                          started: objectiveProgress,
                          ...(result.outcomeReason !== undefined
                            ? { outcomeReason: result.outcomeReason }
                            : {}),
                        }),
                      ),
                    () =>
                      emitObjectiveProgress(
                        ndjson,
                        finishObjectiveProgress({
                          objective: objectiveStore,
                          prompt,
                          started: objectiveProgress,
                          outcomeReason: "error",
                        }),
                      ),
                  )
                  handleMovedToBackground({
                    portal: backgroundPortal,
                    capture: setup.backgroundStreamCapture,
                    promptText: prompt.text,
                    notify,
                    notifyCwdBasename,
                    onSettled: () => goalWakeSlot?.current?.onTurnSettled(),
                    write: (s) => process.stderr.write(s),
                    handle,
                  })
                },
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
                }),
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
    await settleForegroundTurn({ ctx, wiring, prompt, objectiveProgress, out })
  }
}
