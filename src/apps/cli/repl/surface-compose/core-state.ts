import type { SkillScopeView, WorkingState } from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { type InboundMode, parseInboundMode } from "@/agent/inbound-mode"
import { createInterruptedTurnBuffer } from "@/agent/interrupted-turn"
import { createModelRoutingSession, type ModelRoutingSession } from "@/agent/model-routing"
import { createShadowVerify } from "@/agent/shadow-verify"
import { createShadowVerifyAdapters } from "@/agent/shadow-verify-adapters"
import type { StickyModelStore } from "@/agent/sticky-model"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import {
  createObjectiveCheckRunner,
  createObjectiveVerificationCoordinator,
  createWorkspaceEvidence,
} from "@/host/runtime/objective-verifier-wire"
import {
  createStickyPresetResolver,
  type ModelCandidate,
  type StreamInput,
  tryCreateLLM,
} from "@/llm"
import type { ModelCatalogWire } from "@/llm/model-catalog"
import { createObjectiveAttemptSlot, createObjectiveCapabilities } from "@/objective"
import type { RadarStore } from "@/radar"
import { decorateSwappableModelPort } from "@/runner/assemble"
import { isApprovedDecision } from "@/runner/orchestrate"
import type { RuntimeFacadeComposeOptions } from "@/sdk/runtime"
import { gateOn } from "@/shared"
import { defaultShadowOdb, type ShadowOdb } from "@/storage"
import {
  createModeCycleStore,
  DEFAULT_POSTURE,
  MODE_CYCLE,
  type ModeCycleStore,
  modeCycleEnabled,
  postureByKey,
} from "../../mode-cycle"
import { createBrowserNetHolder } from "../../slash/browser-net-cmd"
import type { SlashContext } from "../../slash-commands"
import { BG_TURN_ENV_GATE, createBackgroundTurnPortal } from "../background-turn-portal"
import { createConversationActionSurface, createTurnActivity } from "../conversation-action-surface"
import { createGoalWakeSignalSlot } from "../goal-wake-signal"

import { buildPerToolCheckpointWire } from "../per-tool-checkpoint-wire"
import type { SessionSetupResult } from "../session-setup"
import { liveAgentMode, stickyModelFilePath } from "../sticky-model-boot"
import { isEnvTruthy } from "./kb-slot"
import { buildRadarStore, buildRetryCandidates } from "./wire-builders"

const buildModeWire = (
  setup: SessionSetupResult,
  env: NodeJS.ProcessEnv,
): { readonly store?: ModeCycleStore; readonly slot?: SlashContext["mode"] } => {
  if (!modeCycleEnabled(env)) return {}
  // aug-28 — SEED the rung from `--plan`. The cycle is CLI-seeded default-ON, and
  // `resolveLiveAgentMode` prefers this store's `agentMode` over `config.planMode`
  // (`@/agent/mode`), so a bare `createModeCycleStore()` made `--plan` resolve as
  // `"default"` for the loop: the sticky-model read looked at the wrong key AND
  // the admissibility gate saw a non-plan posture in a session the operator
  // launched as plan. Seeding is the one line that makes the live cell agree with
  // the launch flag (the pill already rendered PLAN, which is what hid this).
  const store = createModeCycleStore(setup.planMode ? postureByKey("plan") : DEFAULT_POSTURE)
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

/**
 * `/model` (aug-27) — mint the surface's two-halved model-switch wire.
 *
 *   - `stickyModel.store` — the per-mode pick, PERSISTED
 *     (`~/.quanta/sticky-model.json`) so a choice survives the session, matching
 *     what every peer CLI does. Persistence is only coherent because the boot
 *     snapshot is also read SYNCHRONOUSLY here: the adapter's `current()`, the
 *     status line and the welcome banner are all sync seams, so without that
 *     read a fresh session would display the boot model while the loop ran the
 *     persisted one. `stickyBoot.snapshot` seeds the adapter's per-mode shadow
 *     and `stickyBoot.modelId` seeds the candidate below, which closes the last
 *     leg — a port for the persisted id must EXIST on turn 1 or the loop's swap
 *     finds nothing and silently runs the boot model.
 *   - `catalog.candidates` — the live id→port list, seeded from the boot model +
 *     the persisted pick + `QUANTA_RETRY_MODELS`, and grown by the provider
 *     catalog probe. Shared BY REFERENCE with `AgentConfig.modelCandidates`
 *     (threaded down in `runtime-compose.ts`): that list is what the loop
 *     resolves a sticky / skill model pick to a PORT out of, so without it a
 *     pick is a silent no-op.
 *
 * Extracted (not inlined in {@link buildSurfaceCoreState}) to keep that
 * composer under biome's cognitive-complexity cap.
 */
const buildModelSwitchWire = (
  setup: SessionSetupResult,
  env: NodeJS.ProcessEnv,
  retryCandidates: readonly ModelCandidate[],
  /** The LIVE mode cell (the shift+tab cycle), so the BOOT snapshot read uses the
   *  same key the loop will read. Absent (cycle gate off) ⇒ `--plan` decides. */
  agentModeCell: ModeCycleStore | undefined,
): {
  readonly stickyModel: { readonly store: StickyModelStore }
  readonly routing: ModelRoutingSession
  readonly catalog: ModelCatalogWire
} => {
  // MR-02 — the SHARED routing session. Everything this function used to do by
  // hand (path resolution, boot-snapshot admission, per-key runnability vetting,
  // eager candidate seeding, the session-scope wrapper, explicit-pin precedence)
  // now lives in ONE owner that the web daemon and the headless root call too, and
  // the shared conformance suite is what proves the three answer identically. The
  // defects that motivated it were all assembly-order mistakes, and only removing
  // the assembly from the roots can prevent the next one.
  const session = createModelRoutingSession({
    env,
    path: stickyModelFilePath(env),
    provider: setup.provider,
    bootModelId: setup.model,
    bootPort: setup.llm,
    // The LIVE mode: the shift+tab cycle's posture wins over `--plan`, mirroring
    // the loop's `resolveLiveAgentMode`, so the write key and the read key cannot
    // drift apart on a rung change.
    mode: liveAgentMode({
      planMode: setup.planMode,
      ...(agentModeCell !== undefined ? { agentModeCell } : {}),
    }),
    // aug-28 PRECEDENCE — an EXPLICIT per-invocation pin (`QUANTA_MODEL` /
    // `--model`) beats a stored preference. Without it, `QUANTA_MODEL=x quanta "…"`
    // in CI, cron or a git hook silently ran whatever a human last picked with
    // `/model`, and the one-shot path paints no banner so nothing said so.
    pinned: setup.modelPinnedExplicitly === true,
    // INVARIANT B — the surface builds the ports, so a picked model carries the
    // same always-on wrappers the boot port has (bounded retry, empty-stream
    // breaker, progress heartbeat) instead of streaming through a bare adapter.
    buildPort: (id: string) => {
      const inner = tryCreateLLM(setup.provider, { model: id }, env)
      return inner === null
        ? null
        : decorateSwappableModelPort({ inner, signal: setup.abort.signal })
    },
    seeded: retryCandidates,
    signal: setup.abort.signal,
  })
  return { stickyModel: { store: session.store }, routing: session, catalog: session.catalog }
}

const goalPursuitEnabled = (
  env: NodeJS.ProcessEnv,
  objectiveStore: ReturnType<typeof resolveGatedObjectiveAuthority>,
): boolean => gateOn(env, "QUANTA_GOAL_ENFORCE") && objectiveStore !== undefined

/**
 * The surface's MODEL slice (aug-28): the retry candidates, the sticky store + its
 * boot resolution, the candidate/port catalog, the live-mode getter, and the one
 * pick getter every display reads.
 *
 * Extracted as a unit because these six are one subject and were pushing
 * {@link buildSurfaceCoreState} past the god-function cap — and because the two
 * getters MUST be minted next to the store they read: `liveMode` mirrors the loop's
 * `resolveLiveAgentMode` (the shift+tab posture wins over `--plan`) and the sticky
 * key contains the mode, so two independent constructions of that getter are two
 * chances for the WRITE key and the READ key to drift apart on a rung change.
 */
const buildModelSurface = (
  setup: SessionSetupResult,
  env: NodeJS.ProcessEnv,
  modeStore: ModeCycleStore | undefined,
) => {
  const retryCandidates = buildRetryCandidates(env, setup.provider, setup.model)
  const {
    stickyModel,
    routing,
    catalog: modelCatalog,
  } = buildModelSwitchWire(setup, env, retryCandidates, modeStore)
  const liveMode = liveAgentMode({
    planMode: setup.planMode,
    ...(modeStore !== undefined ? { agentModeCell: modeStore } : {}),
  })
  return {
    retryCandidates,
    stickyModel,
    routing,
    modelCatalog,
    liveMode,
    // THE live pick for the current provider+mode, straight off the routing
    // authority. `undefined` deliberately means "no preference" — that is what the
    // `stickyModelStore.effectiveModel` slot must publish, since `effectiveModelOf`
    // supplies the boot fallback itself and a getter that eagerly answered the boot
    // model would be claiming a preference nobody set.
    pickedModel: routing.selectedModel,
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
  const { retryCandidates, stickyModel, routing, modelCatalog, liveMode, pickedModel } =
    buildModelSurface(setup, env, mode.store)
  const shadowOdb: ShadowOdb | undefined = isEnvTruthy(env.QUANTA_SHADOW)
    ? defaultShadowOdb()
    : undefined
  const perToolCkpt =
    gateOn(env, "QUANTA_PER_TOOL_RECORD") && shadowOdb !== undefined
      ? buildPerToolCheckpointWire({
          shadowOdb,
          conversationStore: convStore,
          workspace: setup.cwd,
        })
      : undefined
  const shadowVerify = isEnvTruthy(env.QUANTA_SHADOW_VERIFY)
    ? createShadowVerify(createShadowVerifyAdapters(setup.cwd))
    : undefined
  const objectiveStore = resolveGatedObjectiveAuthority(env, {
    confirmationAvailable: true,
    ...(setup.restoredObjective !== undefined ? { restoreFrom: setup.restoredObjective } : {}),
  })
  const objectiveVerification =
    objectiveStore === undefined
      ? undefined
      : createObjectiveVerificationCoordinator({
          read: createObjectiveCapabilities(objectiveStore).read,
          verifier: createObjectiveCapabilities(objectiveStore).verifier,
          runner: createObjectiveCheckRunner(),
          evidence: createWorkspaceEvidence(),
          workspaceCwd: setup.cwd,
        })
  // One session holder, produced for either consumer. The agent loop remains
  // the sole writer. Goal pursuit only needs it when both its continuation
  // gate and its objective authority are present; otherwise no active-turn
  // state is allocated on the default path.
  const goalPursuit = goalPursuitEnabled(env, objectiveStore)
  const turnActivityRequired = isEnvTruthy(env.QUANTA_CONVERSATION_ACTIONS) || goalPursuit
  const turnActivity = turnActivityRequired ? createTurnActivity() : undefined
  // GOAL-04 — the host-owned attributed-attempt slot exists only when goal
  // pursuit is composed (the wake controller claims it before each attributed turn).
  const objectiveAttemptSlot = goalPursuit ? createObjectiveAttemptSlot() : undefined
  const goalWakeSlot = goalPursuit ? createGoalWakeSignalSlot() : undefined
  const conversationActions =
    isEnvTruthy(env.QUANTA_CONVERSATION_ACTIONS) && turnActivity !== undefined
      ? createConversationActionSurface(turnActivity.activeTurnRef)
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
    // `/model` — the surface-owned per-mode model store + live candidate
    // catalog. Both are threaded TWO ways: onto the slash context (`/model`,
    // `/sticky-model`) and DOWN onto the per-turn `AgentConfig` (the store as
    // `stickyModelStore`, the catalog as `modelCandidates`) so the pick the
    // operator makes is the pick the next turn runs.
    liveMode,
    pickedModel,
    effectiveModel: (): string => pickedModel() ?? setup.model,
    stickyModel,
    routing,
    modelCatalog,
    setLastStreamInput: (input: StreamInput) => {
      lastStreamInput = input
    },
    lastStreamInput: () => lastStreamInput,
    shadowOdb,
    perToolCkpt,
    shadowVerify,
    onPreCompact: buildPreCompactHook(setup, env),
    conversationActions,
    turnActivity,
    objectiveAttemptSlot,
    goalWakeSlot,
    interruptedTurnBuffer,
    inboundMode,
    backgroundPortal,
    radarStore,
    browserNetHolder,
    // RFC-03 H1 — the objective authority is resolved through the ONE gated
    // surface builder: PRESENT only under `QUANTA_OBJECTIVE_TOOLS` (else undefined
    // ⇒ `/goal` prints its not-wired posture + no `objective_*` tools, matching
    // the `objective_set` SSOT `cli: "opt-in"` default), and — under
    // `QUANTA_PROPOSE_GOAL` — GATED so a model-originated objective mutation
    // requires an admitted approval (no ungated authority reaches `config.objective`
    // to bypass HITL). The interactive REPL unconditionally composes an `onConfirm`
    // authority (`runtime-context-compose`), so `confirmationAvailable` is true and
    // a gated proposal is MEDIATED (prompted) rather than fail-closed. The SAME
    // instance backs the surface (`/goal` slash + idle ticker + status chip) and,
    // threaded DOWN via the compose seam, the LLM `objective_*` tools.
    //
    // RFC-03 C2 — durable resume: when this session was reopened by id and carried
    // a persisted objective (`setup.restoredObjective`), thread it as `restoreFrom`
    // so the reopened authority reconstructs the goal / criterion-ids / revision /
    // provenance. Absent (fresh / legacy / no-objective) ⇒ a fresh empty authority
    // (byte-identical legacy).
    objectiveStore,
    objectiveVerification,
    presetResolver: createStickyPresetResolver(),
  }
}

export type SurfaceCoreState = ReturnType<typeof buildSurfaceCoreState>
