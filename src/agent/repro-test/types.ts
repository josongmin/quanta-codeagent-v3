/**
 * Reproduction-test generation — typed surface.
 *
 * Agentless paper §3.3.1 absorption. The paper synthesises a Python *test
 * file* (NOT a patch) from the issue text whose role is execution-based
 * ground truth. P1 (jun-23) makes the test a real PYTEST test: a candidate fix
 * is correct IFF the test's assertions PASS under pytest after the fix is
 * applied (exit 0), and the bug is present IFF they FAIL on the base tree
 * (pytest exit≠0 / "N failed"). The verdict is pytest's exit semantics, NOT a
 * model-printed sentinel string (which the model authored and could fake).
 *
 * The paper samples 40 candidates (1 greedy + 39 temp=0.8), executes each on
 * the ORIGINAL repo (no fix applied), filters to those whose assertions FAIL
 * (outcome "reproduced"), normalises the source, and majority-votes the winner.
 * We adapt: K=5 default (1 greedy + 4 sample), everything else identical.
 *
 * Surface posture (pure-typed):
 *   - no I/O lives here; the slice's `generate.ts` / `execute.ts` modules do
 *     I/O via injected `LLMPort` and `exec` ports.
 *   - `ReproTestSample.outcome` is a CLOSED discriminated string union; no
 *     "fallback" outcome — if pytest collected no test items we record
 *     `"unknown"`.
 *   - `ReproTestSelection.selected` is `string | null` so a "no sample
 *     reproduced" outcome is loud at the type level (vs an empty string
 *     which a downstream byte-writer would happily serialize).
 */

/**
 * The KIND of a reproduction-test candidate (jun-23 canonical/hardening split).
 *
 *   - `"canonical"`  — exercises the issue's CORE symptom ONLY. The minimal
 *                       correct fix MUST be able to flip it to "Issue resolved".
 *                       NO adversarial over-strictness, NO "every incidental
 *                       case must pass". THIS is the submit-gate oracle (the set
 *                       the proof gate calibrates + gates on).
 *   - `"hardening"`  — the adversarial edge/boundary/must-reject cases. ADVISORY
 *                       ONLY: used for selection tie-break + repair seeding. It
 *                       must NEVER block submit / withhold a correct candidate.
 *
 * MEASURED ROOT CAUSE (jun-23): an adversarial repro that asserts MANY incidental
 * cases is a 75% gold false-NEGATIVE — applying the canonical-correct gold fix
 * leaves it RED 3/4 of the time. Folding that over-strictness into the SUBMIT
 * oracle made `agentless-v4-proof-clean` structurally unwinnable. Splitting the
 * concern keeps the submit gate on the core symptom (low FN) and demotes the
 * adversarial coverage to advisory.
 *
 * Closed union; matching is exhaustive at every consumer. */
export type ReproTestKind = "canonical" | "hardening"

/** A generated reproduction-test candidate tagged with its {@link ReproTestKind}.
 *  The `source` is the LLM-emitted Python (post fence-strip). Carrying the kind
 *  on the candidate is what lets the driver route ONLY the canonical reproducing
 *  set into the submit-gate oracle (calibration + proof gate), while hardening
 *  candidates stay advisory. */
export interface ReproTestCandidate {
  readonly kind: ReproTestKind
  readonly source: string
}

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
 * P1 (jun-23): the verdict is now EXECUTION-GROUNDED — derived from pytest's
 * process exit code + summary line (`classifyPytest`), NOT a model-printed
 * sentinel. The union is UNCHANGED; only HOW each value is computed changed, so
 * downstream consumers (driver, calibration, vote) are byte-stable.
 *
 *   - `"reproduced"` — a pytest assertion FAILED on the base tree (summary
 *                       "N failed"). The bug is present / red. The minimal
 *                       correct fix should flip this to "resolved".
 *   - `"resolved"`   — pytest PASSED (summary "N passed", no failures). The
 *                       expected behaviour held — green. On the ORIGINAL repo
 *                       this is rare (means the test is wrong or HEAD already
 *                       fixed it).
 *   - `"other"`      — pytest itself errored indeterminately (internal/usage
 *                       error, exit 3/4) — ran, but produced a result distinct
 *                       from a clean pass/fail. Meaningful, not a catch-all.
 *   - `"exec_failed"`— the test could not be RUN: a collection / setup /
 *                       fixture error (summary "N error[s]"), a top-level import
 *                       crash (project not importable — no summary, exit≠0),
 *                       syntax error, or a timeout-kill. Infra, NOT a verdict.
 *   - `"unknown"`    — pytest collected no test items ("no tests ran" / exit 5),
 *                       or ran cleanly (exit 0) with no test signal at all.
 *                       Either the prompt was malformed or the LLM emitted a
 *                       no-op (no `def test_*`).
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
  /** Stderr from execution. Captured so an `exec_failed` outcome can be
   *  attributed (ModuleNotFoundError ⇒ project not importable in the exec env;
   *  SyntaxError ⇒ bad LLM script; nothing ⇒ timeout) AND so `classifyPytest`
   *  can see a pytest summary that landed on stderr. Empty string when the exec
   *  port reported no stderr or threw before producing any. */
  stderr?: string
  /** Outcome derived from pytest exit semantics (exit code + summary line) by
   *  `classifyPytest` — NOT from a model-printed sentinel. A failing assertion
   *  ⇒ "reproduced"; a clean pass ⇒ "resolved"; a collection/setup error ⇒
   *  "exec_failed"; no collected tests ⇒ "unknown". */
  outcome: ReproTestOutcome
  /** jun-23 canonical/hardening split. Defaults to `"canonical"` when the
   *  generator did not tag a kind (back-compat: the legacy single-set path is
   *  the submit-gate / canonical oracle). HARDENING samples are advisory and
   *  MUST NOT be routed into the submit-gate oracle. */
  kind?: ReproTestKind
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
