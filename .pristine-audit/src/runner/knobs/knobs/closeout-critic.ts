/**
 * Knob: `closeout-critic` — optional second-opinion critic at turn closeout
 * (P12 — jun-7 gap-other-agent).
 *
 * When ON, the agent loop consults an injected reviewer/critic port at the
 * exact moment it is about to seal a `{kind:"completed"}` turn. The critic's
 * verdict is surfaced as advisory data on the existing `recovery` stream event
 * (reason `closeout`, detail prefixed `critic:`) — it NEVER blocks completion.
 *
 * This knob only flips the `enabled` gate; the critic IMPLEMENTATION is wired
 * by the composition root via DI (`AgentConfig.closeoutCritic.critic`). With
 * the knob ON but no port wired, the loop FAILS OPEN (closeout proceeds, no
 * throw) — see `src/agent/closeout-critic.ts`.
 *
 * Default-OFF: any falsy / garbage / empty value parses to `undefined`, so the
 * field is never set and the loop is byte-identical. No heuristics.
 *
 * Wired field: `cfg.closeoutCritic = { enabled: true }`
 * (typed in `src/agent/types.ts` at AgentConfig.closeoutCritic).
 */

import type { AgentConfig } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]
const TRUTHY = new Set(["1", "on", "true"])

/** Parsed value is presence-only — the knob carries no sub-options today; the
 *  critic port itself is injected out-of-band. */
export type CloseoutCriticValue = { enabled: true }

const parseCloseoutCritic = (raw: string | undefined): CloseoutCriticValue | undefined => {
  if (raw === undefined) return undefined
  return TRUTHY.has(raw) ? { enabled: true } : undefined
}

const applyCloseoutCritic = (
  cfg: AgentConfig,
  _value: CloseoutCriticValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  // Merge so a DI-supplied `critic` port (set by the composition root before
  // knob application) is preserved — the knob only flips `enabled`.
  return {
    ...cfg,
    closeoutCritic: { ...cfg.closeoutCritic, enabled: true },
  }
}

export const closeoutCriticKnob: Knob<CloseoutCriticValue> = {
  id: "closeout-critic",
  envKey: "QUANTA_CLOSEOUT_CRITIC",
  category: "verify",
  surfaces: SURFACES,
  parse: parseCloseoutCritic,
  apply: applyCloseoutCritic,
  describe: "Second-opinion critic at turn closeout (advisory, never blocks)",
  source: "P12-jun-7-gap-other-agent",
}

registerKnob(closeoutCriticKnob)
