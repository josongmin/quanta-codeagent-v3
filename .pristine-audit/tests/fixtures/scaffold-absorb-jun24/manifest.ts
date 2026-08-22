/**
 * T0 — Frozen canonical receipts + slice manifest for the jun-24 scaffold SOTA
 * absorption plan (`docs/plans/jun-24-scaffold-sota-absorption-latest-code.md`).
 *
 * Purpose: a MEASUREMENT FOUNDATION, not a fix. This module records two things,
 * both frozen before any T1/T2 treatment runs:
 *
 *  1. The OBSERVED failure SHAPE of the three canonical our-only fails (the files
 *     OUR submitted patch touched + a post-hoc failure-class label).
 *  2. The frozen instance-id slices the promotion protocol consumes (per-lever
 *     target, broad medium/no-regression control).
 *
 * ANSWER-KEY FENCE (hard, enforced by `tests/unit/scaffold-absorb-jun24-baseline.test.ts`):
 *  - These fixtures record ONLY our own observed patch shape + a classification
 *    label. They DO NOT carry a gold patch, a PR diff, or the gold's specific
 *    "the missing file is X" ground truth. The selector mechanism characterization
 *    is proven with fully SYNTHETIC files (see the baseline test), so nothing here
 *    or there can leak the answer key into a live coverage contract.
 *  - The failure-class label is a post-hoc receipt classification (why the graded
 *    patch was incomplete), never an input fed to a live run.
 *
 * Frozen at 2026-06-24. Editing the slices to fit a later result silently voids
 * the promotion win (see the plan's promotion protocol).
 */

/** Post-hoc classification of WHY a graded patch missed. NOT a live input. */
export type FailureClass =
  | "missing-required-owner-file"
  | "missing-existing-test-expectation"
  /** Our agent edited the right sites in a FORK worktree but the final diff was
   *  extracted from a different tree ⇒ 0-byte submission. Infra/plumbing, not a
   *  methodology gap. Owned by T5 (patch capture), NOT T1 (coverage contract). */
  | "fork-worktree-empty-capture"

export interface ObservedFailFixture {
  /** SWE-bench instance id. */
  readonly instanceId: string
  /** Files OUR submitted patch touched, from our own receipt. Gold-independent. */
  readonly ourPatchTouchedFiles: readonly string[]
  /** Post-hoc class of the incompleteness. Derived from our receipt + grading
   *  observation, never from the gold patch / PR diff. */
  readonly expectedFailureClass: FailureClass
  /** Audit note. MUST NOT name the gold's missing files or carry diff text. */
  readonly note: string
}

/**
 * The three canonical our-only fails, recorded as observed single-file (or
 * single-owner) shapes. The touched-file lists are exactly what we submitted —
 * the "false winner" we accepted — not what the answer key wanted.
 */
export const CANONICAL_FAIL_FIXTURES: readonly ObservedFailFixture[] = [
  {
    instanceId: "django__django-14315",
    ourPatchTouchedFiles: ["django/db/backends/postgresql/client.py"],
    expectedFailureClass: "missing-required-owner-file",
    note:
      "We submitted a single producer-side file; grading exercised a sibling/base " +
      "client site our patch never touched. Shape = producer-only owner coverage.",
  },
  {
    instanceId: "django__django-11138",
    // CORRECTED (2026-06-24 adversarial audit, REPORT line 58, 3-source confirmed):
    // our graded submission was a 0-byte EMPTY patch. The agent made 108 edits to
    // the correct sites + ran pytest 6× IN A FORK WORKTREE, but the final diff was
    // extracted from a different tree. `mysql/operations.py` is a GOLD file we did
    // NOT submit — it must never appear here (gold-as-ours trap).
    ourPatchTouchedFiles: [],
    expectedFailureClass: "fork-worktree-empty-capture",
    note:
      "Empty 0-byte submission from a fork-worktree extraction bug. Localize + " +
      "test-oracle already worked (M3/M5). Infra capture failure (T5), NOT a " +
      "coverage-contract or methodology miss.",
  },
  {
    instanceId: "astropy__astropy-13033",
    ourPatchTouchedFiles: ["astropy/timeseries/core.py"],
    expectedFailureClass: "missing-existing-test-expectation",
    note:
      "Non-empty patch in the right file; the miss is spec / exact-message " +
      "fidelity against an existing test expectation, not file coverage.",
  },
] as const

/**
 * The broad regression slice the no-regression control + medium confirmation
 * gates run on. Seeded from the already-wired SWE-bench smoke `picks-10`. The
 * baseline test asserts this stays in sync with `tests/smoke/swebench/picks-10.jsonl`
 * (drift guard) and stays disjoint from the target cases (a target win can never
 * be laundered as a control pass).
 */
export const BROAD_REGRESSION_SLICE: readonly string[] = [
  "psf__requests-5414",
  "pallets__flask-5014",
  "sympy__sympy-13480",
  "pylint-dev__pylint-4970",
  "pytest-dev__pytest-7982",
  "sympy__sympy-16886",
  "sphinx-doc__sphinx-8595",
  "pylint-dev__pylint-8898",
  "pytest-dev__pytest-5787",
  "sympy__sympy-12489",
] as const

/**
 * Frozen slice manifest. Pinned before T1/T2 treatment. Each lever measures only
 * the slice it claims to fix; `medium` and `control` guard against overfitting
 * the targeted three.
 */
export const FROZEN_SLICE_MANIFEST = {
  frozenAt: "2026-06-24",
  /** Per-lever target slices (must match the plan's promotion protocol). */
  target: {
    /** T1 coverage-as-contract. 11138 was REMOVED here (it is an empty-capture
     *  infra bug, not a coverage miss — see the 11138 fixture). */
    coverageContract: ["django__django-14315"],
    /** T2 existing-test expectation discovery. */
    specFidelity: ["astropy__astropy-13033"],
    /** T3 bounded deeper_localize occupant. */
    deeperLocalize: ["django__django-14315"],
    /** T5 patch-capture correctness (fork-worktree extraction). */
    captureCorrectness: ["django__django-11138"],
  },
  /** Broad confirmation slice run after the targeted smoke. */
  medium: BROAD_REGRESSION_SLICE,
  /** No-regression control. A treatment that regresses any of these is rejected. */
  control: BROAD_REGRESSION_SLICE,
} as const

/** Every distinct target instance id across all levers. */
export const ALL_TARGET_INSTANCE_IDS: readonly string[] = [
  ...new Set([
    ...FROZEN_SLICE_MANIFEST.target.coverageContract,
    ...FROZEN_SLICE_MANIFEST.target.specFidelity,
    ...FROZEN_SLICE_MANIFEST.target.deeperLocalize,
    ...FROZEN_SLICE_MANIFEST.target.captureCorrectness,
  ]),
]

/** Substrings that would indicate a gold patch / PR diff leaked into a fixture. */
const ANSWER_KEY_MARKERS: readonly string[] = [
  "diff --git",
  "@@ -",
  "@@ +",
  "\n+++ b/",
  "\n--- a/",
  "goldPatch",
  "gold_patch",
  "test_patch",
  "PASS_TO_PASS",
  "FAIL_TO_PASS",
]

/**
 * Red-on-injection guard: throws if a fixture's serialized form carries any
 * answer-key marker (a leaked gold patch / PR diff / hidden-oracle field). Pure;
 * used by the baseline test and importable by T1/T2 so they cannot regress the
 * fence.
 */
export const assertNoAnswerKey = (fixture: ObservedFailFixture): void => {
  const serialized = JSON.stringify(fixture)
  for (const marker of ANSWER_KEY_MARKERS) {
    if (serialized.includes(marker)) {
      throw new Error(
        `answer-key marker "${marker}" found in fixture ${fixture.instanceId}: ` +
          "fixtures must record observed shape only, never a gold patch / PR diff.",
      )
    }
  }
}
