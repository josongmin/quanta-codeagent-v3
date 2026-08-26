import type { AgentOutcome } from "@/agent"
import type { Message } from "@/llm"
import { asObjectiveReadPort, type ObjectiveAttemptSlot } from "@/objective"
import { lastTurnOutcomeFromAgentOutcome } from "@/reactor"
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

/** GOAL-04 — claim the host-owned attempt slot for a goal-attributed turn. The
 *  runtime takes the claim at turn start and settles it; a claim the turn never
 *  took (stale / not started) is released by the caller after the turn. */
export const claimGoalAttempt = (
  slot: ObjectiveAttemptSlot | undefined,
  objectiveStore: InteractiveBranchCtx["objectiveStore"],
  prompt: ReturnType<typeof normalizeCliPromptInput>,
): boolean => {
  const meta = prompt.goalContinuation
  if (slot === undefined || meta === undefined || objectiveStore === undefined) return false
  const domain = asObjectiveReadPort(objectiveStore).readDomain(meta.threadId)
  const objectiveId = domain.state?.objective.objectiveId
  if (objectiveId === undefined) return false
  return slot.claim({
    threadId: meta.threadId,
    objectiveId,
    startedRevision: domain.revision,
    attemptId: meta.attemptKey,
    provenance: meta.provenance ?? "autonomous-continuation",
    executionMode: "foreground",
  })
}

export const isStaleGoalContinuation = (
  prompt: ReturnType<typeof normalizeCliPromptInput>,
  objectiveStore: InteractiveBranchCtx["objectiveStore"],
  liveThreadId: string | undefined,
  goalWakeSlot?: InteractiveBranchCtx["goalWakeSlot"],
): boolean => {
  const meta = prompt.goalContinuation
  if (meta === undefined) return false
  if (liveThreadId === undefined || meta.threadId !== liveThreadId) return true
  // GOAL-06 rail 11 — raw user input since the arm moved the controller's
  // epoch: drop ONLY this continuation (the user's draft is untouched).
  const liveEpoch = goalWakeSlot?.current?.activityEpoch?.()
  if (
    meta.activityEpoch !== undefined &&
    liveEpoch !== undefined &&
    liveEpoch !== meta.activityEpoch
  ) {
    return true
  }
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

type InteractiveTurnResult = {
  readonly messages: readonly Message[]
  readonly outcomeReason?: AgentOutcome["reason"]
}

const settleForegroundTurn = async (args: {
  readonly ctx: InteractiveBranchCtx
  readonly wiring: InteractiveWiring
  readonly prompt: ReturnType<typeof normalizeCliPromptInput>
  readonly out: RunOneTurnResult<InteractiveTurnResult>
}): Promise<void> => {
  const { ctx, wiring, out } = args
  // GOAL-04 — settlement is runtime-owned (before persistence); the surface only
  // releases a claim the turn never consumed so a stale claim cannot leak into
  // the next attributed turn.
  ctx.objectiveAttemptSlot?.release()
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
    objectiveAttemptSlot,
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
    if (
      isStaleGoalContinuation(prompt, objectiveStore, getSurfaceState().sessionId, goalWakeSlot)
    ) {
      // A queued continuation is data, not proof. Drop an old revision before
      // it can start an agent body, then let the current authority state arm a
      // fresh quiet-window attempt if it remains active.
      goalWakeSlot?.current?.onGoalMutation()
      continue
    }
    claimGoalAttempt(objectiveAttemptSlot, objectiveStore, prompt)
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
                  // GOAL-04 — the runtime settles the attributed attempt inside the
                  // body; the surface only drops an unconsumed claim once it settles.
                  handle.body.then(
                    () => objectiveAttemptSlot?.release(),
                    () => objectiveAttemptSlot?.release(),
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
    await settleForegroundTurn({ ctx, wiring, prompt, out })
  }
}
