import type { AgentConfig } from "@/agent"
import { startAutomationEngineTicker } from "@/agent/loop-helpers"
import type { ObjectiveAttemptSlot, ObjectivePort } from "@/objective"
import {
  buildPursuitContinuationPrompt,
  createObjectiveCapabilities,
  DEFAULT_GOAL_WAKE_POLICY,
  startGoalWakeController,
} from "@/objective"
import { buildAutorunEligibility } from "@/permission"
import { injectSimulatedTurn, type LastTurnOutcome, REACTOR_ENV_FLAG } from "@/reactor"
import { gateOnStrict, logger, runtimeConfig } from "@/shared"
import { readCliKnob } from "../../cli-knobs-accessor"
import type { ImageQueue } from "../../image-queue"
import type { NotificationPort } from "../../notify"
import { startReactorWatchBridge } from "../../reactor-watch-bridge"
import type { TextInbox } from "../../text-inbox"
import { wireInboxBannerOntoSlot } from "../automation-banner"
import type { ExternalPromptQueue } from "../external-prompt-queue"
import { isQuiescent } from "../goal-quiescence"
import type { GoalWakeSignalSlot } from "../goal-wake-signal"
import type { heartbeatEnqueueHandler } from "../heartbeat-binder"
import { maybeCreateNdjsonSinkWire } from "../ndjson-wire"
import {
  type ComposePromptPipelineDeps,
  composePromptPipeline,
  type DispatchSlash,
} from "../prompt-pipeline"
import {
  buildPromptSuggestionTurnCompletionAdapter,
  maybeCreatePromptSuggestionWire,
} from "../prompt-suggestion-wire"
import type { SessionSetupResult } from "../session-setup"
import type { CloseStackEntry } from "./close-stack"
import { buildPromptPipelineNotifyDeps } from "./turn-helpers"

/** The heartbeat-aware enqueue signature the reactor bridge + goal resume call. */
type EnqueueWithHeartbeat = ReturnType<typeof heartbeatEnqueueHandler>

/** The wired interactive handles the loop consumes each iteration. Built once
 *  before the run loop; every handle is either live or a default-OFF no-op. */
export interface InteractiveWiring {
  readonly promptSource: ReturnType<typeof composePromptPipeline>
  readonly ndjson: ReturnType<typeof maybeCreateNdjsonSinkWire>
  readonly promptSuggestionTurnCompletion: ReturnType<
    typeof buildPromptSuggestionTurnCompletionAdapter
  >
}

/** The identity-mode cell accessor the setup reads for plan-mode detection. */
interface IdentityModeCell {
  readonly get: () => string
}

/** Inputs for {@link wireInteractiveSetup}. */
export interface InteractiveSetupArgs {
  readonly setup: SessionSetupResult
  readonly closeStack: Array<CloseStackEntry>
  readonly liveAutomationSlot: NonNullable<AgentConfig["automationEngine"]> | undefined
  readonly dispatchSlash: DispatchSlash
  readonly externalPromptQueue: ExternalPromptQueue
  readonly imageQueue: ImageQueue | undefined
  readonly textInbox: TextInbox | undefined
  readonly ux: ComposePromptPipelineDeps["ux"]
  readonly notify: NotificationPort | undefined
  readonly notifyCwdBasename: string | undefined
  readonly contextWarning: (() => string) | undefined
  readonly objectiveStore: ObjectivePort | undefined
  readonly objectiveAttemptSlot: ObjectiveAttemptSlot | undefined
  readonly goalWakeSlot: GoalWakeSignalSlot | undefined
  readonly activeTurnRef: AgentConfig["activeTurnRef"]
  readonly activeIdentityModeState: IdentityModeCell | undefined
  readonly planQueueStore: import("@/agent/plan-queue").PlanQueueStore | undefined
  readonly currentThreadId: () => string | undefined
  readonly enqueueWithHeartbeat: EnqueueWithHeartbeat
  readonly getLastTurnOutcome: () => LastTurnOutcome | undefined
  readonly getLastUserInputAt: () => number
  readonly setLastUserInputAt: (at: number) => void
}

/** Build every interactive-only wire (automation ticker + banner, the prompt
 *  pipeline, the reactor bridge, the goal-continuation wake controller + `/goal` chip
 *  timer, the NDJSON sink, the prompt-suggestion adapter). Each resource that
 *  needs teardown registers on the passed close stack IMMEDIATELY after
 *  construction, exactly as the inline body did (L5 H-7 ordering preserved).
 *  Extracted verbatim from `runSessionLoop`; behavior is byte-identical and
 *  every default-OFF gate is unchanged. */
export const wireInteractiveSetup = async (
  args: InteractiveSetupArgs,
): Promise<InteractiveWiring> => {
  const {
    setup,
    closeStack,
    liveAutomationSlot,
    dispatchSlash,
    externalPromptQueue,
    imageQueue,
    textInbox,
    ux,
    notify,
    notifyCwdBasename,
    contextWarning,
    objectiveStore,
    objectiveAttemptSlot,
    goalWakeSlot,
    activeTurnRef,
    activeIdentityModeState,
    planQueueStore,
    currentThreadId,
    enqueueWithHeartbeat,
    getLastTurnOutcome,
    setLastUserInputAt,
  } = args
  armAutomationTicker(liveAutomationSlot, closeStack)

  // Initial blank row matches the prior `runReplLoopRaw` header write so
  // the very first composer row sits one line below the resume log.
  process.stderr.write("\n")

  const promptSource = composePromptPipeline({
    dispatchSlash,
    externalPromptQueue,
    ...(imageQueue !== undefined ? { imageQueue } : {}),
    ...(textInbox !== undefined ? { textInbox } : {}),
    idleMonitor: setup.idleMonitor,
    onLocalPromptAccepted: () => {
      setLastUserInputAt(Date.now())
    },
    onLocalInput: () => goalWakeSlot?.current?.onActivity(),
    onLocalActivity: () => goalWakeSlot?.current?.onActivity(),
    onLocalInputSettled: () => goalWakeSlot?.current?.onLocalInputSettled(),
    rejectCounter: setup.rejectCounter,
    statusBar: setup.statusBar,
    ...(ux !== undefined ? { ux } : {}),
    // RFC-09 (A) idle path + (B) pre-compaction preamble. Each absent ⇒ the
    // pipeline behaves byte-identically.
    ...buildPromptPipelineNotifyDeps({ notify, notifyCwdBasename, contextWarning }),
  })

  await startReactorBridge({
    setup,
    closeStack,
    enqueueWithHeartbeat,
    getLastTurnOutcome,
    getLastUserInputAt: args.getLastUserInputAt,
  })

  armGoalWake({
    setup,
    closeStack,
    objectiveStore,
    objectiveAttemptSlot,
    goalWakeSlot,
    activeTurnRef,
    externalPromptQueue,
    imageQueue,
    textInbox,
    planQueueStore,
    activeIdentityModeState,
    currentThreadId,
  })

  armGoalPill({ setup, closeStack, objectiveStore, currentThreadId })

  // ADR-0468 — NDJSON live-introspection sink. Default-OFF: NullNdjsonSink
  // (no socket/file/alloc) unless QUANTA_NDJSON_INGEST_PORT / _FILE is set.
  const ndjson = maybeCreateNdjsonSinkWire({ env: process.env, logger })
  closeStack.push({ label: "ndjson.stop", dispose: () => ndjson.stop() })
  // ADR-0467 — prompt-suggestion wire. Default-OFF: null (zero LLM, zero
  // render) unless QUANTA_ENABLE_PROMPT_SUGGESTION === "1".
  const promptSuggestion = maybeCreatePromptSuggestionWire(process.env, setup.llm, (text) =>
    process.stderr.write(`\x1b[2m${text}\x1b[0m\n`),
  )
  const promptSuggestionTurnCompletion = buildPromptSuggestionTurnCompletionAdapter(
    promptSuggestion,
    {
      planMode: () => setup.planMode || activeIdentityModeState?.get() === "plan",
      providerRateLimitRemainingPercent: setup.providerRateLimitRemainingPercent,
      pendingPromptLabels: () => setup.midTurnApprovalChannel.pendingLabels?.(),
    },
  )
  return { promptSource, ndjson, promptSuggestionTurnCompletion }
}

/** #22 — arm the persistent per-session automation ticker over the REPL-owned
 *  slot (optionally composing the `QUANTA_AUTOMATION_INBOX` banner onto its
 *  onTick). Registers the stop on the close stack IMMEDIATELY (before the next
 *  awaited init step), matching the inline L5 H-7 ordering. OFF ⇒ no ticker. */
const armAutomationTicker = (
  liveAutomationSlot: NonNullable<AgentConfig["automationEngine"]> | undefined,
  closeStack: Array<CloseStackEntry>,
): void => {
  // #22 — opt-in (`QUANTA_AUTOMATION_INBOX`, default-OFF) inbox banner: compose
  // `[automation inbox: N]` onto the slot's existing onTick so the live ticker
  // paints unread counts on each fire. OFF ⇒ slot untouched (byte-identical).
  const automationSlotForTicker =
    liveAutomationSlot !== undefined
      ? wireInboxBannerOntoSlot(liveAutomationSlot, {
          enabled: readCliKnob("QUANTA_AUTOMATION_INBOX", "bool") ?? false,
        }).slot
      : undefined
  const automationTicker =
    automationSlotForTicker !== undefined
      ? startAutomationEngineTicker({ automationEngine: automationSlotForTicker } as AgentConfig)
      : undefined
  if (automationTicker !== undefined) {
    // L5 H-7 — register before the next awaited init step (reactor bridge) can
    // throw, so the ticker is stopped even on a partial interactive init.
    closeStack.push({ label: "automationTicker.stop", dispose: () => automationTicker.stop() })
  }
}

/** ADR-0453 jun-02 — start the reactor watch bridge (gated by session id +
 *  REACTOR_ENV_FLAG) and register its close. The autorun-eligibility resolver +
 *  `lastTurnOutcome`/`lastUserInputAt` are read at wake time via the getters so
 *  the `on-failure` policy sees the most recent turn. */
const startReactorBridge = async (args: {
  readonly setup: SessionSetupResult
  readonly closeStack: Array<CloseStackEntry>
  readonly enqueueWithHeartbeat: EnqueueWithHeartbeat
  readonly getLastTurnOutcome: () => LastTurnOutcome | undefined
  readonly getLastUserInputAt: () => number
}): Promise<void> => {
  const { setup, closeStack, enqueueWithHeartbeat, getLastTurnOutcome, getLastUserInputAt } = args
  // ADR-0453 jun-02 wire — composition-root binding of the reactor's 4th
  // guard (per-thread autorun eligibility). The resolver reads
  // `lastTurnOutcome` at CALL time (fresh per wake) via the getter so the
  // `on-failure` policy is evaluated against the most recent turn.
  const autorunEligibility = buildAutorunEligibility(process.env, () => getLastTurnOutcome())
  const reactorBridge =
    setup.sessionId !== undefined && gateOnStrict(process.env, REACTOR_ENV_FLAG)
      ? await startReactorWatchBridge({
          sessionId: setup.sessionId,
          onTrigger: async (trigger) => {
            const lastTurnOutcome = getLastTurnOutcome()
            await injectSimulatedTurn({
              trigger,
              agentLoop: {
                // Reactor port returns Promise<void>; the handler's WS-D
                // non-delivery verdict is a heartbeat-path shape (needs a
                // targetThreadId, which the reactor never passes) — void it.
                enqueueUserMessage: async (message, opts) => {
                  await enqueueWithHeartbeat(message, opts)
                },
              },
              envPort: { get: (name) => process.env[name] },
              clockPort: { now: () => Date.now() },
              lastUserInputAt: getLastUserInputAt(),
              ...(lastTurnOutcome !== undefined ? { lastTurnOutcome } : {}),
              ...(autorunEligibility !== undefined ? { eligibility: autorunEligibility } : {}),
            })
          },
          onError: (message) => {
            process.stderr.write(`${message}\n`)
          },
        })
      : undefined
  if (reactorBridge !== undefined) {
    closeStack.push({ label: "reactorBridge.close", dispose: () => reactorBridge.close() })
  }
}

/** Codex "Pursuing goal" — arm the edge-triggered goal wake controller over
 *  the shared objective store. A verified quiet window after an active-goal
 *  mutation or a settled turn can enqueue exactly one continuation. Gated by
 *  QUANTA_GOAL_ENFORCE ⇒ OFF arms no timer (byte-identical). */
const armGoalWake = (args: {
  readonly setup: SessionSetupResult
  readonly closeStack: Array<CloseStackEntry>
  readonly objectiveStore: ObjectivePort | undefined
  readonly objectiveAttemptSlot: ObjectiveAttemptSlot | undefined
  readonly goalWakeSlot: GoalWakeSignalSlot | undefined
  readonly activeTurnRef: AgentConfig["activeTurnRef"]
  readonly externalPromptQueue: ExternalPromptQueue
  readonly imageQueue: ImageQueue | undefined
  readonly textInbox: TextInbox | undefined
  readonly planQueueStore: import("@/agent/plan-queue").PlanQueueStore | undefined
  readonly activeIdentityModeState: IdentityModeCell | undefined
  readonly currentThreadId: () => string | undefined
}): void => {
  const {
    setup,
    closeStack,
    objectiveStore,
    goalWakeSlot,
    activeTurnRef,
    externalPromptQueue,
    imageQueue,
    textInbox,
    planQueueStore,
    activeIdentityModeState,
    currentThreadId,
  } = args
  const quiescenceSnapshot = () => ({
    turnActive: activeTurnRef?.current.currentTurn !== null,
    planModeActive: setup.planMode || activeIdentityModeState?.get() === "plan",
    externalPromptPending: externalPromptQueue.size() > 0,
    textPending: (textInbox?.size() ?? 0) > 0,
    imagePending: (imageQueue?.size() ?? 0) > 0,
    planPending:
      currentThreadId() !== undefined && planQueueStore !== undefined
        ? planQueueStore.peek(currentThreadId() as string).length > 0
        : false,
    followupPending:
      currentThreadId() !== undefined
        ? (setup.lifecycleFollowUpQueue?.sizeFor(
            currentThreadId() as import("@/agent/follow-up-queue").ThreadId,
          ) ?? 0) > 0
        : false,
    approvalPending: (setup.midTurnApprovalChannel.pendingLabels?.().length ?? 0) > 0,
  })
  const hostIsQuiescent = (): boolean => isQuiescent(quiescenceSnapshot())
  const objectiveCapabilities =
    objectiveStore === undefined ? undefined : createObjectiveCapabilities(objectiveStore)
  const attemptSlot = args.objectiveAttemptSlot
  const goalWake =
    objectiveStore !== undefined && objectiveCapabilities !== undefined
      ? startGoalWakeController({
          enabled: runtimeConfig().goalContinuationEnforce,
          threadId: setup.sessionId,
          quietWindowMs: resolveGoalQuietWindowMs(),
          policy: {
            ...DEFAULT_GOAL_WAKE_POLICY,
            minQuietMs: runtimeConfig().goalQuietMs,
            maxBackoffMs: runtimeConfig().goalMaxBackoffMs,
            maxAutonomousTurns: runtimeConfig().goalMaxAutonomousTurns,
          },
          readDomain: (tid) => objectiveCapabilities.read.readDomain(tid),
          system: objectiveCapabilities.system,
          isQuiescent: hostIsQuiescent,
          // GOAL-08 round 3 — a fail-stopped attempt slot is a binding skip
          // (never arm) and is reported on the `/goal` wake line.
          ...(attemptSlot !== undefined ? { attemptSlot } : {}),
          ...(goalWakeSlot?.lifecycleSink !== undefined
            ? { lifecycleSink: goalWakeSlot.lifecycleSink }
            : {}),
          resumeAttempt: async (tid, attempt) => {
            const domain = objectiveCapabilities.read.readDomain(tid)
            const criteria = domain.state?.objective.successCriteria ?? []
            const last = domain.progressReceipts?.at(-1)
            externalPromptQueue.push({
              text: buildPursuitContinuationPrompt(objectiveStore.get(tid)?.goal, {
                verifiedCriterionIds: criteria
                  .filter(
                    (c) =>
                      c.kind === "checked" &&
                      c.met &&
                      c.completion?.source === "verifier" &&
                      c.completion.verifierResult.passed,
                  )
                  .map((c) => c.id),
                remainingCriterionIds: criteria.filter((c) => !c.met).map((c) => c.id),
                ...(last !== undefined ? { lastTurnOutcome: last.turnOutcome } : {}),
              }),
              goalContinuation: {
                threadId: attempt.threadId,
                objectiveRevision: attempt.objectiveRevision,
                attemptKey: attempt.attemptKey,
                activityEpoch: attempt.activityEpoch,
              },
            })
          },
          probes: {
            objective: objectiveStore,
            // Goal pursuit has its own edge-triggered quiet timer. The UI idle
            // monitor is a user-presence/suppression affordance and must not
            // disable continuation when QUANTA_IDLE_SUPPRESS=0.
            threadIdle: () => true,
            planModeActive: () => quiescenceSnapshot().planModeActive,
            // The runtime agent loop owns this holder from body start until the
            // body actually settles. This deliberately remains true after Ctrl+B
            // detaches the REPL wrapper, so a continuation cannot queue over a
            // backgrounded live body.
            turnActive: () => quiescenceSnapshot().turnActive,
            queuedInputPending: () => {
              const snapshot = quiescenceSnapshot()
              return (
                snapshot.externalPromptPending ||
                snapshot.imagePending ||
                snapshot.planPending ||
                snapshot.followupPending ||
                snapshot.approvalPending
              )
            },
            mailboxInputPending: () => quiescenceSnapshot().textPending,
            isEphemeral: () => currentThreadId() === undefined,
            resume: async (tid) => {
              // SSOT pursuit discipline (anti-scope-shrink + verify-before-
              // complete + blocked-hysteresis), goal fenced as user data.
              externalPromptQueue.push(
                buildPursuitContinuationPrompt(objectiveStore.get(tid)?.goal),
              )
            },
          },
        })
      : undefined
  if (goalWake !== undefined) {
    if (goalWakeSlot !== undefined) {
      goalWakeSlot.current = goalWake
      // GOAL-08 rail 15 — `/goal work` pushes one user-requested prompt through
      // the same external queue the wake controller uses.
      goalWakeSlot.enqueueWork = (input) => externalPromptQueue.push(input)
    }
    closeStack.push({
      label: "goalWake.stop",
      dispose: () => {
        if (goalWakeSlot?.current === goalWake) goalWakeSlot.current = undefined
        goalWake.stop()
      },
    })
  }
}

const resolveGoalQuietWindowMs = (): number => {
  return runtimeConfig().goalQuietMs
}

/** `/goal` chip — keep the "🎯 <objective> · <elapsed>" status pill in sync
 *  with the active objective. Independent of QUANTA_GOAL_ENFORCE: the chip
 *  shows whenever a goal is ACTIVE (Codex parity), even if not auto-pursued.
 *  Change-guarded (text + elapsed-minute) so it only repaints on real change. */
const armGoalPill = (args: {
  readonly setup: SessionSetupResult
  readonly closeStack: Array<CloseStackEntry>
  readonly objectiveStore: ObjectivePort | undefined
  readonly currentThreadId: () => string | undefined
}): void => {
  const { setup, closeStack, objectiveStore, currentThreadId } = args
  if (objectiveStore === undefined) return
  let lastGoalPillKey = ""
  const refreshGoalPill = (): void => {
    const threadId = currentThreadId()
    const active = threadId !== undefined ? objectiveStore.get(threadId) : null
    const view =
      active !== null && active.status === "active" && active.goal.length > 0
        ? { text: active.goal, elapsedMs: Date.now() - active.createdAt }
        : undefined
    const key = view === undefined ? "" : `${view.text}|${Math.floor(view.elapsedMs / 60_000)}`
    if (key === lastGoalPillKey) return
    lastGoalPillKey = key
    setup.pills.update({ goal: view })
  }
  refreshGoalPill()
  const goalPillTimer = setInterval(refreshGoalPill, 10_000)
  ;(goalPillTimer as { unref?: () => void }).unref?.()
  closeStack.push({ label: "goalPillTimer", dispose: () => clearInterval(goalPillTimer) })
}
