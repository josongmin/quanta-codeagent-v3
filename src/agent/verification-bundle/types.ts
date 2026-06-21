/**
 * T0 — VerificationBundle contract (verify-and-select Phase 1).
 *
 * The shared TYPES that the three Phase-1 tracks build to (regression oracle,
 * resolved K-of-N consensus, soft rubric). The bundle is the *outer control
 * plane's* verdict authority: given a candidate patch's signals it decides
 * whether the candidate is ADMISSIBLE (provably-correct tier) and assigns a
 * soft SCORE for ranking. `selectBest` picks among candidates.
 *
 * North-star invariant (corrected): **no single noisy oracle holds global
 * verdict authority.** The encoding of that invariant here is the
 * `null = FAIL-OPEN` rule on every signal that can be unavailable:
 *
 *   - A `null` signal NEVER rejects a candidate (absence of evidence is not
 *     evidence of badness — rejecting on a missing signal is the false-RED
 *     self-sabotage we are removing).
 *   - Only an explicit `false` / insufficient hard signal makes a candidate
 *     inadmissible.
 *   - When NO candidate is admissible, the caller may still keep a constrained
 *     best-effort candidate for reporting/submission, but MUST NOT silently
 *     resubmit a candidate that already has explicit negative evidence such as a
 *     regression failure or a known bad patched-side resolved verdict.
 *
 * No oracle leak: these types name no official SWE-bench hidden field
 * (FAIL_TO_PASS / PASS_TO_PASS / test_patch). The regression signal is a bare
 * boolean produced by a bench adapter behind the eval-only boundary; the
 * engine only ever sees `regressionGreen: boolean | null`. Likewise the smoke
 * signal is only the public-script keep-green boolean, never the hidden oracle.
 */

export interface ResolvedKofNSignal {
  votes: number
  k: number
}

/**
 * HARD gates — AND-combined, each REJECTS only on explicit negative evidence.
 * Nullable members are FAIL-OPEN (null ⇒ treated as "no objection").
 */
export interface HardGateSignals {
  /** The reproduction reproduced RED on the un-patched tree (a valid failing
   *  baseline exists). `false` ⇒ no validated repro authority for this
   *  instance ⇒ candidate not in the provable tier (falls to best-effort).
   *  `null` ⇒ this selection mode does not require repro authority
   *  (FAIL-OPEN), e.g. no-oracle discovered-regression gating. */
  baseValidatedRed: boolean | null
  /** The candidate generation produced a non-empty diff. `false` ⇒ no fix was
   *  produced, so the candidate is never admissible. */
  patchProduced: boolean
  /** Patched-side resolved K-of-N consensus (TC): `votes` scripts of the
   *  reproducing set now print "Issue resolved", quorum `k`. `null` ⇒ no
   *  consensus run (FAIL-OPEN). Present but malformed (`votes < 0`, `k <= 0`,
   *  non-integer payload) ⇒ FAIL-CLOSED because the hard authority packet is
   *  corrupted. Admissible iff the payload is valid and `votes >= k`. */
  patchedResolvedKofN: ResolvedKofNSignal | null
  /** Impacted-test regression result (TB): `true` = the candidate breaks no
   *  existing test, `false` = it regressed at least one. `null` ⇒ no test set
   *  / oracle unavailable (FAIL-OPEN — a missing regression run must never
   *  reject a candidate). */
  regressionGreen: boolean | null
  /** Public issue-smoke result: a base-green issue MWE (or its cheap public
   *  smoke surrogate) stays green on the patched tree. `false` = the candidate
   *  broke a public import/hot-path smoke that was known green on base.
   *  `null` ⇒ no trustworthy smoke source existed or the probe could not run
   *  (FAIL-OPEN — a missing smoke run must never reject a candidate). */
  smokeGreen: boolean | null
  /** The candidate diff applied cleanly to the sandbox. `false` ⇒ a patch that
   *  does not apply is never admissible. `null` ⇒ applyability was not probed
   *  / could not be judged (FAIL-OPEN). */
  applyClean: boolean | null
}

/**
 * SOFT signals — weighted into a ranking SCORE (never an admissibility gate).
 * Each is `null` when unavailable and contributes nothing in that case.
 */
export interface SoftScoreSignals {
  /** The patched output matches the issue's declared-expected behaviour. */
  declaredExpectedMatch: boolean | null
  /** Execution-free rubric score in [0,1] (Phase 2 verifier). */
  rubricScore: number | null
  /** Fraction of adversarial voters that did NOT refute, in [0,1]. */
  voterQuorum: number | null
  /** Minimality of the diff in [0,1] (1 = smallest) — prefers focused fixes. */
  minimality: number | null
  /** Fraction of the candidate's edits landing on localization-owner files. */
  ownerCoverage: number | null
}

/** Per-candidate verdict: provable-tier flag + ranking score + explanation. */
export interface CandidateVerdict {
  /** True ⇒ every hard gate is satisfied (or fail-open). */
  admissible: boolean
  /** Soft ranking score (weighted sum of available soft signals). */
  score: number
  /** Human-readable reasons (which gate rejected / which soft signals fired). */
  reasons: string[]
}

/** A candidate id paired with its bundle verdict, for {@link selectBest}. */
export interface ScoredCandidate {
  id: string
  verdict: CandidateVerdict
}
