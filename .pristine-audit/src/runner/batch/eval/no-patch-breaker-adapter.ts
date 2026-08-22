import { type AgentConfig, HookBus, type StopReason } from "@/agent"
import { decideNoPatch } from "@/agent/no-patch-breaker"
import { editTargetOf } from "./stream-tap"

const commitNowMessage = (turnsUsed: number, maxTurns: number): string =>
  `You have used ${turnsUsed} of ${maxTurns} turns with no mutating edit yet; the turn budget is finite. When you are ready, proceed to a concrete code change and run the narrowest verification you can.`

const isTurnBudgetStop = (stopReason: StopReason | undefined): boolean =>
  stopReason === "max_turns" || stopReason === "budget_exhausted"

/**
 * FIX 4 — guard the force-commit fraction at the boundary. The fraction feeds
 * `Math.floor(cap * frac)` in `decideNoPatch`; `frac >= 1` makes the commit-now
 * trigger unreachable and `frac <= 0` forces a commit on turn 0. Mirror
 * `parseRetryTransientEnv`'s discipline: REJECT any out-of-(0,1) (or non-finite)
 * value and drop the override so `decideNoPatch` falls back to its built-in
 * default. Only a finite fraction strictly inside (0,1) survives.
 */
export const sanitizeForceCommitFraction = (frac?: number): number | undefined =>
  frac !== undefined && Number.isFinite(frac) && frac > 0 && frac < 1 ? frac : undefined

export const attachNoPatchBreaker = (
  hooks: HookBus,
  maxTurns: number,
  forceCommitAtFraction?: number,
): HookBus => {
  const cap = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : 1
  const safeFraction = sanitizeForceCommitFraction(forceCommitAtFraction)
  let hasMutatingEdit = false
  let injected = false

  hooks.on("post_tool_use", (event) => {
    if (event.ok && !hasMutatingEdit && editTargetOf(event.name, event.input) !== undefined) {
      hasMutatingEdit = true
    }
  })

  hooks.on("turn_start", (event) => {
    if (injected || hasMutatingEdit) return
    const decision = decideNoPatch({
      turnsUsed: event.turn,
      maxTurns: cap,
      hasMutatingEdit,
      ...(safeFraction !== undefined ? { forceCommitAtFraction: safeFraction } : {}),
    })
    if (decision.action === "continue") return
    injected = true
    return {
      promptHook: {
        injectBeforeUser: commitNowMessage(event.turn, cap),
      },
    }
  })

  return hooks
}

export const wireNoPatchBreaker = (
  config: AgentConfig,
  forceCommitAtFraction?: number,
): AgentConfig => {
  const hooks = attachNoPatchBreaker(
    config.hooks ?? new HookBus(),
    config.maxTurns,
    forceCommitAtFraction,
  )
  return config.hooks === undefined ? { ...config, hooks } : config
}

export const noPatchExhaustedErrorOf = (args: {
  enabled: boolean
  stopReason: StopReason | undefined
  patch: string
  editCount?: number
}): string | undefined => {
  if (!args.enabled || !isTurnBudgetStop(args.stopReason)) return undefined
  if (args.patch.trim() !== "") return undefined
  if ((args.editCount ?? 0) > 0) return undefined
  return args.stopReason === "max_turns"
    ? "no patch produced before max turns exhausted (no_patch_exhausted)"
    : "no patch produced before token budget exhausted (no_patch_exhausted)"
}
