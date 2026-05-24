/**
 * ADR-0131 — Stage1 → Phase2 promotion gate.
 *
 * Selects which Stage1 entries are promoted to the Phase 2 consolidator.
 * Codex's production stat: ~10% pass rate ("memory promotion rate").
 * Our default `sampleRate` mirrors that.
 *
 * Decision rules (in order):
 *   1. HARD GATE — outcome === 'fail' is **excluded unconditionally**.
 *      A failing outcome means proof contradicted the claim; promoting it
 *      to the cross-session synthesizer would pollute reusable knowledge.
 *   2. SCORE — each surviving entry earns:
 *        +2  if outcomeEvidence is a non-empty string (anchor present)
 *        +1  if preferenceSignals has length > 0 (the entry carries a
 *            user-attributable phrase, which is the highest-value signal
 *            per ADR-0131 §Problem.2)
 *      Range: 0..3. No other contributors — strictly validated signals
 *      per [[no-heuristics-only-validated]].
 *   3. TIEBREAK — score DESC, then sourceUpdatedAt DESC (younger first).
 *   4. CAP — top `floor(sampleRate * total)` entries.
 *
 * Pure function. **Deterministic**: same input slice → byte-identical
 * output. No clock, no RNG, no I/O. The caller passes the slice; this
 * file does not read the store.
 */

import type { MemoryOutcome, Stage1Output } from "./types"

/** Options for {@link selectForPhase2Promotion}. All fields optional;
 *  defaults mirror Codex production. */
export interface SelectForPhase2PromotionOpts {
  /**
   * Fraction of input entries to promote, in [0, 1]. Default `0.1` matches
   * Codex's measured 10% promotion rate. The cap is `Math.floor(rate *
   * total)` — `rate * total < 1` selects ZERO entries (we never round up
   * to "at least 1" because that creates a 100% promotion in test fixtures
   * of size 1-9 which masks regressions).
   */
  readonly sampleRate?: number
}

/** Default promotion rate — Codex production stat. */
const DEFAULT_SAMPLE_RATE = 0.1

/** Outcomes that DISQUALIFY an entry from promotion regardless of score.
 *  Centralized to avoid a magic string in the filter; new disqualifiers
 *  (V2: 'tainted', 'corrupt'?) would be added here. */
const DISQUALIFYING_OUTCOMES: ReadonlySet<MemoryOutcome> = new Set<MemoryOutcome>(["fail"])

/** Score one entry per the §2 rule table. Pure; safe to call N×. */
const scoreEntry = (e: Stage1Output): number => {
  let s = 0
  if (typeof e.outcomeEvidence === "string" && e.outcomeEvidence.length > 0) s += 2
  if (e.preferenceSignals.length > 0) s += 1
  return s
}

/**
 * Select the top fraction of {@link Stage1Output} entries for Phase 2
 * promotion per the ADR-0131 §3 contract. Deterministic; pure.
 *
 * Input is not mutated (entries are sorted into a fresh array).
 *
 * @param entries Candidate Stage1 entries (Phase 1 outputs awaiting
 *                consolidation). Empty input → empty output.
 * @param opts   See {@link SelectForPhase2PromotionOpts}.
 * @returns       Subset of `entries`, ordered by promotion score DESC
 *                then sourceUpdatedAt DESC; length is `floor(sampleRate *
 *                entries.length)` (may be 0). The returned array is fresh
 *                — caller may mutate.
 */
export const selectForPhase2Promotion = (
  entries: readonly Stage1Output[],
  opts: SelectForPhase2PromotionOpts = {},
): Stage1Output[] => {
  // Defensive: a null/undefined slip from a hand-wired call site shouldn't
  // crash the consolidator hook. Empty input is a normal "nothing to
  // promote" outcome, not an error.
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rawRate = opts.sampleRate
  // Validate the rate. `NaN`, negatives, or > 1 are treated as the
  // default — silently clamping to a value the caller didn't ask for
  // would mask configuration bugs, so we fall back to the documented
  // default and rely on caller's tests to catch the typo.
  const rate =
    typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate >= 0 && rawRate <= 1
      ? rawRate
      : DEFAULT_SAMPLE_RATE

  // 1. Filter — disqualifying outcomes are out unconditionally.
  const eligible: Stage1Output[] = []
  for (const e of entries) {
    if (e.outcome !== undefined && DISQUALIFYING_OUTCOMES.has(e.outcome)) continue
    eligible.push(e)
  }
  if (eligible.length === 0) return []

  // 2. Score + sort. We pre-compute scores once per entry so the
  //    comparator doesn't recompute them O(n log n) times.
  const scored: { entry: Stage1Output; score: number }[] = eligible.map((entry) => ({
    entry,
    score: scoreEntry(entry),
  }))
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    // tiebreak — younger (larger sourceUpdatedAt) first
    return b.entry.sourceUpdatedAt - a.entry.sourceUpdatedAt
  })

  // 3. Cap — `floor(rate * total)`. We base the cap on the ORIGINAL input
  //    length (entries.length), not the post-filter eligible.length — this
  //    keeps the promotion-rate metric directly comparable to the Codex
  //    "% of total stage1 rows promoted" stat and prevents a 'fail'-heavy
  //    corpus from over-promoting the few survivors.
  const cap = Math.floor(rate * entries.length)
  if (cap <= 0) return []
  return scored.slice(0, cap).map((s) => s.entry)
}
