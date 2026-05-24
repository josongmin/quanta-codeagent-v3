/**
 * Reproduction-test generation — typed surface.
 *
 * Agentless paper §3.3.1 absorption. The paper synthesises a Python *test
 * file* (NOT a patch) from the issue text whose role is execution-based
 * ground truth: a candidate fix is correct IFF the test prints
 * "Issue resolved" after the fix is applied.
 *
 * The paper samples 40 candidates (1 greedy + 39 temp=0.8), executes each on
 * the ORIGINAL repo (no fix applied), filters to those that print
 * "Issue reproduced", normalises the source, and majority-votes the winner.
 * We adapt: K=5 default (1 greedy + 4 sample), everything else identical.
 *
 * Surface posture (pure-typed):
 *   - no I/O lives here; the slice's `generate.ts` / `execute.ts` modules do
 *     I/O via injected `LLMPort` and `exec` ports.
 *   - `ReproTestSample.outcome` is a CLOSED discriminated string union; no
 *     "fallback" outcome — if the marker line is absent we record `"unknown"`.
 *   - `ReproTestSelection.selected` is `string | null` so a "no sample
 *     reproduced" outcome is loud at the type level (vs an empty string
 *     which a downstream byte-writer would happily serialize).
 */

export interface ReproTestConfig {
  /**
   * How many test candidates to sample.
   *
   * Paper uses 40; for our sanity 5 is the default (1 greedy + 4 sample).
   * Domain: integer in [1, 40]. Out-of-range values are clamped at the
   * generator (NOT here — types stay permissive so callers can pass raw env
   * input and let the slice validate).
   */
  samples?: number
  /**
   * Sampling temperature for the non-greedy samples. Paper: 0.8.
   * The first sample is always greedy (temperature=0) — only `samples-1`
   * additional samples use this temperature.
   */
  temperature?: number
  /**
   * Per-sample LLM call timeout (ms). Default 30_000.
   */
  timeoutMs?: number
  /**
   * Per-test execution timeout (ms) when running the candidate on the
   * original repo. Default 60_000.
   */
  execTimeoutMs?: number
}

/** Outcome of executing one repro-test candidate on the original repo.
 *
 *   - `"reproduced"` — stdout contained "Issue reproduced" (bug present).
 *   - `"resolved"`   — stdout contained "Issue resolved" (bug already gone;
 *                       rare on the original repo — means the test is wrong
 *                       or the issue already silently fixed by HEAD).
 *   - `"other"`      — stdout contained "Other issues" (script ran but hit
 *                       unexpected error).
 *   - `"exec_failed"`— exec exited non-zero AND none of the marker lines
 *                       appeared. Either timeout (process killed) or hard
 *                       crash.
 *   - `"unknown"`    — exec succeeded (exit=0) but no marker line was found.
 *                       Either prompt malformed or LLM wrote a no-op script.
 *
 * Closed union; matching is exhaustive at every consumer. */
export type ReproTestOutcome = "reproduced" | "resolved" | "other" | "exec_failed" | "unknown"

export interface ReproTestSample {
  /** Generated Python test source (as the LLM emitted it, after markdown-
   *  fence stripping). */
  source: string
  /** Stdout from execution on the original repo. Captured verbatim (no
   *  trimming) so downstream debug can see exactly what the script printed. */
  stdout: string
  /** Outcome inferred from stdout. The last occurrence of a marker wins
   *  (so a script that says "Issue reproduced" then "Issue resolved" is
   *  classified `"resolved"`). */
  outcome: ReproTestOutcome
}

export interface ReproTestSelection {
  /**
   * The winning test source (the ORIGINAL — not normalised — source of the
   * most-frequent normalised group). `null` when no sample reproduced the
   * issue.
   */
  selected: string | null
  /** Every sample we generated, with its outcome. Returned even when
   *  `selected` is `null` — observability matters when the LLM consistently
   *  fails to reproduce. */
  samples: readonly ReproTestSample[]
  /** Count of samples that ended with outcome `"reproduced"`. Useful for
   *  observability: a low ratio is a red flag that the issue text is
   *  ambiguous or the LLM is confused. */
  reproducedCount: number
}
