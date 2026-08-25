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
