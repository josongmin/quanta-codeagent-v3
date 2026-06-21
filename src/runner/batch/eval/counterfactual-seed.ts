/**
 * Counterfactual minimal-alternative seed builder (T-202 + T-CF-11).
 *
 * STRUCTURAL seed (T-202): when candidate 0's patch trips the strict structural
 * risk gate (cross-file, new defs/classes, runtime-expanding calls, or an empty
 * diff), candidate 1 is generated with a *counterfactual minimal alternative*
 * seed instead of the generic owner-focus hint. This module turns the
 * deterministic {@link CandidateRiskFacts} contract into that BOUNDED text seed.
 *
 * SEMANTIC seed (T-CF-11): structural minimality steers cand1 toward a *smaller*
 * patch, which is wrong when cand0 fixed the WRONG SIDE of the issue. When a
 * failed public contract demands a different candidate family (e.g. a
 * symptom-owner cand0 that missed a lifecycle-owner contract), the seed must
 * steer cand1 toward THAT family — the opposite side of the failed contract —
 * not merely toward a smaller edit. `buildSemanticCounterfactualSeed` produces
 * that family-targeting seed, and `buildCounterfactualSeed` composes it on top of
 * the structural seed when a {@link SemanticCounterfactualDerivation} is supplied.
 *
 * It is a PURE projection: no full-diff re-injection, no timestamps, no random.
 * Both the reason bullets and the constraint bullets are CONDITIONAL on the
 * facts that actually fired, so the seed only ever asks the model to undo the
 * specific budget violations cand0 committed and/or to cover the family it
 * missed. If neither a structural reason nor a semantic target fired, the builder
 * returns `undefined` (self-guard).
 *
 * Source of truth: {@link CandidateRiskFacts} (`./counterfactual-risk`) for
 * structural steering; {@link SemanticCounterfactualDerivation}
 * (`./counterfactual-contract`) for semantic steering.
 */

import type {
  CandidateFamily,
  SemanticCounterfactualDerivation,
} from "./counterfactual-contract"
import type { CandidateRiskFacts } from "./counterfactual-risk"

const pluralFiles = (n: number): string => `${n} source file${n === 1 ? "" : "s"}`
const pluralDefs = (n: number): string => `${n} new def${n === 1 ? "" : "s"}/class`
const pluralCalls = (n: number): string => `${n} runtime-expanding call${n === 1 ? "" : "s"}`

/** Human phrasing for the family the counterfactual must steer toward. Generic
 *  typed obligations — NOT issue-family literals. */
const FAMILY_INTENT: Readonly<Record<CandidateFamily, string>> = {
  "root-owner": "fix the root owner that defines the broken behavior, not the symptom site",
  "symptom-owner": "fix the symptom owner where the failure surfaces",
  "api-owner": "implement/repair the public API surface the contract requires",
  "lifecycle-owner":
    "fix the lifecycle owner (setup/teardown/reset path), not just the symptom site",
  "test-adjacent-owner": "fix the owner adjacent to the failing test",
  "multi-site": "cover every site in the contract family, not a single site",
}

/** Build ONLY the semantic ("opposite side of the failed contract") seed body.
 *  Returns `undefined` when there is no target family to steer toward. */
export const buildSemanticCounterfactualSeed = (
  derivation: SemanticCounterfactualDerivation,
): string | undefined => {
  const family = derivation.targetFamily
  if (family === undefined || derivation.contracts.length === 0) return undefined

  const lines: string[] = [
    `Candidate 0 missed a public contract — it fixed the wrong side (family: ${family}):`,
    `- ${FAMILY_INTENT[family]}`,
  ]
  if (derivation.targetFiles.length > 0) {
    const files = derivation.targetFiles.map((f) => `\`${f}\``).join(", ")
    lines.push(`- the fix must touch the ${family} family: ${files}`)
  } else {
    lines.push(`- the fix must touch the ${family} family, not the symptom-only site`)
  }
  return lines.join("\n")
}

export const buildCounterfactualSeed = (args: {
  readonly facts: CandidateRiskFacts
  /** primary owner file to focus cand1 on (overrides facts.ownerFiles[0]). */
  readonly ownerFile: string | undefined
  /** OPTIONAL semantic steer (T-CF-11). When the failed public contract demands a
   *  different family, the resulting "opposite side" steer is composed onto the
   *  structural seed. Omitting it preserves the exact T-202 structural seed. */
  readonly semantic?: SemanticCounterfactualDerivation
}): string | undefined => {
  const { facts } = args

  const multiFile = facts.touchedSourceFiles > 1
  const hasNewDefs = facts.newDefs > 0
  const hasNewFiles = facts.newFiles > 0
  const hasRuntimeCalls = facts.runtimeExpandingCalls > 0
  const isEmpty = facts.emptyPatch === true

  const semanticSeed =
    args.semantic !== undefined ? buildSemanticCounterfactualSeed(args.semantic) : undefined

  // Self-guard: nothing structurally wrong AND no semantic target ⇒ nothing to produce.
  const fired = facts.crossFile || multiFile || hasNewDefs || hasNewFiles || hasRuntimeCalls || isEmpty
  if (!fired) return semanticSeed

  const reasonBullets: string[] = []
  if (multiFile) reasonBullets.push(`- touched ${pluralFiles(facts.touchedSourceFiles)}`)
  if (hasNewDefs) reasonBullets.push(`- added ${pluralDefs(facts.newDefs)}`)
  if (hasRuntimeCalls) reasonBullets.push(`- added ${pluralCalls(facts.runtimeExpandingCalls)}`)
  if (isEmpty) reasonBullets.push("- produced an empty patch")

  const owner = args.ownerFile ?? facts.ownerFiles[0]
  const constraintBullets: string[] = []

  if (facts.crossFile || multiFile || facts.filesOutsideOwner.length > 0) {
    constraintBullets.push(
      owner !== undefined && owner !== ""
        ? `- edit only \`${owner}\` unless the issue text proves otherwise`
        : "- edit the smallest set of source files unless the issue text proves otherwise",
    )
  }
  if (hasNewDefs || hasNewFiles) {
    constraintBullets.push("- no new helper/class/method")
  }
  if (hasRuntimeCalls) {
    constraintBullets.push("- preserve existing control flow")
    constraintBullets.push("- avoid runtime-expanding calls (compiler/IO/DB/subprocess)")
  }
  constraintBullets.push("- prefer an in-place guard/change")
  if (isEmpty) {
    constraintBullets.push("- the patch must be non-empty and apply cleanly")
  }

  const structuralSeed = [
    "Candidate 0 was rejected/expanded for structural reasons:",
    ...reasonBullets,
    "",
    "Produce a counterfactual minimal alternative:",
    ...constraintBullets,
  ].join("\n")

  // Compose semantic steer (opposite side) AFTER the structural body so cand1
  // both stays minimal AND targets the family cand0 missed.
  return semanticSeed !== undefined ? `${structuralSeed}\n\n${semanticSeed}` : structuralSeed
}
