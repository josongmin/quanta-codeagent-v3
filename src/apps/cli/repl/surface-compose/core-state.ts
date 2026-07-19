import type { SkillScopeView, WorkingState } from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { type InboundMode, parseInboundMode } from "@/agent/inbound-mode"
import { createInterruptedTurnBuffer } from "@/agent/interrupted-turn"
import { createObjectiveStore } from "@/agent/objective"
import { createShadowVerify } from "@/agent/shadow-verify"
import { createShadowVerifyAdapters } from "@/agent/shadow-verify-adapters"
import { createStickyPresetResolver, type StreamInput } from "@/llm"
import type { RadarStore } from "@/radar"
import { isApprovedDecision } from "@/runner/orchestrate"
import type { RuntimeFacadeComposeOptions } from "@/sdk/runtime"
import { gateOn } from "@/shared"
import { defaultShadowOdb, type ShadowOdb } from "@/storage"
import {
  createModeCycleStore,
  MODE_CYCLE,
  type ModeCycleStore,
  modeCycleEnabled,
} from "../../mode-cycle"
import { createBrowserNetHolder } from "../../slash/browser-net-cmd"
import type { SlashContext } from "../../slash-commands"
import { BG_TURN_ENV_GATE, createBackgroundTurnPortal } from "../background-turn-portal"
import { createConversationActionSurface } from "../conversation-action-surface"
import { buildPerToolCheckpointWire } from "../per-tool-checkpoint-wire"
import type { SessionSetupResult } from "../session-setup"
import { isEnvTruthy } from "./kb-slot"
import { buildRadarStore, buildRetryCandidates } from "./wire-builders"

const buildModeWire = (
  setup: SessionSetupResult,
  env: NodeJS.ProcessEnv,
): { readonly store?: ModeCycleStore; readonly slot?: SlashContext["mode"] } => {
  if (!modeCycleEnabled(env)) return {}
  const store = createModeCycleStore()
  const slot: NonNullable<SlashContext["mode"]> = {
    get: () => store.current().key,
    set: (key: string) => {
      const known = MODE_CYCLE.map((posture) => posture.key)
      if (!known.includes(key as (typeof known)[number])) return { kind: "unknown" as const, known }
      store.set(key as (typeof known)[number])
      setup.pills.update({ mode: store.current().agentMode })
      return "ok" as const
    },
    list: () => MODE_CYCLE.map((posture) => posture.key),
  }
  return { store, slot }
}

const buildPreCompactHook = (
  setup: SessionSetupResult,
  env: NodeJS.ProcessEnv,
): NonNullable<RuntimeFacadeComposeOptions["onPreCompact"]> | undefined => {
  if (!isEnvTruthy(env.QUANTA_PRECOMPACT_CONFIRM)) return undefined
  return async (query) => {
    const approxK = Math.round(query.proposedSummaryTokens / 1000)
    const decision = await setup.approvalPrompt({
      approvalId: `precompact-${query.turnId}`,
      reason: `Compact ~${approxK}k tokens of history into a summary? (context ${Math.round(query.currentTokens / 1000)}k/threshold ${Math.round(query.threshold / 1000)}k)`,
      requestedAt: new Date().toISOString(),
    })
    return isApprovedDecision(decision) ? "approve" : "defer_one_turn"
  }
}

export const buildSurfaceCoreState = (
  setup: SessionSetupResult,
  env: NodeJS.ProcessEnv,
  convStore: ConversationCheckpointStore,
) => {
  const mode = buildModeWire(setup, env)
  let workingStateGet: (() => WorkingState | undefined) | undefined
  let skillScopeGet: (() => SkillScopeView | undefined) | undefined
  let lastStreamInput: StreamInput | undefined
  const retryCandidates = buildRetryCandidates(env, setup.provider, setup.model)
  const shadowOdb: ShadowOdb | undefined = isEnvTruthy(env.QUANTA_SHADOW)
    ? defaultShadowOdb()
    : undefined
  const perToolCkpt =
    gateOn(env, "QUANTA_PER_TOOL_RECORD") && shadowOdb !== undefined
      ? buildPerToolCheckpointWire({
          shadowOdb,
          conversationStore: convStore,
          workspace: process.cwd(),
        })
      : undefined
  const shadowVerify = isEnvTruthy(env.QUANTA_SHADOW_VERIFY)
    ? createShadowVerify(createShadowVerifyAdapters(process.cwd()))
    : undefined
  const conversationActions = isEnvTruthy(env.QUANTA_CONVERSATION_ACTIONS)
    ? createConversationActionSurface()
    : undefined
  const interruptedTurnBuffer =
    conversationActions === undefined ? undefined : createInterruptedTurnBuffer()
  const inboundMode: { current: InboundMode } = {
    current: parseInboundMode(env.QUANTA_INBOUND_MODE) ?? "queue",
  }
  const backgroundPortal = gateOn(env, BG_TURN_ENV_GATE) ? createBackgroundTurnPortal() : undefined
  const radarStore: RadarStore | undefined = buildRadarStore(env)
  const browserNetHolder = gateOn(env, "QUANTA_BROWSER_NETWORK")
    ? createBrowserNetHolder()
    : undefined

  return {
    modeCycleStore: mode.store,
    modeSlot: mode.slot,
    contextUsageHolder: setup.contextUsageHolder,
    workingStateEnabled: isEnvTruthy(env.QUANTA_WORKING_STATE),
    setWorkingStateGet: (get: () => WorkingState | undefined) => {
      workingStateGet = get
    },
    workingStateView: () => workingStateGet?.(),
    skillScopeEnabled: gateOn(env, "QUANTA_SKILL_SCOPE_V2"),
    setSkillScopeGet: (get: () => SkillScopeView | undefined) => {
      skillScopeGet = get
    },
    skillScopeView: () => skillScopeGet?.(),
    retryCandidates,
    retryEnabled: retryCandidates.length > 0,
    setLastStreamInput: (input: StreamInput) => {
      lastStreamInput = input
    },
    lastStreamInput: () => lastStreamInput,
    shadowOdb,
    perToolCkpt,
    shadowVerify,
    onPreCompact: buildPreCompactHook(setup, env),
    conversationActions,
    interruptedTurnBuffer,
    inboundMode,
    backgroundPortal,
    radarStore,
    browserNetHolder,
    objectiveStore: createObjectiveStore(),
    presetResolver: createStickyPresetResolver(),
  }
}

export type SurfaceCoreState = ReturnType<typeof buildSurfaceCoreState>
