import type { AgentConfig, AgentMode } from "@/agent"
import type { Message } from "@/llm"
import { createCronSlashAdapter } from "@/scheduler"
import { assembleAutomation } from "@/scheduler/runtime-wire"
import type { RuntimeFacadeComposeOptions } from "@/sdk/runtime/context"
import { errMessage, runtimeConfig } from "@/shared"
import type { AgentEvent } from "@/stream"
import { ExternalPromptQueue } from "../external-prompt-queue"
import { createHeartbeatBinder, heartbeatEnqueueHandler } from "../heartbeat-binder"
import { type MidTurnCaptureHandle, maybeCreateMidTurnCaptureWire } from "../mid-turn-capture-wire"
import { type SessionState, updateSessionState } from "../session-state"
import { stripAutomationTickerHandler } from "./automation"
import type { CloseStackController } from "./close-stack"
import { createCloseStackController } from "./close-stack"
import type { RunSessionLoopDeps } from "./deps"
import { makeRunSessionTurn, type RunSessionTurn } from "./turn-driver"
import {
  makeInTurnCaptureWrapper,
  registerNotifyDispose,
  registerSearchPipelineDispose,
} from "./turn-helpers"
import {
  attachPlaybookHandle,
  installHistoryReplaceWire,
  installSessionSwitchWire,
} from "./wiring-installs"

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
/** Phase 1 — prompt-source plumbing: the external queue (seeded BEFORE the loop
 *  so it wins the prompt-source race), the heartbeat-bound enqueue, and the
 *  mid-turn capture wrapper. Extracted from `bootstrapSessionLoop` to keep it
 *  under the god-fn ceiling; pure wiring, construction order preserved. */
const buildPromptPlumbing = (deps: RunSessionLoopDeps, state: LoopStateHolder) => {
  const { setup } = deps
  const { runtimeContext } = setup

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
  return { externalPromptQueue, enqueueWithHeartbeat, withInTurnCapture }
}

/** RFC02-3 (A8, feeder) — the deps handed to `assembleAutomation` when the REPL
 *  mints its OWN engine. `onModelReroute` is attached ONLY when the host
 *  forwarded a gated route-event sink (`setup.routeEventSink`), so a scheduler
 *  fire whose preferred model is DOWN projects `model_route_changed` onto the
 *  SAME live stream the provider-fallback path uses. Sink ABSENT (gate off) ⇒
 *  the slot is omitted ⇒ the reroute is byte-identical to today (no observation).
 *  Extracted so the sink-attach wire is FRONT-DOOR testable. */
export const buildAutomationRerouteDeps = (input: {
  readonly enqueueUserMessage: ReturnType<typeof heartbeatEnqueueHandler>
  readonly routeEventSink?: ((ev: AgentEvent) => void) | undefined
}): Parameters<typeof assembleAutomation>[1] => ({
  agentLoop: { enqueueUserMessage: input.enqueueUserMessage },
  ...(input.routeEventSink !== undefined ? { onModelReroute: input.routeEventSink } : {}),
})

/** §17 packet M — fold the LIVE agent-mode reader into the runtime compose.
 *
 *  A reader, not a snapshot. The `shift+tab` PLAN rung is described as "research
 *  and propose, never touch files"; before this its `agentMode` reached a status
 *  pill and nothing else, so the chrome promised a guarantee the runtime did not
 *  enforce. Reading the store PER TURN makes a mid-session flip real at the
 *  prompt, the visible tool surface AND the dispatch gate.
 *
 *  No cycle wired ⇒ the compose is passed through untouched (or omitted), so the
 *  launch-time `--plan` path is byte-identical. */
const withLiveAgentMode = (
  compose: RuntimeFacadeComposeOptions | undefined,
  modeCycle: { current(): { agentMode: AgentMode } } | undefined,
): { compose?: RuntimeFacadeComposeOptions } => {
  if (modeCycle === undefined) return compose === undefined ? {} : { compose }
  return {
    compose: {
      ...(compose ?? {}),
      agentModeState: { get: () => modeCycle.current().agentMode },
    },
  }
}

/** Phase 2 — automation engine + runtime compose. Mints the `/cron` engine
 *  (LATE-BINDING the slash slot the instant it exists), strips the bootstrap
 *  ticker so the REPL stays the SINGLE interval owner (ALBB-14), and folds the
 *  engine into the runtime-facade compose payload. Also reads the identity /
 *  tool-profile cells the facade + session seed from. */
const buildAutomationCompose = (
  deps: RunSessionLoopDeps,
  enqueueWithHeartbeat: ReturnType<typeof heartbeatEnqueueHandler>,
) => {
  const { setup } = deps
  const { runtimeContext } = setup

  const liveAutomationSlot =
    runtimeContext.automationEngine() ??
    assembleAutomation(
      { get: (name) => process.env[name] },
      buildAutomationRerouteDeps({
        enqueueUserMessage: enqueueWithHeartbeat,
        ...(setup.routeEventSink !== undefined ? { routeEventSink: setup.routeEventSink } : {}),
      }),
    ) ??
    undefined
  // B2 (jul-04 CLI-surfacing) `/cron` — LATE-BIND the automation slash slot the
  // instant the engine exists (minted HERE, after compose time). Absent engine ⇒
  // never called ⇒ `/cron` stays "not wired" (default-OFF byte-identical).
  if (liveAutomationSlot !== undefined && deps.registerAutomationSlash !== undefined) {
    deps.registerAutomationSlash(createCronSlashAdapter({ engine: liveAutomationSlot.engine }))
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
          ...(deps.runtimeFacadeCompose ?? {}),
          automationEngine: composeAutomationEngine,
        }
      : deps.runtimeFacadeCompose
  return { liveAutomationSlot, runtimeCompose, activeIdentityModeState, activeToolProfileState }
}

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
    playbookSeam,
    playbookCliFlag,
    searchPipelineDispose,
    notify,
  } = deps
  const { abort, runtimeContext, state: featureState, idMeta } = setup

  const { externalPromptQueue, enqueueWithHeartbeat, withInTurnCapture } = buildPromptPlumbing(
    deps,
    state,
  )
  const { liveAutomationSlot, runtimeCompose, activeIdentityModeState, activeToolProfileState } =
    buildAutomationCompose(deps, enqueueWithHeartbeat)

  // L5 H-7 — single close stack + drain + init guard.
  const { closeStack, drainCloseStack, guardInit } = createCloseStackController()

  const modeCycleRef = ux?.modeCycle
  const runtimeFacade = await runtimeContext.createRuntimeFacade({
    boot: {
      mode: setup.mode,
      refreshSystemPrompt: setup.refreshSystemPrompt,
      toolProfileState: activeToolProfileState,
      identityModeState: activeIdentityModeState,
      // §17 packet M — a LIVE reader, not a snapshot. The `shift+tab` PLAN rung
      // is described as "research and propose, never touch files"; before this
      // its `agentMode` reached a status pill and nothing else, so the chrome
      // promised a guarantee the runtime did not enforce. Reading the store per
      // turn makes a mid-session flip real at the prompt, the visible tool
      // surface AND the dispatch gate. Absent cycle ⇒ slot omitted ⇒ the
      // launch-time `--plan` path is byte-identical.
    },
    history: [...state.surfaceState.history],
    state: featureState,
    idMeta,
    shutdown: async () => undefined,
    mcpClients: setup.mcpClients as Array<{ stop: () => Promise<void> }>,
    ...withLiveAgentMode(runtimeCompose, modeCycleRef),
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
