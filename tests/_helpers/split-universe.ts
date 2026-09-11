/**
 * `tests/_helpers/split-universe` — the register of exhaustive fixtures that
 * were split into a PR boundary canary and a nightly exhaustive sibling, and
 * the property that makes such a split honest.
 *
 * # The property
 *
 * For every split fixture:
 *
 *     canary ids  ∪  nightly ids  ==  the pre-split universe
 *     canary ids  ∩  nightly ids  ==  ∅
 *
 * A split that loses a case is a deletion that looks like an optimisation, and
 * it looks like one for months, because the case that vanished is by
 * construction the one nobody was watching. A split that DUPLICATES a case is
 * the defect this ticket started from — `bench-write-artifacts` ran three times
 * in a cold full because two lanes both claimed it.
 *
 * # Why the ids are read out of the test files
 *
 * A registry that simply listed what each lane runs would be a claim about the
 * files, maintained by hand, and the first edit to a test file would make it
 * false silently. So each case carries its id INSIDE its test title, as
 * `[case:<id>]`, and the guard parses the two real files and compares what they
 * declare against the recorded universe. Moving a case between lanes, deleting
 * one, or writing one into both is then a RED with the id named.
 *
 * # `added` is not part of the universe
 *
 * A boundary canary written to replace an exhaustive case is NEW — it did not
 * exist before the split, so it is not a member of the pre-split universe and
 * must not be counted as covering one. It is recorded separately, with the
 * MINIMUM it keeps and WHY that minimum is the smallest thing that still fails
 * when the regression it guards comes back. A canary that no longer catches the
 * allocation it was written for is a deletion wearing a new name.
 */

export interface AddedCanary {
  /** `[case:<id>]` as it appears in the canary file's test title. */
  readonly id: string
  /** The smallest fixture the canary keeps, in the units that matter. */
  readonly minimum: string
  /** Why that is the minimum — which regression stops failing below it. */
  readonly why: string
}

export interface SplitFixture {
  /** Stable name of the split. */
  readonly id: string
  /** Repo-relative path of the lane that runs in PR/prepush. */
  readonly canaryFile: string
  /** Repo-relative path of the `*.nightly.test.ts` sibling. */
  readonly nightlyFile: string
  /** Case ids that existed BEFORE the split. Every one must still run. */
  readonly universe: readonly string[]
  /** New boundary canaries, with their minimum size and its justification. */
  readonly added: readonly AddedCanary[]
  /**
   * The measured cost the split exists to move, named so a later change that
   * re-inflates the PR lane is visible as a number rather than a feeling.
   *
   * `kind` matters: these fixtures are not all heavy in the same currency. The
   * notebook caps are a MEMORY problem (300 ms of wall time, 620 MiB of peak
   * RSS) and the PTY quiet window is a REAL-TIME one (16 s of pure waiting in a
   * suite whose wall time is otherwise dominated by process boots). Recording
   * "peak RSS" for the second would be a number that did not move.
   */
  readonly cost: {
    readonly kind: "peak-rss-mib" | "awaited-sleep-ms"
    /** What the runtime costs before the fixture does anything, if meaningful. */
    readonly baseline?: number
    readonly beforeSplit: number
    readonly canary: number
    readonly nightly: number
  }
}

export const SPLIT_FIXTURES: readonly SplitFixture[] = [
  {
    id: "ipynb-render-document-caps",
    canaryFile: "tests/unit/ipynb-cell-read-render-hellgate.test.ts",
    nightlyFile: "tests/unit/ipynb-render-document-caps.nightly.test.ts",
    universe: ["doc-cap-200k-cells", "doc-cap-50k-outputs", "doc-cap-at-cell-cap"],
    added: [
      {
        id: "doc-cap-cells-boundary",
        minimum: "MAX_NOTEBOOK_CELLS + 1 = 5001 cells",
        why:
          "the cap is an equality, so the smallest input that can distinguish 'capped' " +
          "from 'not capped' is exactly one cell past it: at 5000 both a capping and a " +
          "non-capping render emit 5000 headers. The canary asserts the header COUNT and " +
          "the exact `1 more cell(s) elided` text rather than a length threshold — a " +
          "length threshold is what made the 200k version need 200k cells to fail.",
      },
      {
        id: "doc-cap-outputs-boundary",
        minimum: "MAX_OUTPUTS_PER_CELL + 1 = 65 outputs, each at the 2000-char output cap",
        why:
          "same equality argument for the per-cell output cap, and the 2000 chars are " +
          "kept because the per-output cap and the per-cell cap interact: an output " +
          "narrower than `maxOutputChars` would let a render that applies only the " +
          "character cap pass.",
      },
    ],
    cost: { kind: "peak-rss-mib", baseline: 53, beforeSplit: 621, canary: 110, nightly: 600 },
  },
  {
    id: "goal-quiet-window-real-time",
    canaryFile: "tests/e2e-pty/cli-goal-pursuit-e2e.test.ts",
    nightlyFile: "tests/e2e-pty/cli-goal-quiet-window.nightly.test.ts",
    universe: ["goal-attach-cancels-pending-continuation"],
    added: [
      {
        id: "goal-attach-typed-decision",
        minimum:
          "the same three-process scenario (`attachToSecondThread`), with zero seconds of " +
          "waiting — the observable state only",
        why:
          "the scenario is the minimum, not the wait: what regresses first when `/fork " +
          "attach` stops re-pointing the surface objective store is that the attached " +
          "session still reports thread A's goal, and that is visible the instant the " +
          "attach completes. The 16 s adds only the temporal half — that A's already-armed " +
          "timer stays quiet across a full window — for which the CLI exposes no typed " +
          "decision at all, so it cannot be shortened and is the one real-time canary.",
      },
    ],
    cost: { kind: "awaited-sleep-ms", beforeSplit: 22_650, canary: 6_600, nightly: 16_000 },
  },
]

/** Every id any lane of any split fixture is expected to declare. */
export const splitUniverseIds = (): readonly string[] =>
  SPLIT_FIXTURES.flatMap((fixture) => fixture.universe)
