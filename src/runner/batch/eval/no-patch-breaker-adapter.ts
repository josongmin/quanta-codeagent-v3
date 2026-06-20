import { type AgentConfig, HookBus, type StopReason } from "@/agent"
import { decideNoPatch } from "@/agent/no-patch-breaker"
import { editTargetOf } from "./stream-tap"

const commitNowMessage = (turnsUsed: number, maxTurns: number): string =>
  `No mutating edit has been made after ${turnsUsed}/${maxTurns} turns. Stop exploring. Make the smallest concrete code change now, then run the narrowest verification you can.`

const isTurnBudgetStop = (stopReason: StopReason | undefined): boolean =>
  stopReason === "max_turns" || stopReason === "budget_exhausted"

export const attachNoPatchBreaker = (hooks: HookBus, maxTurns: number): HookBus => {
  const cap = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : 1
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

export const wireNoPatchBreaker = (config: AgentConfig): AgentConfig => {
  const hooks = attachNoPatchBreaker(config.hooks ?? new HookBus(), config.maxTurns)
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
