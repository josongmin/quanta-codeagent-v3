# Jun 24 - Scaffold SOTA Absorption Plan (Latest-Code Baseline)

## Objective

Absorb only scaffold levers that fill measured empty or dead seams in the current
bench pipeline. Keep verifier and clean-selector authority unchanged. Do not
answer "SOTA++" with generic "more scaffolding".

## Inputs

- Baseline stance:
  - this plan is grounded in the current workspace tree, not an older clean
    snapshot
  - promotion to a default path still requires replay on a clean proof worktree
- Audit source:
  - `docs/analysis/jun24-scaffold-absorb/REPORT-jun24-scaffold-absorb-audit-3round.md`
  - `docs/analysis/jun24-scaffold-absorb/REPORT-jun24-three-fails-with-citations.md`
- Live owner surfaces:
  - `src/runner/batch/eval/posture/capability-profiles.ts`
  - `src/runner/batch/eval/driver.ts`
  - `src/runner/batch/eval/patch-static-sanity.ts`
  - `src/runner/batch/eval/selection-assembly.ts`
  - `src/runner/batch/eval/llm-evidence-packet.ts`
  - `src/runner/batch/eval/selection-executor.ts`
  - `src/runner/batch/eval/snapshot.ts`

## Latest-code truth

- `deeper_localize` already exists as an adaptive action, but
  `DEEPER_LOCALIZE_MODULES` is intentionally `[]`. The route is a current no-op.
  The missing work is an occupant, not more router vocabulary.
- `repairEscalation` already computes `owners` and `siblingFiles`, but only on
  the post-repair success path and only into `args.extra`. It is report
  telemetry today, not a search-widening mechanism.
- `patch-static-sanity.ts` currently has only two hard veto probes:
  callback-arity mismatch and `None` subscript mutation. There is no current
  undefined-name differential gate.
- Clean selection is not evidence-empty. Generation already carries
  `ownerEvidence`, `verificationTarget`, `validatedReproScripts`, and
  `existingTestExpectations`. The missing piece is mandatory caller or consumer
  structural evidence before patching or late selection.
- The current selector substrate already has bounded completeness machinery:
  family-coverage repair and co-edit coverage seams already exist. Do not
  re-propose generic "multi-file selector" work that the tree already contains.
- Patch capture still relies on out-of-band `git add -A` plus
  `git diff --cached` in `snapshot.ts`. That is an infra-correctness seam, not
  the main solve-quality lever.

## Decision

Prioritize the work in this order after the latest three-case remote receipts:

1. Promote caller, consumer, and owner-family evidence into a hard coverage
   contract before winner acceptance.
2. Pull `13033` repro or exact-message fidelity into the first implementation
   wave. It is not a deferred nice-to-have for the current target set.
3. Occupy `deeper_localize` as a bounded fallback only when the coverage
   contract reports missing required owners or consumers.
4. Add a differential undefined-name hard gate for edited Python files.
5. Treat `django__django-11138` as a patch-CAPTURE infra bug, NOT a
   coverage-contract case. Our graded submission was an empty 0-byte patch
   (fork-worktree extraction); the agent edited the correct sites and ran the
   oracle in a fork tree that never reached the final diff. It belongs to T5
   (capture correctness), and is removed from T1's coverage target.
6. Treat cross-vendor model diversity as a separate medium-slice uplift
   experiment. It is promising for broad synthesis misses, but it does not block
   canonical three-case closure.

Latest receipt correction (reconciled with the cited audit, 2026-06-24,
3-source confirmed — supersedes the earlier "11138 non-empty" reading):

- `django__django-14315`: non-empty patch, but only
  `django/db/backends/postgresql/client.py`; the CALLER/consumer base-client site
  is still missing. This is a caller-reference recall miss, not a sibling miss.
- `django__django-11138`: EMPTY 0-byte submission from a fork-worktree
  patch-extraction bug. Localization + test-oracle already worked (M3/M5). This
  is an infra capture failure (T5), not a coverage or methodology miss.
  `mysql/operations.py` is a GOLD file we did not submit — it must never be
  recorded as our patch shape (gold-as-ours trap).
- `astropy__astropy-13033`: non-empty patch in `astropy/timeseries/core.py`;
  the miss is spec or exact-message fidelity, not patch extraction.

Substrate audit (post-T0, file:line verified — changes T1/T3 scope):

- Caller/consumer reference recall ALREADY EXISTS and is wired: the
  `producer-consumer` static-AST witness
  (`static-witness-adapter.ts` `producerConsumerWitnesses`) detects "defined in
  one owner file, called in another" and feeds closure localization evidence.
  This is the 14315 shape. It is distinct from `cha-multisite-steer` (sibling
  OVERRIDE recall) and `owner-sibling-resolve`.
- BUT it stays ADVISORY in clean owner admission (`closure-session.ts`), and T0
  proved a required-owner contract is RANKING-only, never a hard veto. So the
  real T1 lever is not new localization — it is PROMOTING the existing
  producer-consumer witness from advisory to a hard coverage-completeness
  authority (and granting the completeness that exempts the resulting multi-file
  patch from the unproven-multi-source drift veto). Static-AST provenance ⇒ the
  T1 answer-key fence is already satisfied.
- Consequently T3 (`deeper_localize` occupant) drops in priority: the localizer
  already surfaces the consumer; the gap is authority, not recall. T3 stays a
  fallback only for cases where the witness is empty.

## Non-goals

- No new planner or verifier stack by default.
- No prompt-only "be more careful" answer.
- No gold-aware online diagnostics.
- No permanent default-OFF research knobs. Every lever must either win and
  promote, or lose and get deleted.
- No collapsing `14315` solve-quality, `13033` spec-fidelity, and `11138`
  capture correctness into one blended claim.

## Final implementation tickets

### T0 - Freeze canonical receipts and fixtures

Type: measurement foundation.

Cases:

- `django__django-14315`
- `django__django-11138`
- `astropy__astropy-13033`

Owner surfaces:

- `tests/unit/selection-executor.test.ts`
- `tests/unit/llm-evidence-packet.test.ts`
- targeted fixtures under `tests/fixtures` if a new fixture directory is needed

Implementation:

- Add compact fixtures for the latest failing patches (DONE — see
  `tests/fixtures/scaffold-absorb-jun24/manifest.ts` +
  `tests/unit/scaffold-absorb-jun24-baseline.test.ts`):
  - `14315`: touched files only contain `django/db/backends/postgresql/client.py`
  - `11138`: EMPTY (`[]`) — our real 0-byte fork-extraction submission. Recording
    `mysql/operations.py` here would be the gold-as-ours trap.
  - `13033`: touched files contain `astropy/timeseries/core.py`
- Encode the expected failure class on each fixture:
  - `missing-required-owner-file`
  - `fork-worktree-empty-capture`
  - `missing-existing-test-expectation`
- Keep these fixtures independent from gold patches. They should represent our
  observed failure shape, not the answer key.
- FALSE-GAP BASELINE (hard, anti-double-count): the following gates and builders
  are ALREADY LIVE and wired. They MUST be recorded as baseline, never measured
  or claimed as "new absorption wins":
  - `hard:familyCoverageMissing` veto (`selection-gates.ts`) + `candidateFamilyCoverageMissing` (`candidate-families.ts`)
  - `hard:declaredExpectedMatch=false` veto (`selection-gates.ts`, currently
    clean-mode-DISABLED because its only source is the answer-key matcher)
  - the contract builders in `public-contract-bundle.ts`
    (`buildMultiSiteFamilyContract`, `buildOwnerMustTouchContracts`,
    `buildExactOutputContract`)
  - `extractIssueDeclaredExpected` (`verification-plan/extract-issue-declared-expected.ts`)
  - `coeditFamilyCoverageCandidate` (`family-coverage-coedit.ts`)
  - `extractVerificationOwnerTestExpectations` (`verification-owner-test-expectations.ts`)
- GREP-GATE DISCIPLINE (per-ticket dispatch requirement): before any T1-T5
  agent writes code, it must broad-grep the target symbol/seam to confirm
  LIVE-vs-absent state and edit the real chokepoint, not re-build an existing
  one. The delta is construction-recall / source-authority / wiring, not new
  machinery, except where this plan explicitly marks a seam as confirmed-absent
  (T4 differential F821, T3 empty `DEEPER_LOCALIZE_MODULES`, T5 out-of-band diff).
- Pin and record, in this ticket, the frozen instance-id lists used later by the
  promotion protocol:
  - per-lever target slice (already named in the promotion protocol)
  - the medium confirmation slice
  - the no-regression control set (must include cases whose correct fix is
    single-file, to exercise the T1 false-positive bound)
  These lists are frozen before any treatment runs and may not be edited to fit a
  result.

Acceptance:

- Unit tests can reproduce the current single-file false-winner shapes without
  remote execution.
- No fixture imports a SWE-bench gold patch or PR diff.
- Medium slice and control set instance ids are committed before T1/T2 treatment
  runs.

### T1 - Coverage-as-contract for owner and family completeness

Type: solve-quality blocker for `14315` and `11138`.

Owner surfaces:

- `src/runner/batch/eval/selection-assembly.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/selection-repair-seed.ts`
- `src/runner/batch/eval/family-coverage-coedit.ts`
- `src/runner/batch/eval/public-contract-bundle.ts`

LATEST-CODE TRUTH (do not re-build): the coverage contract machinery is ALREADY
LIVE. `hard:familyCoverageMissing` is an enforced veto in `selection-gates.ts`
(reachable in clean mode, not researchOnly-gated), `candidateFamilyCoverageMissing`
exists in `candidate-families.ts`, and the contract builders
(`buildMultiSiteFamilyContract`, `buildOwnerMustTouchContracts`,
`buildExactOutputContract`) exist in `public-contract-bundle.ts`. THE GATE IS NOT
THE GAP. The veto only fires when the constructed family/required set is
non-empty, and today it is empty for `14315` (base client). The delta is
CONSTRUCTION RECALL, not new enforcement.

LIVE-TEST CORRECTION (T0 baseline, `scaffold-absorb-jun24-baseline.test.ts`,
verified against `selection-gates.ts:411`): "the gate is not the gap" is only
HALF true. When the co-change family IS constructed and a candidate misses a
member, `hard:familyCoverageMissing` does fire and marks the candidate
`admissible:false` — BUT `bestEffortEligible` has no family-coverage check, so a
lone tagged-incomplete candidate STILL WINS via best-effort submission. The gap
is therefore TWO-part: (1) construction recall (tag the candidate with the
producer-consumer family — the existing `producerConsumerWitnesses` static
witness already detects the 14315 caller edge but stays advisory in
`closure-session.ts`), AND (2) make `familyCoverageMissing` actually block
best-effort, not just lower admissibility. A T1 that does only (1) still leaks
the incomplete patch through best-effort. 11138 is excluded here (empty-capture
infra → T5).

Implementation:

- Widen contract CONSTRUCTION so the required/family set is populated for the
  failure shapes the existing veto already guards:
  - `14315`: the postgresql-client edit must implicate the shared/base client
    site via static reference / public-contract edge, so the family set is
    non-empty and the existing `familyCoverageMissing` veto fires.
  - `11138`: the single-backend edit must implicate the sibling backend family
    via static call-graph / public-contract edge.
  - Feed from: current owner evidence, CHA repair targets, caller/consumer
    references, public contract subject files when present.
- Reuse the existing veto and repair seams; do NOT add a parallel gate:
  - construction feeds the existing `candidateFamilyCoverageMissing` /
    `hard:familyCoverageMissing` path
  - when missing, run the existing `coeditFamilyCoverageCandidate` /
    `repairFamilyCoverage` before rejecting
- ANSWER-KEY INVARIANT (hard): every member of `requiredFiles` must be derivable
  from static call-graph / reference / public-contract analysis of the
  candidate's own change. It must NEVER be sourced, directly or transitively,
  from the failing test, `test_patch`, gold patch, PR diff, or the grading
  oracle. If a required file cannot be justified by a static-analysis edge, it is
  not allowed into the contract. Record `coverageContractSource` per file so this
  is auditable, and fail the build if any source tag is oracle/gold-derived.
- Compare candidate `touchedFiles` against the required file set.
- If required files are missing:
  - run bounded `repairFamilyCoverage` or `coeditFamilyCoverageCandidate` when a
    donor hunk exists
  - otherwise reject the candidate as incomplete instead of accepting a
    producer-only patch
- Emit structured rejection or repair telemetry:
  - `requiredFiles`
  - `touchedFiles`
  - `missingFiles`
  - `coverageContractSource`
  - `repairAttempted`
  - `repairReducedMissing`

Acceptance:

- `14315` producer-only `postgresql/client.py` candidate is not accepted unless
  the base client requirement is satisfied.
- `11138` single-backend candidate is not accepted when the backend family
  contract requires additional sites.
- Same-file wrong fixes still pass through this gate; this ticket only owns
  file-family completeness, not semantic correctness.
- NO-NEW-GATE: rejection flows through the existing `hard:familyCoverageMissing`
  veto. A `git grep` for new reject reasons added by this ticket returns nothing;
  the only new code is contract construction + its answer-key source tagging.
- FALSE-POSITIVE BOUND: when a single-file edit is in fact the complete fix, the
  contract must NOT over-demand and reject it. A required file enters the
  contract only when a static edge actually implicates it; an empty or
  single-element required set is the expected and common case. This gate may not
  lower solve rate on cases that were already correct with one file.

Tests:

- Positive: complete touched-file set satisfies the contract.
- Negative: producer-only candidate is rejected.
- Repair: bounded co-edit reduces `missingFiles` and allows re-evaluation.
- Safety: no contract means existing single-file behavior remains unchanged.
- False-positive control: a case whose correct fix is genuinely single-file
  produces an empty/satisfied contract and is NOT rejected (guards solve-rate on
  the broad set, not just the targeted slice).
- Answer-key guard: a contract built with any oracle/gold-derived `requiredFiles`
  source tag is rejected at construction (red-on-injection).

### T2 - Existing-test expectation discovery for exact-message cases

Type: spec-fidelity blocker for `13033`.

Owner surfaces:

- `src/runner/batch/eval/verification-owner-test-expectations.ts`
- `src/runner/batch/eval/llm-evidence-packet.ts`
- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/eval/public-contract-bundle.ts`

Implementation:

- Stop depending only on `ownerNearTests` command paths for
  `existingTestExpectations`.
- Add a bounded source search for existing tests when command-derived paths are
  empty:
  - search by localized module path namespace
  - search by issue symbols or function names
  - search for asserted string literals near matching symbols
- Feed discovered expectations into the candidate-generation packet as
  structured facts, not prompt prose.
- Mark `public_mwe_base_not_attempted` as insufficient proof when an existing
  test expectation exists but was not read or run.
- Do not use `test_patch` or PR diffs as a source.

Acceptance:

- `13033` packet contains the existing test literal expectation before patch
  generation.
- Candidate text that invents a different message shape is penalized or rejected
  by the existing expectation path.
- Empty command-derived test paths no longer mean empty test-expectation facts.

Tests:

- Extract expectations from a repo test discovered by module namespace.
- Extract expectations from a repo test discovered by symbol name.
- Do not extract from generated patch tests or external PR text.
- Snapshot packet shows structured `existingTestExpectations` facts.

### T2b - Spec-fidelity invariant from public issue text

Type: execution-free spec oracle for `13033`-class exact-behavior misses.

Owner surfaces:

- `src/agent/verification-plan/types.ts`
- `src/agent/verification-plan/build.ts`
- `src/agent/verification-plan/extract-issue-declared-expected.ts`
- `src/runner/batch/eval/llm-evidence-packet.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/public-contract-bundle.ts`

LATEST-CODE TRUTH (do not re-build): both halves of this machinery ALREADY
EXIST. `extractIssueDeclaredExpected` is implemented in
`verification-plan/extract-issue-declared-expected.ts` and already feeds the
`spec-fidelity-steer` knob, driver, and closure-session. The hard veto
`hard:declaredExpectedMatch=false` ALREADY EXISTS in `selection-gates.ts`. The
reason `13033` still misses is precise and documented in code:
`scoreCandidateUnderMode` returns `mode === "clean" ? verdict : applyDeclaredExpectedHardGate(...)`
— the declared-expected gate is DELIBERATELY DISABLED in clean mode because its
only authority source today is the answer-key matcher (no legitimate clean-mode
authority). THE EXTRACTOR AND THE GATE ARE NOT THE GAP. The delta is giving the
`declaredExpected` selection port a PUBLIC-INPUT-DERIVED source so the existing
veto can legitimately fire in clean mode.

Implementation:

- Wire `extractIssueDeclaredExpected` output (public-issue-text derived) into the
  `declaredExpected` selection port with explicit public provenance, so the
  existing `applyDeclaredExpectedHardGate` path has a clean-legitimate source.
- Flip the clean-mode disablement to conditional: the declared-expected veto may
  fire in clean mode ONLY when the invariant carries a verified `public`
  provenance tag (never when sourced from the answer-key matcher). The
  answer-key-only path stays clean-disabled exactly as today.
- Keep this behind a default-OFF `spec-fidelity-invariant` treatment flag until
  the targeted slice proves it; on win, promote and delete the flag.
- Freeze the invariant before patching and persist provenance:
  - source text span or issue section
  - extractor version
  - normalized invariant text
  - whether the invariant was deterministic or judge-scored
- Prefer deterministic predicates when the issue gives a literal expected value.
  Use independent judge scoring only as advisory unless it is backed by a frozen
  public invariant and a behavior-level parser contract.
- Feed the invariant into generation and selection as structured evidence.
- Reject or strongly penalize candidates that satisfy their own generated repro
  but contradict the frozen invariant.

Do not:

- use an LLM yes/no answer as hard authority without a frozen public invariant
  and a deterministic or independently reproducible scoring path
- derive the invariant from `test_patch`, PR diffs, hidden tests, grading output,
  or gold patches
- replace T2 existing-test discovery; T2 and T2b are complementary

Acceptance:

- `13033`-class candidates that invent a different message shape are visible as
  spec-fidelity failures even when their self-generated repro passes.
- The invariant is built before candidate patch text exists.
- The report records enough provenance to prove the invariant is public-input
  derived.
- NO-NEW-GATE: the rejection flows through the existing
  `hard:declaredExpectedMatch=false` veto via the unchanged
  `applyDeclaredExpectedHardGate`. The only behavioral change is that clean mode
  now consults that gate when (and only when) the source is public-provenance.
  The answer-key-matcher path remains clean-disabled (red-on-injection test).

Tests:

- Literal public expected output becomes an exact deterministic invariant.
- Non-literal public issue text creates advisory-only invariant evidence unless
  a hard parser contract exists.
- Candidate contradicting the frozen invariant is rejected or ranked below a
  candidate that satisfies it.
- Injection guard: any invariant sourced from PR/gold/test_patch is rejected at
  construction.

### T3 - Bounded `deeper_localize` / forward-localize occupant

Type: fallback localization widening, not the primary three-case fix.

Owner surfaces:

- `src/runner/batch/eval/posture/capability-profiles.ts`
- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/eval/adaptive-escalation/router-prompt.ts`
- existing localization helpers used by `prepareHintAndReproContext`

Implementation:

- Trigger only when:
  - the coverage contract reports required owners not present in the candidate
    set, or
  - the adaptive controller explicitly selects `deeper_localize`.
- Re-query with bounded context:
  - previous owner files
  - discovered symbols
  - caller or consumer references
  - CHA repair targets
- Add a forward-localize mode for `14315`-class misses:
  - infer the patched end-state from public issue facts and current candidate
    edits
  - trace the changed value or contract forward to consumers
  - propose absent edit sites as candidates, not as hard required files
  - require T1 static-edge or public-contract validation before any proposed
    site becomes a coverage requirement
- Cap at one treatment round for the first implementation.
- Dedup by file and symbol before generation.

Acceptance:

- `DEEPER_LOCALIZE_MODULES` is no longer inert when the feature is enabled.
- The widened candidate set re-enters generation.
- Non-triggered cases preserve current behavior byte-for-byte at the API
  boundary.

Tests:

- No-op when no trigger signal exists.
- Triggered widening adds only deduped files or symbols.
- Widened candidates are visible to the next generation pass.
- Forward-localize can surface a consumer file that backward grep or CHA did not
  initially localize.
- Forward-localize proposals without a validating static edge remain advisory and
  cannot enter `requiredFiles`.

### T4 - Differential undefined-name hard gate

Type: static regression guard.

Owner surfaces:

- `src/runner/batch/eval/patch-static-sanity.ts`
- candidate-validation call sites that consume `hard:staticSanity`

Implementation:

- Run on edited Python files only.
- Compute before and after undefined-name diagnostics.
- Veto only net-new diagnostics attributable to edited files or edited lines.
- Degrade to advisory telemetry when the backend is unavailable or attribution
  is ambiguous.

Acceptance:

- New dangling reference introduced by a candidate is hard-rejected.
- Pre-existing undefined names do not block the candidate.
- Backend failure does not create a false hard veto.

Tests:

- Net-new undefined name is rejected.
- Pre-existing undefined name is ignored.
- Unavailable backend emits advisory telemetry only.

### T5 - Patch-capture correctness guard

Type: infra guard, separated from solve-quality work.

Owner surfaces:

- `src/runner/batch/eval/snapshot.ts`
- completion and submit paths in `src/runner/batch/eval/driver.ts`

Implementation:

- Recompute done-time source diff from the same tree used for completion.
- Reject empty done-time diff before submit when budget remains.
- Preserve richer report evidence:
  - `patchBytes`
  - `modelPatchDigest`
  - `touchedFiles`

Acceptance:

- Completion cannot silently submit an empty or wrong-tree patch.
- The guard does not regress the latest non-empty `11138` receipt path.
- Report-only post-hoc analysis still has enough patch evidence.

Tests:

- Empty done-time diff triggers retry or rejection.
- Non-empty source-only diff survives extraction.
- Report serialization includes digest and touched files.

### T6 - Remote closure rerun

Type: final proof receipt.

Owner surfaces:

- full-remote bench invocation path
- report, predictions, and trajectory retention

Implementation:

- Rerun the canonical three-case slice only after T1, T2, T2b, and T3 have local
  proof rails.
- Use on-demand full-remote boxes, not spot boxes.
- Retain:
  - report
  - predictions
  - trajectory
  - stderr or observation tail sufficient for RCA

Acceptance:

- Each case has a fresh receipt after the implementation series.
- If still unresolved, the report classifies the miss as one of:
  - `coverage-contract-still-incomplete`
  - `spec-expectation-not-applied`
  - `generation-wrong-despite-complete-evidence`
  - `oracle-or-env-unhealthy`
  - `infra-capture-failed`

Do not:

- promote a treatment from local unit tests alone
- blend the three case outcomes into one success or failure label

### T7 - Cross-vendor diversity measured experiment

Type: broad synthesis-uplift experiment, not a canonical three-case blocker.

Owner surfaces:

- `src/runner/batch/eval/selection-assembly.ts`
- `src/runner/batch/eval/selection-executor.ts`
- LLM provider factory and provider metadata surfaces under `src/llm/`
- bench preset or posture surfaces under `src/runner/batch/eval/posture/`

Implementation:

- Add a default-OFF treatment that can request distinct provider families for:
  - candidate generation
  - judge or selector review
- Record provider-family metadata per candidate and per judge vote:
  - provider
  - model
  - candidate id
  - role: generation or judge
  - cost and token usage when available
- Keep same-provider concurrency as the control. Do not compare cross-vendor
  against no-selection or different prompt settings.
- Run only on a pre-frozen medium synthesis slice after T0 freezes the slice.
- Treat missing credentials or provider unavailability as an ops skip, not as a
  failed treatment.

Do not:

- block T6 canonical closure on this experiment
- promote based on one or two showcase cases
- mix provider diversity with prompt/rubric changes in the first A/B

Acceptance:

- Candidate and judge outputs carry provider-family metadata.
- The A/B report can distinguish same-model concurrency from cross-vendor
  diversity.
- Promotion requires target-slice uplift, cost visibility, and no-regression on
  the frozen control set.

Tests:

- Provider-family metadata serializes into selection telemetry.
- Same-provider control and cross-vendor treatment produce comparable tables.
- Missing provider credentials mark the treatment skipped without corrupting the
  report.

## Work packages

The ticket list above is the implementation order. The WP sections below remain
as source-package notes and rationale; do not execute them in numeric WP order
when it conflicts with T0-T6.

### WP0 - Freeze the baseline and the measurement rails

Goal: make every later win attributable.

Owner surfaces:

- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/posture/capability-profiles.ts`
- targeted slice docs under `docs/plans/`

Implementation:

- Define three targeted slices and keep them separate:
  - `14315` class: consumer or multi-owner localization misses.
  - `13033` class: repro or message-fidelity misses.
  - `11138` class: empty or wrong-tree capture failures.
- Record current control behavior for the active baseline preset before any new
  default changes.
- Treat already-landed owner-evidence and family-coverage surfaces as baseline,
  not as "new absorption wins".

Exit criteria:

- Each lever has one target slice, one control preset, one treatment preset,
  and one explicit no-regression check set.

### WP1 - Occupy `deeper_localize`

Goal: turn the current no-op adaptive route into a bounded localization-widening
pass that can recover caller or consumer surfaces before the next generation.

Owner surfaces:

- `src/runner/batch/eval/posture/capability-profiles.ts`
- `src/runner/batch/eval/driver.ts`
- the existing issue-hint and localization helpers used by
  `prepareHintAndReproContext`
- `src/runner/batch/eval/adaptive-escalation/router-prompt.ts`

Implementation:

- Keep the first localization pass unchanged.
- When the controller selects `deeper_localize`, or when a thin attempt returns
  a localization-gap signal, rerun localization with discovered evidence from:
  - prior owner files
  - discovered symbols
  - CHA repair targets
  - caller or consumer hints
- Bound the widening loop tightly:
  - max 1-2 re-query rounds
  - dedup by file and symbol
  - feed only the widened set into the next generation pass
- Emit telemetry for:
  - added files
  - added symbols
  - why the second pass ran
  - whether the widened set changed the next candidate family

Do not:

- bump `localizeBudget` blindly and call it a feature
- introduce a generic research planner
- route `deeper_localize` by default before the target slice proves it helps

Proof rails:

- unit coverage for no-op versus occupied `deeper_localize`
- driver-level test showing widened candidates re-enter generation
- telemetry assertion that the second pass is bounded and deduped

Exit criteria:

- `deeper_localize` is no longer inert
- targeted `14315` slice shows higher owner or caller recall before patch
  emission
- no control regression on non-multi-owner cases

### WP2 - Promote caller or consumer evidence earlier

Goal: move multi-owner evidence from late observe-only telemetry into the live
generation and selection path.

Owner surfaces:

- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/eval/selection-assembly.ts`
- `src/runner/batch/eval/llm-evidence-packet.ts`
- any selection-repair seed builder used before repair or reseed

Implementation:

- Build a source-only caller or consumer evidence bundle before patch emission.
- Feed that bundle into generation and clean-selection packets as first-class
  structural evidence, not as prose-only commentary.
- Reuse existing repo surfaces first:
  - `find_references`
  - CHA-derived repair targets
  - current owner evidence
- Require selection-time review to inspect unchanged interacting sites on
  multi-owner-likely candidates before admitting them as winners.

Do not:

- rely on the current `repairEscalation` site; it is too late in the lifecycle
- require a new subagent system if current references and CHA surfaces are
  enough
- claim "selector evidence was missing" when owner and test-expectation evidence
  already exist

Proof rails:

- packet tests for caller or consumer facts
- selector tests showing the evidence is present before final winner selection
- at least one negative test where producer-only edits are rejected because the
  unchanged consumer site was inspected

Exit criteria:

- multi-owner evidence is visible before patch acceptance
- the late `repairEscalation` report path becomes optional telemetry rather than
  the only place the signal exists

### WP3 - Add a differential undefined-name hard gate

Goal: catch new dangling references introduced by candidate edits without
blocking on pre-existing repo noise.

Owner surfaces:

- `src/runner/batch/eval/patch-static-sanity.ts`
- the patch-hygiene or candidate-validation entrypoints that already consume
  `hard:staticSanity`

Implementation:

- Run only on edited Python files.
- Collect undefined-name diagnostics before and after the edit.
- Veto only net-new diagnostics attributable to the candidate's edited files or
  lines.
- Keep the existing callback-arity and `None`-subscript probes intact; this is
  a third probe, not a replacement.
- Use a repo-owned or hermetic backend. Ambient host tools are not a production
  dependency.
- If attribution fails or the backend is unavailable, degrade to advisory
  telemetry rather than a false hard veto.

Do not:

- run a repo-wide lint and call every existing error a candidate failure
- depend on gold-aware closure diagnostics
- hard-fail when the tool cannot prove the error is net-new

Proof rails:

- unit tests for before-versus-after subtraction
- regression tests for pre-existing undefined names that must not block
- one positive case that introduces a new dangling consumer reference and is
  vetoed

Exit criteria:

- the gate blocks new edited-file undefined-name regressions
- noisy baseline repos do not get false hard vetoes

### WP4 - Fix `11138` patch-capture correctness as a separate infra track

Goal: make completion-time patch extraction truthful without confusing that work
with solve-quality gains.

Owner surfaces:

- `src/runner/batch/eval/snapshot.ts`
- the completion and submit path in `src/runner/batch/eval/driver.ts`
- adjacent patch-retention or no-patch breaker seams

Implementation:

- Recompute the final source-only diff at completion from the same submission or
  extraction tree that the completion decision uses.
- Reject an empty done-time diff before submit if budget remains.
- Evaluate in-band patch receipt separately from the main SOTA track; only keep
  it if it removes real capture drift without breaking current closure paths.

Do not:

- treat `11138` as evidence that more localization or more selection is needed
- solve this only with prompt wording
- promote patch-capture changes as a solve-rate win before the infra slice
  proves they fix the failure class

Proof rails:

- targeted replay on the `11138` infra slice
- tests for empty done-time diff rejection
- tests that source-only extraction remains stable after the change

Exit criteria:

- completion cannot silently submit an empty or wrong-tree patch on the target
  slice
- capture correctness is improved without regressing normal submission

## Deferred queue

Not first-wave absorption:

- stdout head-tail capture audit where the active bench path still needs live
  verification
- semantic patch dedup or patch-canonicalization upgrades
- compaction or history-shaping work that only matters on long-horizon runs

These may still matter, but they are not the highest-ROI latest-code seam fills.

## Promotion protocol

- Each lever's targeted slice is fixed up front, before implementation:
  - T1 coverage-as-contract: `14315`, `11138`.
  - T2 existing-test expectations: `13033`.
  - T2b spec-fidelity invariant: `13033`.
  - T3 `deeper_localize`: `14315` (caller/owner recall).
  - T7 cross-vendor diversity: pre-frozen medium synthesis slice, not the
    canonical three-case slice.
- The medium confirmation slice and the no-regression control set must be named
  and frozen BEFORE any treatment runs. Pin the exact instance ids in T0 fixtures
  / WP0 so the slice cannot be chosen post-hoc to fit the result. Each lever is
  justified by n=1-2 today; the frozen medium slice is the only guard against
  overfitting, so selecting it after the fact silently voids the win.
- Run control versus treatment only on the slice the lever is supposed to fix.
- Require all three before promotion:
  - target-slice win
  - explicit no-regression on the pre-frozen control set
  - confirmation on the pre-frozen medium slice after the targeted smoke
- Delete losing knobs. Do not keep permanent research flags in the main path.

## Expected outcome

- `14315` class: producer-only false winners are rejected or repaired before
  final selection.
- `13033` class: existing public test expectations are read and carried before
  generation, and patch-independent public spec invariants make exact-message
  inventions visible even when self-generated repros pass.
- `11138` class: wide backend-family incompleteness is separated from patch
  capture. Capture remains guarded, but solve-quality work owns missing family
  coverage.
- Broad synthesis class: cross-vendor generation and judging is measured with
  provider-family telemetry before any promotion claim.

This is the current best latest-code absorption order because it first turns
already-visible evidence into authority, then fills the no-op widening route,
then adds static and infra guards without confusing them with solve-quality
gains.
