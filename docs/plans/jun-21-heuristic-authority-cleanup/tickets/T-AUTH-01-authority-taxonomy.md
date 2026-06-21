# T-AUTH-01 — authority taxonomy and selector contract

## Goal

Define a closed selector authority taxonomy so clean presets cannot accidentally promote heuristics into hard
admission or hard veto.

## Files

- `src/agent/verification-bundle/types.ts`
- `src/agent/verification-bundle/score.ts`
- `tests/unit/verification-bundle-score.test.ts`
- optional: `src/agent/verification-bundle/authority.ts`

## Implementation

- Add an explicit authority classification for every signal consumed by the selector:
  - `hardExecutable`
  - `hardStructural`
  - `contractDominance`
  - `familyOrdering`
  - `softTieBreak`
  - `observeOnly`
  - `researchOnly`
- Keep allowed clean hard signals narrow:
  - empty patch.
  - `applyClean=false`.
  - validated repro quorum failure.
  - executed keep-green failure from a non-oracle witness suite.
- Disambiguate the two quorum signals that share a name (common implementer trap):
  - `patchedResolvedKofN` (`votes/k`) is an EXECUTED repro consensus result and
    stays `hardExecutable`.
  - the weighted soft `voterQuorum` score in `score.ts` is NOT the same signal; it
    is a tuned ranking weight, demoted to `softTieBreak` at most and removed from
    clean ranking (see T-SEL-06).
  - a test must pin that removing the soft `voterQuorum` weight does not touch the
    executable `votes/k` tier, and vice versa.
- Justify the quorum threshold `k` itself:
  - `k` is a numeric cutoff and is subject to the same magic-threshold rule as any
    other (`>= 3`, `+50`, `DEFAULT_MAX_TESTS=12`).
  - record `k`'s provenance in the authority SSOT: why this value, and whether it
    cleared a stage-3 holdout (T-MEASURE-08). A `k` with no provenance note fails
    the authority-classification test the same way an unclassified signal does.
- Mark these as non-clean authority:
  - `declaredExpectedMatch`.
  - issue smoke.
  - discovered regression rank.
  - LLM rubric.
  - soft `voterQuorum` weight.
  - patch/file-path regex.
- Classify generic public contracts separately from hard veto:
  - they may dominate ranking before minimality.
  - they do not become hidden weighted soft scores.
- Classify candidate family evidence separately from hard veto:
  - it may shape exploration and tie-breaks.
  - it cannot reject without executable counter-evidence.
- Make the selector reject unknown hard signal kinds in tests.

## Hellgate

- A new hard signal without classification fails a unit test.
- A `hardExecutable` numeric threshold (including quorum `k`) without a provenance
  note fails the same classification test.
- Removing the soft `voterQuorum` weight leaves the executable `votes/k` tier
  byte-identical (paired test in both directions).
- `declaredExpectedMatch=false` cannot make a candidate inadmissible in clean mode.
- `smokeGreen=false` cannot make a candidate inadmissible in clean mode.
- `regressionGreen=false` remains hard only when the source is an executed clean witness suite.
- Public contract satisfaction is ordered before minimality in clean mode.

## Done

- Unit tests pin every authority kind.
- Clean mode and research mode are explicitly separate in the selector API.
- No clean selector caller can pass heuristic signals as hard gates without naming the mode.
