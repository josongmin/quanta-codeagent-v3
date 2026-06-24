# T1 implementation plan — co-change coverage as real submit authority

Grounded in the T0 baseline (`tests/unit/scaffold-absorb-jun24-baseline.test.ts`)
and the candidate-family wiring map. This is the structurally-correct scope after
discovering the tagging wiring already exists.

## VERIFIED OUTCOME (post-implementation — read this first)

The "close the best-effort leak" lever (item 4 below) was IMPLEMENTED, adversarially
audited, empirically proven NET-NEGATIVE, and REVERTED. Evidence:

- n=2 probe: when a complete sibling exists, normal best-effort ranking ALREADY
  prefers it (admissible > inadmissible). A block changes nothing.
- When no complete candidate exists (lone / all-incomplete), the block turns a
  PARTIAL submit into an EMPTY one. Partial grades 0-or-1; empty always 0. So the
  block is ≤ current behaviour, with a PASS→FAIL tail when the consumer is a benign
  no-op caller. The T0 "leak" is therefore BENIGN.
- Conclusion: suppressing the incomplete patch is the wrong lever. The real lever
  is **item-6 (regenerate a COMPLETE candidate)**, with G2 (witness strengthening)
  as the safety gate against constructing a spurious family.

LANDED (kept): only the **relatedness guard** in `familyCoverageMissingHardReasons`
— pure safety (a round-robin mis-tagged candidate that touches none of its family
is no longer wrongly vetoed). Net production change = that guard alone.

NEXT (the actual value): item-6 regeneration-on-incomplete-coverage. G2 (candidate-0
tagging + must-edit-vs-no-op-consumer discrimination) is the safety prerequisite.

## Premise correction (do not re-litigate)

The producer-consumer static witness → `familyId="producer-consumer"` tagging
ALREADY WORKS for PLANNED families (candidate index 1+):
`producerConsumerWitnesses` (static-witness-adapter.ts:308) →
`familyFromStaticWitness` (candidate-families.ts:280) → `planFamilyCoverage` →
`selectionInputs.candidateFamilies[i]` → `withFamily` (selection-executor.ts:437)
→ `familyCoverageMissingHardReasons` (selection-gates.ts:275). So "construction
recall / advisory→tag" is NOT the primary gap. The veto enforcement exists.

## The three measured gaps

- **G1 (VERIFIED, T0):** the family-coverage veto LEAKS. A candidate tagged with
  a co-change family it does not cover gets `admissible:false` +
  `hard:familyCoverageMissing`, but `bestEffortEligible` (selection-gates.ts:411)
  has no family-coverage check, so a lone tagged-incomplete candidate STILL WINS
  via best-effort submission. Enforcement that does not block submission is not
  enforcement.
- **G2 (LIKELY):** candidate 0 — typically the minimal/early-accepted winner —
  gets `plannedFamilyFor(0)=undefined`. Its only family source is the DERIVED
  path (`deriveCandidateStructuralRepair`, driver.ts:3787), which re-computes
  structure FRESH from the candidate's own touched files and does NOT consult the
  pre-built producer-consumer bundle. So the winning single-file candidate is
  often UNTAGGED ⇒ the veto never even evaluates.
- **G3 (UPSTREAM, NOT T1):** the producer-consumer witness is `authoritative`
  only when BOTH producer and consumer files are in the stage-1 owner candidate
  set. If the consumer was never localized, no family exists. This is
  localization recall ⇒ T3 (`deeper_localize`), explicitly out of T1 scope.

## T1 scope (selection-layer only)

1. **Close G1 — make `familyCoverageMissing` block best-effort.** Add a
   `familyCoverageRejected(entry)` predicate to `bestEffortEligible` so a
   co-change-incomplete candidate cannot be submitted as best-effort.
   - GUARD (false-positive pole, T0): block ONLY when the family is a real
     co-change family with a non-empty owner set the candidate genuinely misses.
     A candidate with `familyId===undefined` (no family constructed) is NOT
     affected — a genuinely single-file fix stays acceptable.
   - ORDERING: `coeditFamilyCoverageCandidate` / `repairFamilyCoverage` already
     run BEFORE scoring (selection-executor.ts:480) and try to extend the patch
     across the missing sibling files. The block only bites AFTER repair failed
     to complete coverage — so the first effect is "repair to complete", and only
     the unrepairable remainder is rejected.
   - NO-WINNER CONSEQUENCE: if blocking leaves zero winners, the existing
     repair-feedback loop (`runRepairFeedbackLoop`, max 2 rounds in proofRequired)
     gets a chance to regenerate a complete candidate. Net effect on the
     leaderboard is score-neutral on an unrepairable case (incomplete patch and
     empty patch both score 0) but converts a silent partial-submit into a
     measurable "coverage-incomplete" no-winner — and gives the repair loop a
     trigger it does not currently get.

2. **Close G2 — tag candidate 0 (and any untagged winner) from the authoritative
   producer-consumer bundle.** Route the pre-built authoritative producer-consumer
   families into the postprocess path for candidate 0 / the derived path, by
   matching a candidate's touched files against a family's `producerFile`. If a
   candidate touches the producer of an authoritative producer-consumer family,
   tag it with that family so the veto evaluates.
   - This is the minimal wire; it does NOT change localization. It only makes the
     ALREADY-COMPUTED authoritative family visible to candidate 0.

3. **Answer-key fence.** Only `authoritative` static-witness families (both
   producer and consumer in stage-1 owners) may drive the best-effort block. The
   stage-1 owner set is localization output, never gold / test_patch / oracle.
   Add an assertion that any family used for the block carries static-witness
   provenance; fail closed otherwise.

## Non-goals

- No localization changes (G3 is T3).
- No new gate parallel to `familyCoverageMissing`; reuse it.
- No blocking on heuristic / advisory families — authoritative only.
- 11138 is NOT in scope (empty-capture infra → T5).

## Proof rails (hellgate)

- RED: a test where an authoritative producer-consumer candidate-0 is incomplete
  and currently WINS via best-effort (the G1+G2 leak). It must go red→green when
  the block lands (winner null or repaired-complete).
- False-positive control: a genuinely single-file candidate (no family) still
  wins — unchanged.
- Repair-first: a co-change-incomplete candidate whose sibling hunk is available
  is COMPLETED by `repairFamilyCoverage` and wins as complete (not rejected).
- Authority fence: an advisory (non-authoritative) family does NOT trigger the
  block (red-on-injection if a non-static provenance family reaches the gate).
- No-regression: the broad slice (`BROAD_REGRESSION_SLICE`) winner set is
  unchanged for candidates with no co-change family.

## Promotion

Target slice `14315`; control + medium = `BROAD_REGRESSION_SLICE` (frozen in T0).
Win = 14315 produces either a complete multi-file winner OR a measured
coverage-incomplete no-winner (not a silent partial), with zero best-effort
regression on the control set.
