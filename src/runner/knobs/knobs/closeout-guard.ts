/**
 * Knob: `closeout-guard` — closeout reminder (ADR-0017).
 *
 * Single-shot finish-time self-check (one nudge per session, NOT a knob —
 * single-shot cap is enforced by the policy itself in `src/agent/closeout-
 * guard.ts`). The knob value selects the variant:
 *   - truthy ("1" / "on" / "true") ⇒ enable with legacy one-liner / code-mod
 *     four-surface walk (routed by `decideCloseoutGuard` based on history).
 *   - "4rule" ⇒ enable AND force the Codex `response-assembly-and-closeout
 *     §5.2` defended-claim 4-rule + Verification report scaffold (explicit
 *     opt-in, wins over the implicit code-mod detector).
 *
 * Anything else (falsy / garbage / empty / whitespace) returns `undefined` so
 * the caller falls through to the next layer. No heuristics.
 *
 * Wired field: `cfg.closeoutGuard = { enabled: true, fourRule?: boolean }`
 * (typed in `src/agent/types.ts` at AgentConfig.closeoutGuard).
 */

import type { AgentConfig } from "@/agent"
import {type Knob, type Surface } from "../types"
import { registerKnob } from "../registry"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]
const TRUTHY = new Set(["1", "on", "true"])

/** Parsed value distinguishes plain-enable from the strict 4-rule variant. */
export type CloseoutGuardValue = { fourRule: boolean }

const parseCloseoutGuard = (raw: string | undefined): CloseoutGuardValue | undefined => {
  if (raw === undefined) return undefined
  if (raw === "4rule") return { fourRule: true }
  return TRUTHY.has(raw) ? { fourRule: false } : undefined
}

const applyCloseoutGuard = (
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

export const closeoutGuardKnob: Knob<CloseoutGuardValue> = {
  id: "closeout-guard",
  envKey: "QUANTA_BENCH_CLOSEOUT",
  category: "verify",
  surfaces: SURFACES,
  parse: parseCloseoutGuard,
  apply: applyCloseoutGuard,
  describe: "Closeout reminder (final-claim verification)",
  source: "ADR-0017",
}

registerKnob(closeoutGuardKnob)
