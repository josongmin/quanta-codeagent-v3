import type { DreamSlashState } from "../../dream-cmd"
import type { MemorySlashState } from "../../memory-cmd"
import type { PermissionInspectSlashState } from "../../permission-explain"
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

export const buildSurfaceDispatchWire = (
  setup: SessionSetupResult,
  state: SurfaceState,
  env: NodeJS.ProcessEnv,
  slashCtx: Parameters<typeof buildSurfaceDispatch>[0]["slashCtx"],
  core: SurfaceCoreState,
  mutable: MutableSurfaceWires,
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
  const retry = () => {
    const streamInput = core.lastStreamInput()
    if (!core.retryEnabled || streamInput === undefined) return undefined
    return {
      candidates: core.retryCandidates,
      currentModelId: setup.model,
      messages: [...state.history],
      streamInput,
      signal: setup.abort.signal,
      onEvent: renderRetryEvent,
    }
  }

  const dispatchSlash = buildSurfaceDispatch({
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
  })
  return { dispatchSlash, convCheckpointSlot }
}
