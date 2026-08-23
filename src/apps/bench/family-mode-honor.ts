/**
 * WHICH EXECUTION MODE CAN HONOR A DATASET FAMILY — one table, one refusal.
 *
 * `runMain` has two modes, and only one of them has a family axis at all:
 *
 *   official-dataset (`--swebench <file>`) — the family selects the corpus
 *     reader, the preflight, the verifier label and the grader. Fully honored.
 *   custom-corpus (no `--swebench`)        — reads a local corpus through
 *     `loadSelectedInstances`, which has no family parameter. It never calls the
 *     family's corpus reader, never runs its preflight, grades with the local
 *     `testCmd`, and deliberately does NOT stamp `datasetFamily` into the report
 *     (BFND-02: stamping one would fabricate identity for a corpus the family
 *     never selected).
 *
 * The problem this module fixes is that the family selector was still ACCEPTED
 * in the second mode, where exactly one of its effects survives: the composition
 * root seeds the execution preset from the family's `remoteDefaultPreset` BEFORE
 * the mode split, so the preset changes and nothing else does.
 *
 * Measured on the real CLI (aug-23, 3/3 reproducible):
 *
 *   run --dry-run --limit 1                           -> agentless-v3-thin-strict
 *   run --dataset-family promax --dry-run --limit 1   -> agentless-v1
 *
 * Same corpus, same grading, same (honest) `verified` report label — different
 * agent. An operator who puts that flag on one arm of a local A/B gets a
 * different preset on that arm with nothing in the plan or the report disclosing
 * why. The dry-run in this mode does not even print a family line, so the flag
 * looks inert while it is not.
 *
 * Refusing is the honest encoding, and it matches the guarantee the flag already
 * advertises for its VALUE ("an explicit unknown/blank family is REFUSED, never
 * silently defaulted — a typo must not grade one corpus with another's
 * harness"). This extends that from the value to the APPLICABILITY. An operator
 * who genuinely wanted the other preset says so with `--preset`, which is the
 * knob that actually means it.
 *
 * PURE: no env, no argv, no I/O. The composition root passes the mode it chose.
 */
import type { DatasetFamily } from "./dataset-family-token"
import type { DatasetFamilySelector } from "./run-config"

/** The two modes `runMain` dispatches between. Closed on purpose — see the
 *  drift guard in the test: a third mode must classify itself below. */
export const BENCH_EXECUTION_MODES = ["official-dataset", "custom-corpus"] as const

export type BenchExecutionMode = (typeof BENCH_EXECUTION_MODES)[number]

/**
 * Whether the mode reads a SWE dataset through the family's own ports — i.e.
 * whether a family selector means anything there.
 *
 * A `Record` over the closed union rather than a predicate with a default: a
 * mode added later fails to compile until someone decides which side it is on,
 * instead of silently inheriting "honored" and reopening this hole.
 */
export const MODE_HONORS_FAMILY: Record<BenchExecutionMode, boolean> = {
  "official-dataset": true,
  "custom-corpus": false,
}

/**
 * Refuse an EXPLICIT family selector in a mode that cannot honor it.
 *
 * An ABSENT selector is always fine: it resolves to the legacy `verified`
 * default, which is what every family-less caller has always gotten, and
 * refusing it would break every plain `quanta-bench run`.
 */
export const assertFamilySelectorHonored = (input: {
  readonly mode: BenchExecutionMode
  readonly familySelector: DatasetFamilySelector
  readonly datasetFamily: DatasetFamily
}): void => {
  if (input.familySelector !== "explicit") return
  if (MODE_HONORS_FAMILY[input.mode]) return
  throw new Error(
    `bench: --dataset-family ${input.datasetFamily} cannot be honored by the ` +
      `${input.mode} mode, which reads no SWE dataset. That mode loads a local corpus ` +
      `directly, so the family's corpus reader, preflight, verifier and grader are all ` +
      `bypassed and the report is labelled "verified" — but the family HAS already ` +
      `changed the execution preset, so accepting it would silently give this run a ` +
      `different agent than an otherwise identical one. REFUSING rather than applying ` +
      `a family halfway. Pass --swebench <dataset file> to run the ${input.datasetFamily} ` +
      `corpus for real, or --preset <name> if the execution preset is what you meant.`,
  )
}
