/**
 * Static-witness -> public-contract bridge (SCAFF-05).
 *
 * Current clean-authority policy: STATIC-ONLY structural witnesses NEVER mint a
 * required public contract. They remain useful for localization, candidate-family
 * seeding, and repair evidence, but they do not get to veto a proof-positive
 * single-site candidate or force a multi-site obligation on their own.
 *
 * Any future promotion from static structure into selector authority must be
 * backed by executable public proof (for example, a public repro/test receipt)
 * and should happen in that proof pipeline, not here. This bridge therefore
 * fails closed and returns `[]`.
 *
 * PURE + deterministic: no I/O, no LLM, no clock/random.
 */
import type { PublicContract } from "@/runner/batch/eval/public-contract-types"
import type { StaticWitness } from "@/runner/batch/eval/static-witness"

/**
 * Static-only witnesses do not mint required contracts. Keep the signature so
 * drivers can compose this helper uniformly while the authority boundary stays
 * fail-closed.
 */
export const buildStaticWitnessContracts = (
  _witnesses: readonly StaticWitness[],
): PublicContract[] => []
