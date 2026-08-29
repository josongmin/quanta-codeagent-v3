import type { RuntimeFacadeComposeOptions } from "@/sdk/runtime"
import { DEFAULT_IDLE_MS } from "../../idle-monitor"
import { buildPresetRoleModelResolver } from "../ctx-adapters/preset-role-resolver-adapter"
import type { SessionSetupResult } from "../session-setup"
import type { SurfaceCoreState } from "./core-state"
import { isEnvTruthy } from "./kb-slot"
import { radarTaskDurationThresholdMs } from "./wire-builders"

const radarOptions = (
  setup: SessionSetupResult,
  env: NodeJS.ProcessEnv,
  core: SurfaceCoreState,
): Partial<RuntimeFacadeComposeOptions> => {
  if (core.radarStore === undefined) return {}
  return {
    radar: {
      store: core.radarStore,
      idleThresholdMs: setup.idleMonitor.thresholdMs ?? DEFAULT_IDLE_MS,
      taskDurationThresholdMs: radarTaskDurationThresholdMs(env),
      idleMsForTurn: () =>
        setup.idleMonitor.isIdle() ? (setup.idleMonitor.thresholdMs ?? DEFAULT_IDLE_MS) : 0,
    },
  }
}

const stateHookOptions = (core: SurfaceCoreState): Partial<RuntimeFacadeComposeOptions> => ({
  ...(core.workingStateEnabled
    ? {
        workingState: { enabled: true },
        onWorkingStateReady: core.setWorkingStateGet,
      }
    : {}),
  ...(core.skillScopeEnabled ? { onSkillScopeReady: core.setSkillScopeGet } : {}),
  ...(core.retryEnabled ? { onTurnStreamInput: core.setLastStreamInput } : {}),
})

const shadowOptions = (core: SurfaceCoreState): Partial<RuntimeFacadeComposeOptions> => {
  if (core.shadowOdb === undefined) return {}
  return {
    shadowOdb: core.shadowOdb,
    shadowCheckpoint: {
      mode: "pre-destructive",
      ...(core.perToolCkpt === undefined ? {} : { granularPolicy: core.perToolCkpt.policy }),
    },
  }
}

const actionOptions = (core: SurfaceCoreState): Partial<RuntimeFacadeComposeOptions> => ({
  ...(core.conversationActions === undefined
    ? {}
    : {
        conversationActionPort: core.conversationActions.port,
      }),
  ...(core.turnActivity === undefined ? {} : { activeTurnRef: core.turnActivity.activeTurnRef }),
  ...(core.objectiveAttemptSlot === undefined
    ? {}
    : { objectiveAttemptSlot: core.objectiveAttemptSlot }),
  ...(core.objectiveSettlementSink === undefined
    ? {}
    : { objectiveSettlementSink: core.objectiveSettlementSink }),
  ...(core.interruptedTurnBuffer === undefined
    ? {}
    : { interruptedTurnBuffer: core.interruptedTurnBuffer }),
  ...(core.shadowVerify === undefined ? {} : { shadowVerify: core.shadowVerify }),
  ...(core.browserNetHolder === undefined ? {} : { browserNet: core.browserNetHolder }),
})

export const buildRuntimeFacadeCompose = (
  setup: SessionSetupResult,
  env: NodeJS.ProcessEnv,
  core: SurfaceCoreState,
): RuntimeFacadeComposeOptions => ({
  // RFC-03 H1 — thread the SESSION-STABLE objective authority DOWN only when the
  // surface actually minted one (`QUANTA_OBJECTIVE_TOOLS` on). Absent ⇒ the key is
  // omitted ⇒ `maybeWireObjective` mints nothing (gate off) ⇒ no `objective_*`
  // tools, no ungated `config.objective` (exactOptionalPropertyTypes).
  ...(core.objectiveStore !== undefined ? { objective: core.objectiveStore } : {}),
  roleModelResolver: buildPresetRoleModelResolver(core.presetResolver),
  // `/model` (aug-27) — thread the surface's model-switch pair DOWN onto the
  // per-turn `AgentConfig`, the two halves the loop needs to honor a pick:
  //   - `stickyModelStore`: `skill-gate#readStickyModelForMode` reads the SAME
  //     store `/model` writes, so the pick applies from the next turn;
  //   - `modelCandidates`: the LIVE array (shared by reference) the loop
  //     resolves that id to a PORT out of. Before this, the interactive CLI set
  //     neither, so a `/model` (or a skill `model:` override) could not reach
  //     the wire at all — the id had no port and the swap silently no-opped.
  // MR-02 (final) — THE routing owner. `modelRoutingFor(config)` returns this, so
  // the loop asks one thing; the two slots below stay for the hosts and tests that
  // still wire the pieces directly (see `model-routing/from-config.ts`).
  modelRouting: core.routing.authority,
  stickyModelStore: {
    ...core.stickyModel,
    provider: setup.provider,
    // aug-28 — the SYNC "what the next turn will run" every display consumes
    // (see `@/agent/effective-model`): `describe().modelSlug`, and through it the
    // attach pill, the SDK's `session.model` and the web `/state`+`/status` rows.
    // Read straight off the store (`peek`) with the SAME key the pick was written
    // under, so it cannot report a model the loop is not about to run.
    effectiveModel: (): string | undefined => core.pickedModel(),
  },
  modelCandidates: core.modelCatalog.candidates,
  ...radarOptions(setup, env, core),
  onPromptAssembled: core.contextUsageHolder.sink,
  ...stateHookOptions(core),
  ...shadowOptions(core),
  ...(core.onPreCompact === undefined ? {} : { onPreCompact: core.onPreCompact }),
  ...(isEnvTruthy(env.QUANTA_IMAGE_SANITIZATION)
    ? { imageSanitizationRetry: { enabled: true } }
    : {}),
  ...(isEnvTruthy(env.QUANTA_TURN_DIFF) ? { gitObservability: { enabled: true } } : {}),
  ...actionOptions(core),
})
