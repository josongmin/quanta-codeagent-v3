import type { ActiveTurnRefHolder } from "@/agent/conversation-action-surface"
import {
  buildPursuitContinuationPrompt,
  createObjectiveCapabilities,
  DEFAULT_GOAL_WAKE_POLICY,
  type ObjectivePort,
  type ObjectiveReadPort,
  startGoalWakeController,
} from "@/objective"
import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import type { RuntimeSession } from "@/sdk/runtime"
import { runtimeConfigFromEnv } from "@/shared"

export interface WebGoalWakeHandle {
  onAttachStart(): void
  onAttachSettled(): void
  stop(): void
}

export interface WebGoalWakeRuntimePorts {
  readonly objectiveAuthority?: ObjectivePort
  readonly activeTurnRef?: ActiveTurnRefHolder
}

interface LiveSessionView {
  snapshot: SessionSnapshotLite
  attaching: boolean
}

const isTerminal = (event: SessionEvent): boolean =>
  event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.aborted"

const projectSessionEvent = (view: LiveSessionView, event: SessionEvent): boolean => {
  if (event.type === "session.state.updated") {
    view.snapshot = { ...view.snapshot, revision: event.revision, state: event.state }
  } else if (event.type === "approval.requested") {
    view.snapshot = { ...view.snapshot, pendingApproval: event.approval }
  } else if (event.type === "approval.resolved" || isTerminal(event)) {
    view.snapshot = { ...view.snapshot, pendingApproval: null }
  }
  return isTerminal(event)
}

const pursuitPrompt = (read: ObjectiveReadPort, threadId: string): string => {
  const domain = read.readDomain(threadId)
  const criteria = domain.state?.objective.successCriteria ?? []
  const last = domain.progressReceipts?.at(-1)
  return buildPursuitContinuationPrompt(read.get(threadId)?.goal, {
    verifiedCriterionIds: criteria
      .filter(
        (criterion) =>
          criterion.kind === "checked" &&
          criterion.met &&
          criterion.completion?.source === "verifier" &&
          criterion.completion.verifierResult.passed,
      )
      .map((criterion) => criterion.id),
    remainingCriterionIds: criteria
      .filter((criterion) => !criterion.met)
      .map((criterion) => criterion.id),
    ...(last !== undefined ? { lastTurnOutcome: last.turnOutcome } : {}),
  })
}

const quiescent = (
  view: LiveSessionView,
  activeTurnRef: ActiveTurnRefHolder | undefined,
): boolean =>
  !view.attaching &&
  view.snapshot.state.status === "idle" &&
  view.snapshot.state.draftInput.trim().length === 0 &&
  view.snapshot.pendingApproval === null &&
  view.snapshot.state.identityMode !== "plan" &&
  activeTurnRef?.current.currentTurn == null

/** Compose goal pursuit over the daemon's one shared RuntimeSession. The
 * controller submits a complete prompt through the host-only atomic verb; raw
 * websocket commands therefore cannot forge a continuation capability. */
export const composeWebGoalWake = async (args: {
  readonly session: RuntimeSession
  readonly runtime: WebGoalWakeRuntimePorts
  readonly env: Record<string, string | undefined>
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}): Promise<WebGoalWakeHandle | undefined> => {
  const config = runtimeConfigFromEnv(args.env)
  const authorityPort = args.runtime.objectiveAuthority
  const submit = args.session.turn.submitGoalContinuation
  if (!config.goalContinuationEnforce || authorityPort === undefined || submit === undefined) {
    return undefined
  }
  const capabilities = createObjectiveCapabilities(authorityPort)
  const { read, system } = capabilities
  const threadId = args.session.sessionId
  const view: LiveSessionView = { snapshot: await args.session.snapshot(), attaching: false }
  let observedObjectiveRevision = read.readDomain(threadId).revision
  let stopped = false
  let terminalPending = false

  const wake = startGoalWakeController({
    enabled: true,
    threadId,
    system,
    quietWindowMs: config.goalQuietMs,
    policy: {
      ...DEFAULT_GOAL_WAKE_POLICY,
      minQuietMs: config.goalQuietMs,
      maxBackoffMs: config.goalMaxBackoffMs,
      maxAutonomousTurns: config.goalMaxAutonomousTurns,
    },
    readDomain: (id) => read.readDomain(id),
    isQuiescent: () => quiescent(view, args.runtime.activeTurnRef),
    ...(args.setTimeoutFn !== undefined ? { setTimeoutFn: args.setTimeoutFn } : {}),
    ...(args.clearTimeoutFn !== undefined ? { clearTimeoutFn: args.clearTimeoutFn } : {}),
    resumeAttempt: async (id, attempt) => {
      const sessionSnapshot = await args.session.snapshot()
      const domain = read.readDomain(id)
      const expectedAttachGeneration = domain.attachGeneration ?? 0
      await submit.call(args.session.turn, {
        text: pursuitPrompt(read, id),
        expectedSessionRevision: sessionSnapshot.revision,
        objectiveId: attempt.objectiveId,
        objectiveRevision: attempt.objectiveRevision,
        validateCurrent: () => {
          const current = read.readDomain(id)
          return (
            current.state?.objective.status === "active" &&
            current.state.objective.objectiveId === attempt.objectiveId &&
            current.revision === attempt.objectiveRevision &&
            (current.attachGeneration ?? 0) === expectedAttachGeneration
          )
        },
      })
    },
    probes: {
      objective: authorityPort,
      threadIdle: () => true,
      planModeActive: () => view.snapshot.state.identityMode === "plan",
      turnActive: () =>
        view.snapshot.state.status === "running" ||
        args.runtime.activeTurnRef?.current.currentTurn != null,
      queuedInputPending: () =>
        view.attaching ||
        view.snapshot.state.draftInput.trim().length > 0 ||
        view.snapshot.pendingApproval !== null,
      mailboxInputPending: () => false,
      isEphemeral: () => false,
      resume: async () => undefined,
    },
  })
  if (wake === undefined) return undefined

  const unsubscribe = args.session.subscribe((event) => {
    if (stopped) return
    if (projectSessionEvent(view, event)) {
      terminalPending = true
      return
    }
    const currentRevision = read.readDomain(threadId).revision
    if (currentRevision !== observedObjectiveRevision) {
      observedObjectiveRevision = currentRevision
      wake.onGoalMutation()
      return
    }
    if (event.type === "session.state.updated" && terminalPending) {
      terminalPending = false
      wake.onTurnSettled()
      return
    }
    wake.onActivity()
  })

  const onAttachSettled = (): void => {
    view.attaching = false
    observedObjectiveRevision = read.readDomain(threadId).revision
    wake.onAttach(threadId)
  }
  return {
    onAttachStart: () => {
      view.attaching = true
      wake.onActivity()
    },
    onAttachSettled,
    stop: () => {
      if (stopped) return
      stopped = true
      unsubscribe()
      wake.stop()
    },
  }
}
