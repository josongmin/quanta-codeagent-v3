/**
 * Counterfactual minimal-alternative seed builder (T-202).
 *
 * When candidate 0's patch trips the strict structural risk gate (cross-file,
 * new defs/classes, runtime-expanding calls, or an empty diff), candidate 1 is
 * generated with a *counterfactual minimal alternative* seed instead of the
 * generic owner-focus hint. This module turns the deterministic
 * {@link CandidateRiskFacts} contract into that BOUNDED text seed.
 *
 * It is a PURE projection: no full-diff re-injection, no timestamps, no random.
 * Both the reason bullets and the constraint bullets are CONDITIONAL on the
 * facts that actually fired, so the seed only ever asks the model to undo the
 * specific budget violations cand0 committed. If no structural reason fired the
 * builder returns `undefined` (self-guard) — the caller invokes it only after
 * the gate expanded, but the function never fabricates a counterfactual.
 *
 * Source of truth: {@link CandidateRiskFacts} (`./counterfactual-risk`).
 */

import type { CandidateRiskFacts } from "./counterfactual-risk"

const pluralFiles = (n: number): string => `${n} source file${n === 1 ? "" : "s"}`
const pluralDefs = (n: number): string => `${n} new def${n === 1 ? "" : "s"}/class`
const pluralCalls = (n: number): string => `${n} runtime-expanding call${n === 1 ? "" : "s"}`

export const buildCounterfactualSeed = (args: {
  readonly facts: CandidateRiskFacts
  /** primary owner file to focus cand1 on (overrides facts.ownerFiles[0]). */
  readonly ownerFile: string | undefined
}): string | undefined => {
  const { facts } = args

  const multiFile = facts.touchedSourceFiles > 1
  const hasNewDefs = facts.newDefs > 0
  const hasNewFiles = facts.newFiles > 0
  const hasRuntimeCalls = facts.runtimeExpandingCalls > 0
  const isEmpty = facts.emptyPatch === true

  // Self-guard: nothing structurally wrong ⇒ no counterfactual to produce.
  const fired = facts.crossFile || multiFile || hasNewDefs || hasNewFiles || hasRuntimeCalls || isEmpty
  if (!fired) return undefined

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

  return [
    "Candidate 0 was rejected/expanded for structural reasons:",
    ...reasonBullets,
    "",
    "Produce a counterfactual minimal alternative:",
    ...constraintBullets,
  ].join("\n")
}
