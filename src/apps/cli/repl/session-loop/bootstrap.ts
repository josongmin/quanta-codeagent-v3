import type { AgentConfig } from "@/agent"
import type { Message } from "@/llm"
import { createCronSlashAdapter } from "@/scheduler"
import { assembleAutomation } from "@/scheduler/runtime-wire"
import { errMessage, runtimeConfig } from "@/shared"
import { ExternalPromptQueue } from "../external-prompt-queue"
import { createHeartbeatBinder, heartbeatEnqueueHandler } from "../heartbeat-binder"
import { type MidTurnCaptureHandle, maybeCreateMidTurnCaptureWire } from "../mid-turn-capture-wire"
import { type SessionState, updateSessionState } from "../session-state"
import { stripAutomationTickerHandler } from "./automation"
import type { CloseStackController } from "./close-stack"
import { createCloseStackController } from "./close-stack"
import {
  makeInTurnCaptureWrapper,
  registerNotifyDispose,
  registerSearchPipelineDispose,
} from "./turn-helpers"
import { makeRunSessionTurn, type RunSessionTurn } from "./turn-driver"
import {
  attachPlaybookHandle,
  installHistoryReplaceWire,
  installSessionSwitchWire,
} from "./wiring-installs"
import type { RunSessionLoopDeps } from "./deps"

/** The mutable surface/timing state holder the bootstrap threads into every
 *  wire that must read/write the LIVE `let` bindings `runSessionLoop` owns. */
export interface LoopStateHolder {
  surfaceState: SessionState
}

/** Everything the branch dispatch needs after pre-branch init has run. Every
 *  field is either a live handle or a default-OFF no-op wrapper. */
export interface SessionLoopBootstrap {
  readonly closeStack: CloseStackController["closeStack"]
  readonly drainCloseStack: CloseStackController["drainCloseStack"]
  readonly externalPromptQueue: ExternalPromptQueue
  readonly withInTurnCapture: <R>(run: () => Promise<R>) => Promise<R>
  readonly runSessionTurn: RunSessionTurn
  readonly liveAutomationSlot: NonNullable<AgentConfig["automationEngine"]> | undefined
  readonly enqueueWithHeartbeat: ReturnType<typeof heartbeatEnqueueHandler>
  readonly activeIdentityModeState: ReturnType<
    RunSessionLoopDeps["setup"]["runtimeContext"]["identityModeState"]
  >
}

/** Build the ENTIRE pre-branch session-loop wiring: the external prompt queue
 *  (+ seed prompts), the heartbeat binder, the mid-turn capture wrapper, the
 *  automation engine + `/cron` late-bind, the runtime facade + session (under
 *  the close-stack guard), the `/rewind-conv` + `/fork` + `/side` + `/queue`
 *  installs, the playbook watcher attach, and the `runSessionTurn` adapter.
 *  Extracted VERBATIM from `runSessionLoop`; every await point, close-stack
 *  registration order, and default-OFF gate is byte-identical. The mutable
 *  `surfaceState` is threaded through `state` so the closures reassign the SAME
 *  binding the branches read. */
export const bootstrapSessionLoop = async (
  deps: RunSessionLoopDeps,
  state: LoopStateHolder,
): Promise<SessionLoopBootstrap> => {
  const {
    setup,
    ux,
    registerReplaceMessages,
    registerSessionSwitch,
    registerSideConversationStart,
    registerPlanQueueSendNow,
    registerAutomationSlash,
    runtimeFacadeCompose,
    playbookSeam,
    playbookCliFlag,
    searchPipelineDispose,
    notify,
  } = deps
  const { abort, runtimeContext, state: featureState, idMeta } = setup

  const externalPromptQueue = new ExternalPromptQueue()
  // ADR-0528 L2 (auto-reinject) — seed prompts BEFORE the interactive loop's
  // prompt-source race begins. One-shot never reads the queue (host only seeds
  // interactive). Empty/absent ⇒ no push (byte-identical).
  for (const seed of deps.seedPrompts ?? []) externalPromptQueue.push(seed)
  // H8 last-mile (ADR-0480) — the heartbeat thread-resume binder. The getter
  // closures resolve the LIVE session id + per-turn permission cell at fire time
  // (not a stale snapshot): reading `state.surfaceState.sessionId` inside the
  // closure sees the current thread id.
  const heartbeatBinder = createHeartbeatBinder({
    liveThreadId: () => state.surfaceState.sessionId,
    permissionCell: () => runtimeContext.permissionModeState(),
    pushPrompt: (prompt) => externalPromptQueue.push(prompt),
  })
  const enqueueWithHeartbeat = heartbeatEnqueueHandler({
    binder: heartbeatBinder,
    pushPrompt: (prompt) => externalPromptQueue.push(prompt),
  })
  // #8 last-mile (jun-6) — mid-turn keystroke capture SEAM. Default-OFF: the
  // wire is `undefined` unless `QUANTA_MIDTURN_CAPTURE=1` AND a plan-queue store
  // is present. Absent ⇒ NOTHING captures mid-turn input, no reader starts (the
  // SACRED default-OFF invariant).
  const midTurnCapture: MidTurnCaptureHandle | undefined =
    deps.planQueueStore !== undefined
      ? maybeCreateMidTurnCaptureWire({
          enabled: runtimeConfig().midTurnCapture,
          threadId: setup.sessionId,
          planQueue: deps.planQueueStore,
          pushExternal: (text) => externalPromptQueue.push(text),
        })
      : undefined
  // Wrap a `runOneTurn` invocation with the concurrent in-turn reader (factory
  // owns the per-turn index counter + the §08b `QUANTA_MIDTURN_VISIBLE`+TTY gate).
  const withInTurnCapture = makeInTurnCaptureWrapper({
    midTurnCapture,
    inTurnStdin: deps.inTurnStdin,
    inboundMode: deps.inboundMode,
    conversationActions: deps.conversationActions,
    externalPromptQueue,
    midTurnVisibleKnob: runtimeConfig().midTurnVisible,
    midTurnApprovalChannel: setup.midTurnApprovalChannel,
  })
  const liveAutomationSlot =
    runtimeContext.automationEngine() ??
    assembleAutomation(
      { get: (name) => process.env[name] },
      {
        agentLoop: {
          enqueueUserMessage: enqueueWithHeartbeat,
        },
      },
    ) ??
    undefined
  // B2 (jul-04 CLI-surfacing) `/cron` — LATE-BIND the automation slash slot the
  // instant the engine exists (minted HERE, after compose time). Absent engine ⇒
  // never called ⇒ `/cron` stays "not wired" (default-OFF byte-identical).
  if (liveAutomationSlot !== undefined && registerAutomationSlash !== undefined) {
    registerAutomationSlash(createCronSlashAdapter({ engine: liveAutomationSlot.engine }))
  }
  const activeIdentityModeState = runtimeContext.identityModeState()
  const activeToolProfileState = runtimeContext.toolProfileState()
  // ALBB-14 double-arm fix — the config-path slot carries only what the
  // `automation_update` tool needs (`engine`); `stripAutomationTickerHandler`
  // drops the `handler` so the bootstrap ticker short-circuits, leaving the REPL
  // ticker the SINGLE interval owner.
  const composeAutomationEngine = stripAutomationTickerHandler(liveAutomationSlot)
  const runtimeCompose =
    composeAutomationEngine !== undefined
      ? {
          ...(runtimeFacadeCompose ?? {}),
          automationEngine: composeAutomationEngine,
        }
      : runtimeFacadeCompose

  // L5 H-7 — single close stack + drain + init guard.
  const { closeStack, drainCloseStack, guardInit } = createCloseStackController()

  const runtimeFacade = await runtimeContext.createRuntimeFacade({
    boot: {
      mode: setup.mode,
      refreshSystemPrompt: setup.refreshSystemPrompt,
      toolProfileState: activeToolProfileState,
      identityModeState: activeIdentityModeState,
    },
    history: [...state.surfaceState.history],
    state: featureState,
    idMeta,
    shutdown: async () => undefined,
    mcpClients: setup.mcpClients as Array<{ stop: () => Promise<void> }>,
    ...(runtimeCompose !== undefined ? { compose: runtimeCompose } : {}),
  })
  closeStack.push({ label: "runtimeFacade.close", dispose: () => runtimeFacade.close() })
  const session = await guardInit(() =>
    runtimeFacade.createSession({
      cwd: setup.cwd,
      model: setup.model,
      // RFC-08 / ADR-0443 — when the mode-cycle store is wired, its CURRENT
      // posture seeds the session's permissionMode; otherwise the runtime
      // default (ADR-0303 syncs the latest posture BEFORE each turn).
      permissionMode: ux?.modeCycle?.current().permissionMode ?? runtimeContext.permissionMode(),
      ...(activeIdentityModeState !== undefined
        ? { identityMode: activeIdentityModeState.get() }
        : {}),
      ...(activeToolProfileState !== undefined
        ? { toolProfile: activeToolProfileState.get() }
        : {}),
    }),
  )
  closeStack.push({ label: "session.close", dispose: () => session.close() })
  // L5 M-11 — tear down THIS session's search wire on session close (per-session,
  // not a module singleton). Absent ⇒ nothing registered (default-OFF).
  registerSearchPipelineDispose(closeStack, searchPipelineDispose)
  // RFC-09 (A) — restore the terminal title on teardown. Idempotent no-op when
  // the port was never built.
  registerNotifyDispose(closeStack, notify)
  registerSideConversationStart?.((args) => session.side.start(args))
  // `/queue` sendNow → inject the follow-up text as the next out-of-band prompt.
  registerPlanQueueSendNow?.((inj) => {
    try {
      externalPromptQueue.push(inj.text)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: errMessage(e) }
    }
  })

  // The kernel transcript swap adapter both wiring installs share.
  const replaceTranscript = async (msgs: readonly Message[]): Promise<readonly Message[]> => {
    const result = await session.transcript.replace(msgs, undefined, { signal: abort.signal })
    return result.transcript?.messages ?? [...msgs]
  }
  // ADR-0292 — install the `/rewind-conv` swap closure.
  installHistoryReplaceWire({
    registerReplaceMessages,
    replaceTranscript,
    commitHistory: (nextHistory) => {
      state.surfaceState = updateSessionState(state.surfaceState, { history: nextHistory })
    },
  })
  // UUX-4-07 — install the `/fork` switch closure. `idMeta` is repointed in
  // place on switch so the NEXT persist writes under the fork id.
  installSessionSwitchWire({
    registerSessionSwitch,
    replaceTranscript,
    idMeta,
    commitSwitch: ({ sessionId, history: switchHistory }) => {
      state.surfaceState = updateSessionState(state.surfaceState, {
        sessionId,
        history: switchHistory,
      })
    },
  })

  // Audit R1 C-F1: attachPlaybookHandle() allocates a filesystem watcher that
  // can throw in the same init gap — guardInit drains on throw so the facade +
  // session don't leak.
  await guardInit(() =>
    attachPlaybookHandle({
      playbookSeam,
      playbookCliFlag,
      threadId: setup.sessionId,
      externalPromptQueue,
    }),
  )
  // L5 H-7 — register the playbook detach the moment the watcher is (possibly)
  // attached. `detach()` is idempotent + a no-op when nothing attached.
  if (playbookSeam !== undefined) {
    closeStack.push({ label: "playbookSeam.detach", dispose: () => playbookSeam.detach() })
  }

  // ADR-0303 — the thin `runSessionTurn` adapter over `driveSessionTurn`.
  const runSessionTurn = makeRunSessionTurn({
    session,
    resolveApproval: setup.approvalPrompt,
    modeCycle: ux?.modeCycle,
    runtimeContext,
    getSurfaceState: () => state.surfaceState,
    setSurfaceState: (next) => {
      state.surfaceState = next
    },
  })

  return {
    closeStack,
    drainCloseStack,
    externalPromptQueue,
    withInTurnCapture,
    runSessionTurn,
    liveAutomationSlot,
    enqueueWithHeartbeat,
    activeIdentityModeState,
  }
}
