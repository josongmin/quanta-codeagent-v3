/**
 * Unified AgentConfig assembler — RFC may-22-unified-agent-runtime / Phase 4.
 *
 * SINGLE wiring point for `ModePolicy + BudgetMeter + BudgetCaps`. Apps that
 * want a unified surface (`apps/agent/index.ts`) call this; legacy entry points
 * (`apps/cli/index.ts`, `apps/bench/index.ts`) can adopt incrementally.
 *
 * Lever propagation: this is where the 12-lever discriminated union from
 * `ModePolicy` translates to concrete AgentConfig fields. New levers added to
 * `ModePolicy` MUST be wired here AND in `apps/agent/mode-presets/<mode>.ts`
 * — the per-mode preset owns the lever→implementation mapping, while THIS
 * file owns the unified type-narrow + budget meter construction.
 *
 * Default-OFF / byte-identical: callers may pass `modePolicy: undefined` to
 * skip the whole RFC may-22 layer — the returned config is identical to a
 * pre-RFC manually-assembled AgentConfig (no budgetMeter, no modePolicy).
 */
import { type AgentConfig, type BudgetMeter, BudgetMeter as BudgetMeterCtor } from "@/agent"
import {
  BUDGET_PRESETS,
  type ModePolicy,
  MODE_PRESETS,
  type RunMode,
  assertModeMatrix,
  clampDials,
} from "@/agent"
import type { BudgetDials, BudgetExhaustionPolicy } from "@/agent"

/** Operator input for assemble: mode + dials override + base AgentConfig core. */
export interface AssembleRequest {
  /** Which runtime mode the agent runs in. */
  mode: RunMode
  /** Caller-supplied AgentConfig core (llm, registry, stream, permission,
   *  messages, system, maxTurns, …). The assembler does NOT construct these
   *  — they are surface-specific (REPL stdin, bench sandbox, etc.). */
  base: Omit<AgentConfig, "modePolicy" | "budgetMeter">
  /** Operator-requested budget dials. Defaults from `BUDGET_PRESETS[mode]`,
   *  clamped to `MODE_PRESETS[mode].budgetCaps` if any. */
  dials?: Partial<BudgetDials>
  /** Override the mode's exhaustion policy. Default = preset value. */
  exhaustion?: BudgetExhaustionPolicy
}

/** Single source of truth for "config for this mode" assembly. */
export const assembleAgentConfig = (req: AssembleRequest): AgentConfig => {
  const policy: ModePolicy = MODE_PRESETS[req.mode]
  assertModeMatrix(policy)

  const presetDials = BUDGET_PRESETS[req.mode]
  // operator dials override preset; both then clamp to caps (with surface log)
  const merged: BudgetDials = { ...presetDials, ...(req.dials ?? {}) }
  const caps = "budgetCaps" in policy ? (policy.budgetCaps as Partial<BudgetDials>) : {}
  const clamped = clampDials(merged, caps)

  const exhaustion: BudgetExhaustionPolicy =
    req.exhaustion ??
    ("budgetExhaustion" in policy
      ? (policy.budgetExhaustion as BudgetExhaustionPolicy)
      : "stop")

  const meter: BudgetMeter = new BudgetMeterCtor({
    dials: clamped,
    caps,
    exhaustion,
  })

  return {
    ...req.base,
    modePolicy: policy,
    budgetMeter: meter,
  }
}
