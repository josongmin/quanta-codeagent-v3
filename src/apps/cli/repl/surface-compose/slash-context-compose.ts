import { EFFORT_LEVELS, effortToTokenBudget } from "@/agent"
import { gateOn } from "@/shared"
import { createNodeSkillActionPorts } from "@/skill"
import type { RestoreFilesCoordinatorPort } from "../../rewind-cmd"
import { buildAttentionSlashState } from "../../slash/attention-cmd"
import { buildSkillActionsState, isSkillActionsEnabled } from "../../slash/skill"
import { buildRewindRestoreCoordinator } from "../rewind-restore-coordinator-wire"
import type { SessionSetupResult } from "../session-setup"
import { overlayRewindState } from "../session-switch-wire"
import { buildSkillsCallback, buildSkillsReloadCallback } from "../skills-surface"
import { buildReplSlashCtx } from "../slash-surface"
import type { SurfaceCoreState } from "./core-state"
import type { MutableSurfaceWires } from "./mutable-wires"
import type { SurfaceState } from "./turn-sinks"
import { buildReplaySlashState } from "./wire-builders"

/** Build the RFC-def Surface B restore coordinator when `QUANTA_REWIND_GIT=1`
 *  (the existing extra-destructive gate for `--restore-files`). Reuses the
 *  ShadowOdb-backed restore triple from the per-tool-checkpoint wire when
 *  present; otherwise the coordinator fail-closes at the missing-checkpoint
 *  mapping (no tree mutation). Absent gate ⇒ `undefined` ⇒ `--restore-files`
 *  keeps its safe-degrade byte-identical. */
const maybeRestoreCoordinator = (
  core: SurfaceCoreState,
  env: NodeJS.ProcessEnv,
): RestoreFilesCoordinatorPort | undefined => {
  if (!gateOn(env, "QUANTA_REWIND_GIT")) return undefined
  return buildRewindRestoreCoordinator({
    ...(core.perToolCkpt !== undefined
      ? { perTool: { registry: core.perToolCkpt.registry, restore: core.perToolCkpt.restore } }
      : {}),
  })
}

type SlashCtxInput = Parameters<typeof buildReplSlashCtx>[0]

const sharedOptionalSlots = (
  core: SurfaceCoreState,
  mutable: MutableSurfaceWires,
): Partial<SlashCtxInput> => {
  const browserNetHolder = core.browserNetHolder
  const itemStore = mutable.itemStore
  return {
    ...(mutable.projectsKbSlot === undefined ? {} : { projectsKb: mutable.projectsKbSlot }),
    ...(mutable.mcpResourcesSlot === undefined ? {} : { mcpResources: mutable.mcpResourcesSlot }),
    ...(browserNetHolder === undefined ? {} : { browserNet: () => browserNetHolder.get() }),
    ...(mutable.itemStreamSink === undefined ? {} : { itemStreamSink: mutable.itemStreamSink }),
    ...(itemStore === undefined ? {} : { activityItems: () => itemStore.snapshot() }),
    ...(core.radarStore === undefined ? {} : { radar: core.radarStore }),
    ...(core.perToolCkpt === undefined
      ? {}
      : {
          perToolRegistry: core.perToolCkpt.registry,
          perToolRestorePort: core.perToolCkpt.restore,
          perToolReplaceMessages: mutable.liveHistorySwap,
        }),
  }
}

const runtimeOptionalSlots = (
  setup: SessionSetupResult,
  core: SurfaceCoreState,
): Partial<SlashCtxInput> => {
  const toolProfileState = setup.runtimeContext.toolProfileState()
  const identityModeState = setup.runtimeContext.identityModeState()
  const focusChain = setup.runtimeContext.focusChain()
  // aug-27 — prefer the SURFACE-owned sticky store (`core-state`); fall back to
  // the runtime-context slot for any composition that supplies one there. The
  // CLI overlay never did, which is why `/sticky-model` (and `/model`) printed
  // "not wired in this surface" on the primary surface.
  const stickyModelStore = core.stickyModel ?? setup.runtimeContext.stickyModelStore()
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
          // aug-28 — a GETTER (was a compose-time snapshot, which froze
          // `/sticky-model` out of every probe-discovered model).
          stickyModelCandidateIds: () => core.modelCatalog.ids(),
          // The provider half of the key — same authority as `/model`'s adapter
          // and the `stickyModelStore` slot, so all three write what the loop reads.
          stickyModelProvider: setup.provider,
        }),
  }
}

export const buildSurfaceSlashContext = (
  setup: SessionSetupResult,
  state: SurfaceState,
  convStore: Parameters<typeof buildReplSlashCtx>[0]["conversationStore"],
  core: SurfaceCoreState,
  mutable: MutableSurfaceWires,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof buildReplSlashCtx> =>
  buildReplSlashCtx({
    // RFC-06 F4 — thread the SHARED session skill authority so `/skills` and
    // `/reload-skills` project its live view (management inventory + sync +
    // revision), in lock-step with the prompt/ToolSearch/invocation. Absent ⇒
    // pre-F4 disk re-scan (byte-identical).
    skillsCb: buildSkillsCallback(setup.skillsConfig, setup.pills, setup.skillAuthority),
    reloadSkillsCb: buildSkillsReloadCallback(
      setup.skillsConfig,
      setup.pills,
      setup.skillAuthority,
    ),
    idleMonitor: setup.idleMonitor,
    // F1a — hand `/rules` the SAME snapshot the per-turn AgentConfig carries,
    // so the surface and the wire can never report different rules.
    repoRules: setup.repoRules,
    ...sharedOptionalSlots(core, mutable),
    imageQueue: state.imageQueue,
    rewindState:
      state.rewindState === undefined || mutable.sessionSwitchWire === undefined
        ? undefined
        : overlayRewindState(
            state.rewindState,
            mutable.liveHistorySwap,
            mutable.sessionSwitchWire,
            maybeRestoreCoordinator(core, env),
          ),
    mcpSurface: setup.mcpSurface,
    costPanel: setup.costPanel,
    planStore: setup.planStore,
    branchProgress: setup.branchProgress,
    taskRegistry: setup.lifecycleTaskRegistry,
    // RFC-01 A4 — `/attention` wire, built from A2's `AttentionReader` + the
    // `UserQuestionBroker` (both present only under `QUANTA_ATTENTION_NAV`). The
    // SAME broker instance the loop's `config.questionBroker` producer writes to,
    // so `/attention answer` resolves the exact waiting request. Absent either ⇒
    // slot omitted ⇒ `/attention` prints "not wired" (byte-identical).
    ...(setup.lifecycleAttention !== undefined && setup.lifecycleQuestionBroker !== undefined
      ? {
          attention: buildAttentionSlashState(
            setup.lifecycleAttention,
            setup.lifecycleQuestionBroker,
          ),
        }
      : {}),
    // RFC-06 F5 — `/skill` copy/reveal/enable/disable wire over the SAME shared
    // F1 authority (the one `boot.tooling.skillsConfig.authority` also holds) +
    // the node action ports (action-time re-scan, bounded read, path-jail, OS
    // reveal). Present iff `QUANTA_SKILL_ACTIONS` is on AND the session built the
    // authority; absent ⇒ slot omitted ⇒ `/skill` prints "not wired"
    // (byte-identical when OFF).
    ...(isSkillActionsEnabled() && setup.skillAuthority !== undefined
      ? {
          skillActions: buildSkillActionsState(
            setup.skillAuthority,
            createNodeSkillActionPorts({
              // RFC-06 D1 / R1-BREAK — the CLI reveal is the SURFACE-keyed
              // path-printed degrade (success receipt prints the abs path); it
              // NEVER spawns `open`/`explorer`/`xdg-open` inferred from
              // `process.platform` (which would hang on a headless SSH/bench box).
              surfaceKind: "cli",
              snapshotInputs:
                setup.skillsConfig?.dir !== undefined ? { userDir: setup.skillsConfig.dir } : {},
            }),
          ),
        }
      : {}),
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
    // RFC-def `/undo` — thread the SAME durable journal store the HITL prompt
    // persists applies into (built ONLY under QUANTA_HUNK_UNDO=1). Absent ⇒ slot
    // omitted, `/undo` prints "not wired" (byte-identical).
    ...(setup.hunkUndoStore !== undefined ? { hunkUndoStore: setup.hunkUndoStore } : {}),
    ...runtimeOptionalSlots(setup, core),
    textInbox: mutable.textInbox,
    contextUsage: () => core.contextUsageHolder.view(),
  })
