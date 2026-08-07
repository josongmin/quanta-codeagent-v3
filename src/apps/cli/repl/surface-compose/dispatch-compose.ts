import type { Message, ModelCandidate, StreamEvent, StreamInput } from "@/llm"
import type { AgentEvent } from "@/stream"
import type { DreamSlashState } from "../../dream-cmd"
import type { MemorySlashState } from "../../memory-cmd"
import type { PermissionInspectSlashState } from "../../permission-explain"
import type { RetryWithSessionState } from "../../retry-with"
import type { ConvCheckpointSlashState } from "../../rewind-conv-cmd"
import type { SessionSetupResult } from "../session-setup"
import type { SurfaceCoreState } from "./core-state"
import { buildSurfaceDispatch, buildVoiceLiveSlot } from "./dispatch"
import type { MutableSurfaceWires } from "./mutable-wires"
import type { SurfaceState } from "./turn-sinks"
import { renderRetryEvent } from "./wire-builders"

const permissionInspectSlot = (
  setup: SessionSetupResult,
): PermissionInspectSlashState | undefined => {
  if (setup.permissionStore === undefined) return undefined
  return {
    store: setup.permissionStore,
    ...(typeof setup.sessionId === "string" && setup.sessionId.length > 0
      ? { threadId: setup.sessionId }
      : {}),
  }
}

const memorySlot = (setup: SessionSetupResult): MemorySlashState | undefined => {
  if (setup.memoryStore === undefined) return undefined
  return {
    store: setup.memoryStore,
    ...(setup.memoryEmbedder === undefined ? {} : { embedder: setup.memoryEmbedder }),
  }
}

const dreamSlot = (setup: SessionSetupResult): DreamSlashState | undefined => {
  const trigger = setup.runtimeContext.dreamTrigger()
  return trigger === undefined ? undefined : { trigger }
}

/** RFC02-3 (A8, feeder) — build the live `/retry-with` session state, attaching
 *  the gated route-event sink to `onModelReroute` when (and only when) the host
 *  forwarded one. Returns `undefined` when retry is disabled OR no turn has
 *  streamed yet (⇒ the `/retry-with` slot is omitted). Extracted as a pure
 *  helper so the sink-attach wire is FRONT-DOOR testable without assembling the
 *  full surface. Sink ABSENT (gate off) ⇒ `onModelReroute` omitted ⇒ the swap
 *  is byte-identical to today (no route observation). */
export const buildRetryState = (input: {
  readonly streamInput: StreamInput | undefined
  readonly retryEnabled: boolean
  readonly candidates: readonly ModelCandidate[]
  readonly currentModelId: string
  readonly messages: Message[]
  readonly signal: AbortSignal
  readonly onEvent: (ev: StreamEvent) => void
  readonly routeEventSink?: ((ev: AgentEvent) => void) | undefined
}): RetryWithSessionState | undefined => {
  if (!input.retryEnabled || input.streamInput === undefined) return undefined
  return {
    candidates: input.candidates,
    currentModelId: input.currentModelId,
    messages: input.messages,
    streamInput: input.streamInput,
    signal: input.signal,
    onEvent: input.onEvent,
    ...(input.routeEventSink !== undefined ? { onModelReroute: input.routeEventSink } : {}),
  }
}

export const buildSurfaceDispatchWire = (
  setup: SessionSetupResult,
  state: SurfaceState,
  env: NodeJS.ProcessEnv,
  slashCtx: Parameters<typeof buildSurfaceDispatch>[0]["slashCtx"],
  core: SurfaceCoreState,
  mutable: MutableSurfaceWires,
  opts?: { readonly skillReview?: Parameters<typeof buildSurfaceDispatch>[0]["skillReview"] },
) => {
  const convCheckpointSlot: ConvCheckpointSlashState | undefined =
    mutable.convCheckpointWire === null
      ? undefined
      : {
          wire: mutable.convCheckpointWire,
          replaceMessages: mutable.liveHistorySwap,
        }
  const voiceLive = buildVoiceLiveSlot(env)
  const permissionInspect = permissionInspectSlot(setup)
  const memory = memorySlot(setup)
  const dream = dreamSlot(setup)
  const retry = () =>
    buildRetryState({
      streamInput: core.lastStreamInput(),
      retryEnabled: core.retryEnabled,
      candidates: core.retryCandidates,
      currentModelId: setup.model,
      messages: [...state.history],
      signal: setup.abort.signal,
      onEvent: renderRetryEvent,
      // RFC02-3 (A8, feeder) — attach the gated forwarder sink so an operator
      // `/retry-with` model swap projects `model_route_changed` onto the SAME
      // live stream the provider-fallback path uses. Absent (gate off) ⇒ omitted.
      ...(setup.routeEventSink !== undefined ? { routeEventSink: setup.routeEventSink } : {}),
    })

  const dispatchSlash = buildSurfaceDispatch({
    sessionCwd: setup.cwd,
    slashCtx,
    convCheckpointSlot,
    sessionIo: mutable.sessionIo,
    ...(typeof setup.sessionId === "string" && setup.sessionId.length > 0
      ? { goal: { port: core.objectiveStore, threadId: setup.sessionId } }
      : {}),
    presets: core.presetResolver,
    contextUsage: () => core.contextUsageHolder.view(),
    ...(voiceLive === undefined ? {} : { voiceLive }),
    ...(memory === undefined ? {} : { memory }),
    ...(dream === undefined ? {} : { dream }),
    ...(core.backgroundPortal === undefined ? {} : { background: core.backgroundPortal.view() }),
    planQueue: mutable.planQueueStore,
    workingState: core.workingStateView,
    skillScope: core.skillScopeView,
    retry,
    ...(core.shadowOdb === undefined ? {} : { shadowOdb: core.shadowOdb }),
    ...(core.conversationActions === undefined
      ? {}
      : { conversationActions: core.conversationActions }),
    inboundMode: core.inboundMode,
    ...(core.modeSlot === undefined ? {} : { mode: core.modeSlot }),
    ...mutable.modelWire,
    automation: mutable.automationSlash,
    ...(permissionInspect === undefined ? {} : { permissionInspect }),
    ...(opts?.skillReview === undefined ? {} : { skillReview: opts.skillReview }),
  })
  return { dispatchSlash, convCheckpointSlot }
}
