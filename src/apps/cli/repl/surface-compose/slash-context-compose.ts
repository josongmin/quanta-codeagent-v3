import { EFFORT_LEVELS, effortToTokenBudget } from "@/agent"
import { overlayRewindState } from "../session-switch-wire"
import type { SessionSetupResult } from "../session-setup"
import { buildSkillsCallback } from "../skills-surface"
import { buildReplSlashCtx } from "../slash-surface"
import type { SurfaceCoreState } from "./core-state"
import type { MutableSurfaceWires } from "./mutable-wires"
import type { SurfaceState } from "./turn-sinks"
import { buildReplaySlashState } from "./wire-builders"

type SlashCtxInput = Parameters<typeof buildReplSlashCtx>[0]

const sharedOptionalSlots = (
  setup: SessionSetupResult,
  state: SurfaceState,
  core: SurfaceCoreState,
  mutable: MutableSurfaceWires,
): Partial<SlashCtxInput> => ({
  ...(mutable.projectsKbSlot === undefined ? {} : { projectsKb: mutable.projectsKbSlot }),
  ...(mutable.mcpResourcesSlot === undefined ? {} : { mcpResources: mutable.mcpResourcesSlot }),
  ...(core.browserNetHolder === undefined
    ? {}
    : { browserNet: () => core.browserNetHolder?.get() }),
  ...(mutable.itemStreamSink === undefined ? {} : { itemStreamSink: mutable.itemStreamSink }),
  ...(mutable.itemStore === undefined
    ? {}
    : { activityItems: () => mutable.itemStore?.snapshot() ?? [] }),
  ...(core.radarStore === undefined ? {} : { radar: core.radarStore }),
  ...(core.perToolCkpt === undefined
    ? {}
    : {
        perToolRegistry: core.perToolCkpt.registry,
        perToolRestorePort: core.perToolCkpt.restore,
        perToolReplaceMessages: mutable.liveHistorySwap,
      }),
  rewindState:
    state.rewindState === undefined || mutable.sessionSwitchWire === undefined
      ? undefined
      : overlayRewindState(
          state.rewindState,
          mutable.liveHistorySwap,
          mutable.sessionSwitchWire,
        ),
})

const runtimeOptionalSlots = (
  setup: SessionSetupResult,
  core: SurfaceCoreState,
): Partial<SlashCtxInput> => {
  const toolProfileState = setup.runtimeContext.toolProfileState()
  const identityModeState = setup.runtimeContext.identityModeState()
  const focusChain = setup.runtimeContext.focusChain()
  const stickyModelStore = setup.runtimeContext.stickyModelStore()
  return {
    ...(toolProfileState === undefined ? {} : { toolProfileState }),
    ...(identityModeState === undefined
      ? {}
      : { identityModeState, onIdentityModeChange: setup.refreshSystemPrompt }),
    ...(focusChain === undefined ? {} : { focusChain }),
    ...(stickyModelStore === undefined
      ? {}
      : {
          stickyModelStore: stickyModelStore.store,
          stickyModelCandidateIds: [
            ...new Set([
              setup.model,
              ...core.retryCandidates.map((candidate) => candidate.id),
            ]),
          ],
        }),
  }
}

export const buildSurfaceSlashContext = (
  setup: SessionSetupResult,
  state: SurfaceState,
  convStore: Parameters<typeof buildReplSlashCtx>[0]["conversationStore"],
  core: SurfaceCoreState,
  mutable: MutableSurfaceWires,
): ReturnType<typeof buildReplSlashCtx> =>
  buildReplSlashCtx({
    skillsCb: buildSkillsCallback(setup.skillsConfig, setup.pills),
    idleMonitor: setup.idleMonitor,
    ...sharedOptionalSlots(setup, state, core, mutable),
    imageQueue: state.imageQueue,
    mcpSurface: setup.mcpSurface,
    costPanel: setup.costPanel,
    planStore: setup.planStore,
    branchProgress: setup.branchProgress,
    taskRegistry: setup.lifecycleTaskRegistry,
    activityStore: setup.lifecycleActivityStore,
    getHistory: () => state.history,
    startSideConversation: mutable.startSideConversation,
    isSideConversationWired: mutable.isSideConversationWired,
    abortSignal: setup.abort.signal,
    debugHandle: setup.debugHandle,
    llm: setup.llm,
    sessionId: setup.sessionId,
    model: setup.model,
    inspect:
      typeof setup.sessionId === "string" && setup.sessionId.length > 0
        ? { sessionId: setup.sessionId }
        : undefined,
    replay: buildReplaySlashState(),
    effort: {
      get: () => setup.effortStore.get(),
      set: (level) => {
        setup.effortStore.set(level)
        setup.pills.update({ effort: level })
      },
      levels: EFFORT_LEVELS,
      budgetTokens: effortToTokenBudget,
    },
    brief: {
      get: () => setup.briefStore.get(),
      set: (on) => setup.briefStore.set(on),
    },
    composerHandle: mutable.composerHandle,
    conversationStore: convStore,
    ...runtimeOptionalSlots(setup, core),
    textInbox: mutable.textInbox,
    contextUsage: () => core.contextUsageHolder.view(),
  })
