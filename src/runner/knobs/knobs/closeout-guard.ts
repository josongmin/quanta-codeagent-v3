/**
 * Knob: `closeout-guard` — closeout reminder (ADR-0017).
 *
 * Single-shot finish-time self-check (one nudge per session, NOT a knob —
 * single-shot cap is enforced by the policy itself in `src/agent/closeout-
 * guard.ts`). The knob value selects the variant:
 *   - truthy ("1" / "on" / "true") ⇒ enable with the default UNION self-check
 *     (general defended-claim guidance + a self-select code-modification
 *     four-surface walk). No history scan — the model self-selects the
 *     code-mod portion iff it actually changed source.
 *   - "4rule" ⇒ enable AND force the Codex `response-assembly-and-closeout
 *     §5.2` defended-claim 4-rule + Verification report scaffold (explicit
 *     opt-in).
 *
 * Anything else (falsy / garbage / empty / whitespace) returns `undefined` so
 * the caller falls through to the next layer. No heuristics.
 *
 * Wired field: `cfg.closeoutGuard = { enabled: true, fourRule?: boolean }`
 * (typed in `src/agent/types.ts` at AgentConfig.closeoutGuard).
 */

import type { AgentConfig } from "@/agent"
import { closeoutGuardSchema } from "@/config/knob-schema/schemas/bench-c"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import type { Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

/** Parsed value distinguishes plain-enable from the strict 4-rule variant. */
export type CloseoutGuardValue = { fourRule: boolean }

/** Non-NOOP apply — folds `cfg.closeoutGuard`. Bound into the central registrar
 *  (`APPLY_BINDINGS`) AND used to derive the back-compat knob export below; ONE
 *  definition so the derived knob is byte-identical to the registered one. */
export const applyCloseoutGuard = (
  cfg: AgentConfig,
  value: CloseoutGuardValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  // `fourRule: false` MUST be omitted (not set explicitly) under
  // exactOptionalPropertyTypes — the AgentConfig field is `fourRule?: boolean`
  // and a tri-state (`undefined | false | true`) is observable in
  // `decideCloseoutGuard` (it explicit-checks `=== true`). Setting `false`
  // when the caller passed plain-truthy would still work today but locks the
  // shape to a less-flexible posture; omit instead and let downstream
  // defaults apply.
  return {
    ...cfg,
    closeoutGuard: { enabled: true, ...(value.fourRule ? { fourRule: true } : {}) },
  }
}

// DERIVED from the schema SSOT (data) + the runner-side apply binding above.
// Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const closeoutGuardKnob = deriveKnob(closeoutGuardSchema, applyCloseoutGuard)
