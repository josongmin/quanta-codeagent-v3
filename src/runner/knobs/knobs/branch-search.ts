/**
 * Knob: `branch-search` — Agentless N-best speculative branch search
 * (ADR-0084 / Agentless paper).
 *
 * Default-OFF. Migrated verbatim from `parseBenchBranchSearchK` in
 * `src/runner/batch/eval/driver.ts`. Apply builds the canonical bench
 * `BranchSearchConfig` block (verifierKinds=["tsc"], timeout=60s,
 * isolation="tmpdir" — bench sandboxes from `createSandbox` may not be git
 * repos).
 *
 * Domain (ACTIVE):
 *   - integer K in [2, 8] ⇒ `BranchSearchConfig` with `defaultN=K`.
 *
 * Domain (INACTIVE — `parse` returns `undefined`):
 *   - absent / `"0"` / `"1"` (K=1 ≡ baseline — wiring would only add overhead)
 *   - negative / non-integer / NaN / garbage / empty / whitespace
 *   - K > 8 (matches slice's `tool.ts` zod `.min(2).max(8)`)
 *
 * `costMultiplier: K` — explicit matrix budget contract.
 *
 * Conflicts with `localize-phase` — both strengthen explore.
 */

import type { AgentConfig, BranchSearchConfig } from "@/agent"
import { branchSearchSchema } from "@/config/knob-schema/schemas/bench-a"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import type { Surface } from "../types"

const SURFACES: readonly Surface[] = ["bench"]

/** The schema's parsed value (config-leaf can't reference the runner
 *  `VerifierKind`, so its `defaultVerifierKinds` is `readonly string[]`). */
type BranchSearchValue = ReturnType<typeof branchSearchSchema.parse>

/** Non-NOOP apply — folds `cfg.branchSearch`. Bound into the central registrar
 *  (`APPLY_BINDINGS` + conflicts) AND used to derive the back-compat knob export;
 *  ONE definition so the derived knob is byte-identical to the registered one.
 *  The schema's `defaultVerifierKinds` is `readonly string[]` (leaf-clean); the
 *  parse only ever emits `["tsc"]`, so the narrowing to `BranchSearchConfig` is
 *  sound. */
export const applyBranchSearch = (
  cfg: AgentConfig,
  value: NonNullable<BranchSearchValue>,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, branchSearch: value.config as BranchSearchConfig }
}

// DERIVED from the schema SSOT (data) + the runner-side apply + relationship
// bindings. Registration is CENTRAL (`registerBenchKnobs`); no self-register here.
export const branchSearchKnob = deriveKnob(branchSearchSchema, applyBranchSearch, {
  conflicts: ["localize-phase"],
})
