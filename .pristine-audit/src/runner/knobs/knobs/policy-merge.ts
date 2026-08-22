/**
 * Knob: `policy-merge` — layered permission-policy merge strategy.
 *
 * Selects how layered named permission profiles (per-user / per-repo /
 * team-admin) fold into the effective profile at the composition root
 * (`src/permission/policy-layers/` engine via `mergeProfileLayers`). Absorbs
 * Codex `MergeStrategy` { source-precedence | most-restrictive }.
 *
 * Default-OFF semantics: `source-precedence` IS the pre-existing precedence
 * (most-authoritative present source wins each field — team-admin > per-repo >
 * per-user > default), so wiring this strategy with a single layer present is
 * byte-identical to today's single-profile wire. The behavior-changing value is
 * `most-restrictive` (the SAFER value wins each field regardless of source
 * authority). When the knob is ABSENT the composition root treats it as
 * `source-precedence` ⇒ existing permission behavior byte-identical.
 *
 * Domain (ACTIVE):
 *   - `"source-precedence"` ⇒ `{ strategy: "source-precedence" }`
 *   - `"most-restrictive"`  ⇒ `{ strategy: "most-restrictive" }`
 *
 * Domain (INACTIVE — `parse` returns `undefined`):
 *   - absent / empty / whitespace
 *   - any other string (typo / garbage / wrong case) — fail to UNSET, NOT to a
 *     guessed strategy (the composition root then applies the
 *     `source-precedence` default, preserving current behavior).
 *
 * `apply` sets `AgentConfig.policyMergeStrategy`, which `buildBaseFromArgs`
 * reads when folding layered profiles. No `costMultiplier` (pure policy
 * selection — zero added matrix budget).
 */

import type { AgentConfig } from "@/agent"
import type { MergeStrategy } from "@/permission"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

interface PolicyMergeValue {
  readonly strategy: MergeStrategy
}

/** Parse the raw env/CLI string into a {@link MergeStrategy}. Only the two
 *  canonical literals resolve; everything else (absent / empty / typo / wrong
 *  case) ⇒ `undefined` so the caller falls through to the next layer and,
 *  ultimately, to the `source-precedence` composition-root default. */
const parsePolicyMerge = (raw: string | undefined): PolicyMergeValue | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "source-precedence" || s === "most-restrictive") {
    return { strategy: s }
  }
  return undefined
}

const applyPolicyMerge = (
  cfg: AgentConfig,
  value: PolicyMergeValue,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, policyMergeStrategy: value.strategy }
}

export const policyMergeKnob: Knob<PolicyMergeValue> = {
  id: "policy-merge",
  envKey: "QUANTA_POLICY_MERGE_STRATEGY",
  category: "agent",
  surfaces: SURFACES,
  parse: parsePolicyMerge,
  apply: applyPolicyMerge,
  describe: "Layered permission-profile merge strategy (source-precedence | most-restrictive)",
  source: "Codex MergeStrategy / ADR layered-policy-merge",
}

registerKnob(policyMergeKnob)
