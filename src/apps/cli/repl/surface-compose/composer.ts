import {
  type ConversationCheckpointStore,
  defaultConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import type { SessionSetupResult } from "../session-setup"
import type { buildReplSlashCtx } from "../slash-surface"
import { buildSurfaceCoreState } from "./core-state"
import { buildSurfaceDispatchWire } from "./dispatch-compose"
import { buildMutableSurfaceWires } from "./mutable-wires"
import { buildRuntimeFacadeCompose } from "./runtime-compose"
import { buildSurfaceSlashContext } from "./slash-context-compose"
import type { SurfaceState } from "./turn-sinks"
import type { ReplSurfaceWires } from "./types"

/** Compose one session-scoped REPL surface from five cohesive owner stages. */
export const composeSurfaceWires = (
  setup: SessionSetupResult,
  state: SurfaceState,
  env: NodeJS.ProcessEnv,
  opts?: { readonly convStore?: ConversationCheckpointStore },
): ReplSurfaceWires => {
  const convStore = opts?.convStore ?? defaultConversationCheckpointStore()
  const core = buildSurfaceCoreState(setup, env, convStore)
  const runtimeFacadeCompose = buildRuntimeFacadeCompose(setup, env, core)
  const mutable = buildMutableSurfaceWires(setup, state, env, convStore, core)
  const slashCtx = buildSurfaceSlashContext(setup, state, convStore, core, mutable, env)
  const dispatch = buildSurfaceDispatchWire(setup, state, env, slashCtx, core, mutable)

  return {
    slashCtx,
    convCheckpointSlot: dispatch.convCheckpointSlot,
    sessionIo: mutable.sessionIo,
    dispatchSlash: dispatch.dispatchSlash,
    convCheckpointWire: mutable.convCheckpointWire,
    convStore,
    playbookSeam: mutable.playbookSeam,
    composerHandle: mutable.composerHandle,
    textInbox: mutable.textInbox,
    runtimeFacadeCompose,
    setReplaceMessages: mutable.setReplaceMessages,
    ...(mutable.sessionSwitchWire === undefined
      ? {}
      : { setSwitchSession: mutable.sessionSwitchWire.setSwitchSession }),
    setSideConversationStart: mutable.setSideConversationStart,
    planQueueStore: mutable.planQueueStore,
    objectiveStore: core.objectiveStore,
    setPlanQueueSendNow: mutable.setPlanQueueSendNow,
    setAutomationSlash: mutable.setAutomationSlash,
    ...(core.conversationActions === undefined
      ? {}
      : { conversationActions: core.conversationActions }),
    inboundMode: core.inboundMode,
    ...(core.modeCycleStore === undefined ? {} : { modeCycleStore: core.modeCycleStore }),
    promptAssembledSink: core.contextUsageHolder.sink,
    contextUsageView: () => core.contextUsageHolder.view(),
    ...(core.backgroundPortal === undefined ? {} : { backgroundPortal: core.backgroundPortal }),
    ...(core.perToolCkpt === undefined ? {} : { disposePerToolRecord: core.perToolCkpt.dispose }),
  }
}

/** Legacy ctx-only facade retained for existing imports. */
export const composeSurfaceSlashCtx = (
  setup: SessionSetupResult,
  state: SurfaceState,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof buildReplSlashCtx> => composeSurfaceWires(setup, state, env).slashCtx
