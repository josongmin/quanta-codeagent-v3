/**
 * Counterfactual minimal-alternative seed builder (T-202 + T-CF-11).
 *
 * STRUCTURAL seed (T-202): when candidate 0's patch trips the strict structural
 * risk gate (cross-file, new defs/classes, runtime-expanding calls, or an empty
 * diff), candidate 1 is generated with a *counterfactual minimal alternative*
 * seed instead of the generic owner-focus hint. This module turns the
 * deterministic {@link CandidateRiskFacts} contract into that BOUNDED text seed.
 *
 * SEMANTIC seed (T-CF-11): structural minimality nudges cand1 toward a *smaller*
 * patch, which may be the wrong direction when cand0 did not satisfy a public
 * contract for a different candidate family (e.g. a symptom-owner cand0 that
 * missed a lifecycle-owner contract). In that case the seed surfaces the
 * unsatisfied family contract as an ADVISORY observation and asks the model to
 * weigh whether the root cause lives in THAT family — rather than asserting cand0
 * "fixed the wrong side". `buildSemanticCounterfactualSeed` produces that
 * family-considering seed, and `buildCounterfactualSeed` composes it on top of
 * the structural seed when a {@link SemanticCounterfactualDerivation} is supplied.
 *
 * It is a PURE projection: no full-diff re-injection, no timestamps, no random.
 * Both the reason bullets and the constraint bullets are CONDITIONAL on the
 * facts that actually fired. The seed is EVIDENTIAL, not directive: it surfaces
 * the specific structural facts about cand0's patch (and/or the unsatisfied
 * family contract) and asks the model to JUDGE whether a smaller in-place
 * alternative fully fixes the issue — keeping the broader change if it is
 * genuinely required. It never asserts a conclusion the model should reach
 * itself. If neither a structural reason nor a semantic target fired, the builder
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
    `Observation (advisory, issue-derived): a public contract for the ${family} family was not satisfied by candidate 0.`,
    `- consider whether the fix belongs at the ${family} site — ${FAMILY_INTENT[family]}`,
  ]
  if (derivation.targetFiles.length > 0) {
    const files = derivation.targetFiles.map((f) => `\`${f}\``).join(", ")
    lines.push(`- the ${family} family spans: ${files}; weigh whether the root cause lives there`)
  } else {
    lines.push(
      `- weigh whether the root cause lives in the ${family} family rather than only the symptom site`,
    )
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
        ? `- the owner file appears to be \`${owner}\`; if a smaller in-place edit there fully fixes the issue, prefer it`
        : "- if a smaller edit to fewer source files fully fixes the issue, prefer it",
    )
  }
  if (hasNewDefs || hasNewFiles) {
    constraintBullets.push(
      "- new helpers/classes/methods may not be necessary; weigh whether an in-place change suffices",
    )
  }
  if (hasRuntimeCalls) {
    constraintBullets.push(
      "- changing the existing control flow may not be necessary; weigh whether it can be preserved",
    )
    constraintBullets.push(
      "- runtime-expanding calls (compiler/IO/DB/subprocess) may not be necessary; weigh whether they can be avoided",
    )
  }
  constraintBullets.push(
    "- if the broader change is genuinely required to fix the issue, keep it and explain why",
  )
  if (isEmpty) {
    constraintBullets.push("- the patch must be non-empty and apply cleanly")
  }

  const structuralSeed = [
    "Candidate 0 was expanded/rejected by the structural risk gate. Facts about its patch:",
    ...reasonBullets,
    "",
    "Consider whether a smaller in-place alternative fully fixes the issue:",
    ...constraintBullets,
  ].join("\n")

  // Compose semantic steer (opposite side) AFTER the structural body so cand1
  // both stays minimal AND targets the family cand0 missed.
  return semanticSeed !== undefined ? `${structuralSeed}\n\n${semanticSeed}` : structuralSeed
}
