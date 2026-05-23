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
import { assertModeMatrix, BUDGET_PRESETS, BudgetMeter as BudgetMeterCtor, clampDials, runAgent as defaultRunAgent, MODE_PRESETS, } from "@/agent";
/** Pick the right `runAgent` implementation: caller-stub > real. Exported so
 *  every mode-preset uses the same resolution rule (test-seam ➝ default). */
export const resolveRunAgent = (seams) => seams?.runAgent ?? defaultRunAgent;
/** Single source of truth for "config for this mode" assembly. */
export const assembleAgentConfig = (req) => {
    const policy = MODE_PRESETS[req.mode];
    assertModeMatrix(policy);
    const presetDials = BUDGET_PRESETS[req.mode];
    // operator dials override preset; both then clamp to caps (with surface log)
    const merged = { ...presetDials, ...(req.dials ?? {}) };
    const caps = "budgetCaps" in policy ? policy.budgetCaps : {};
    const clamped = clampDials(merged, caps);
    const exhaustion = req.exhaustion ??
        ("budgetExhaustion" in policy ? policy.budgetExhaustion : "stop");
    const meter = new BudgetMeterCtor({
        dials: clamped,
        caps,
        exhaustion,
    });
    return {
        ...req.base,
        modePolicy: policy,
        budgetMeter: meter,
    };
};
