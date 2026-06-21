# T-SEL-06 — contract-first lexicographic selector

## Goal

Replace weighted-sum selection with deterministic lexicographic tiers. Executable proof decides first, then
public contract satisfaction, then candidate family / owner authority, and only then minimality.

## Files

- `src/agent/verification-bundle/score.ts`
- `src/agent/verification-bundle/types.ts`
- `tests/unit/verification-bundle-score.test.ts`
- `tests/unit/selection-executor.test.ts`

## Implementation

Selection order:

1. Admissible candidate only.
2. Stronger validated repro result:
   - higher `votes/k`.
   - valid payload beats `null`.
3. Executed keep-green result:
   - clean executed suite beats missing suite.
   - failed suite is inadmissible.
4. Public contract satisfaction:
   - more satisfied generic public contracts beats fewer.
   - required contract families beat symptom-only fits.
5. Candidate family / owner authority class:
   - `root-owner` / `api-owner` / `lifecycle-owner` can beat `symptom-owner` when executable proof is tied.
   - touching the required owner family beats drifting outside it.
6. Smaller patch:
   - fewer source files.
   - fewer added lines.
   - fewer new defs.
   - no new file.
7. Original candidate order as final deterministic tie-break.

Remove or demote these weighted soft scores from clean selection:

- `declaredExpectedMatch`.
- arbitrary rubric score.
- arbitrary ownerCoverage fraction.
- tuned minimality scalar.
- soft `voterQuorum` weight.

Do NOT confuse the soft `voterQuorum` weight with the executable repro consensus
in tier 2. Tier 2's `votes/k` is the EXECUTED `patchedResolvedKofN` result and
stays authoritative; only the tuned `voterQuorum` ranking weight in `score.ts` is
removed. This is the generic-majority-voting-vs-answer-key boundary: executed
consensus is legitimate SOTA selection, the tuned weight is not clean authority.

## Hellgate

- A candidate with better executable proof beats a smaller but unproven candidate.
- A candidate that satisfies the relevant public contract beats a smaller candidate that does not, when
  executable proof is tied.
- A smaller candidate beats a larger candidate only when executable proof, public contracts, and family
  authority are tied.
- `declaredExpectedMatch=true` cannot beat stronger executable proof.
- Tie-break is stable across repeated runs.

## Done

- No clean selector path depends on unexplained numeric weights.
- Clean selector winner traces show executable proof, contract satisfaction, family class, and minimality in
  that order.
- Unit tests cover tier ordering and tie stability.
