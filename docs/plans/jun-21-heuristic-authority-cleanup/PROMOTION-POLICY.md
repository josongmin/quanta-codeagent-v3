# Heuristic authority promotion policy

T-MEASURE-08. This is the written, machine-checked path from "a new signal idea"
to "clean-mode authority". No signal may hard-reject or hard-admit a candidate in
a clean preset unless it has walked every stage below and cleared every blocker.

Related:

- [Final plan](./README.md)
- Authority taxonomy (SSOT): `src/agent/verification-bundle/authority.ts`
  (`SIGNAL_AUTHORITY`, `isCleanHardVeto`, `isKnownSignal`).
- Enforcement test: `tests/unit/authority-promotion-policy.test.ts`.

## Why this exists

The clean selector path may only ever hard-reject on EXECUTABLE or STRUCTURAL
authority. Every heuristic / answer-key / magic-score signal is `researchOnly`
and can never veto a clean candidate. Without a written promotion gate, a tuned
heuristic that recovers a handful of known SWE-bench misses will silently re-enter
the clean preset and the "clean score" stops meaning anything. This policy makes
the boundary explicit and machine-checked so research wins cannot become default
benchmark claims.

Scores, never merged. The receipt label taxonomy (T-RESOLVE-14) has three values;
only the first is benchmark-reportable:

- **clean score (`official_harness`)** — produced by a preset whose every hard
  authority is `hardExecutable` or `hardStructural`, AND graded by the official
  SWE-bench harness. This is the only score reportable as benchmark quality.
- **`local_structural`** — executed local witness/keep-green/repro green without an
  official harness grade. Legitimate scaffold-internal authority and a legitimate
  intermediate claim, but never rendered as official resolved and never merged into
  the clean count.
- **research score (`research_contaminated`)** — produced behind a NAMED research
  knob/preset (`research/rca-target-gates/*`, `research/repro-doubt/*`,
  `research/discovered-regression/*`). Never reported as clean.

A receipt takes the WEAKEST label of its inputs: `research_contaminated` dominates,
and `local_structural` never auto-promotes to `official_harness` without an actual
harness run.

## Promotion stages

A new signal idea must pass these five stages **in order**. Skipping a stage is a
promotion blocker.

1. **observe-only** — the signal is recorded as telemetry only and is
   structurally incapable of affecting selection. Classified `observeOnly` (or
   `researchOnly` behind a named knob). No code path lets it veto or admit.
2. **shadow** — the signal emits a `wouldReject` / `wouldRank` decision *beside*
   the actual clean decision, on every clean run. The shadow decision is logged
   but discarded. This produces the disagreement distribution against clean
   authority without affecting any outcome.
3. **holdout A/B** — the signal is evaluated on a holdout of instances it was NOT
   tuned against (no overlap with the instances used to design its thresholds /
   regexes / weights). The A/B must report the required metrics below, separating
   resolved delta from minimality / cost metrics.
4. **false-reject audit** — every candidate the signal would have rejected must
   have *executable counter-evidence* showing the rejection was correct. A reject
   with no executable counter-evidence is a false reject and blocks promotion.
5. **clean promotion** — only after stages 1-4 are documented and pass criteria
   are met. Promotion requires adding the signal to `SIGNAL_AUTHORITY` with a
   `hardExecutable` / `hardStructural` class AND a provenance note explaining why
   the authority is executed/structural rather than heuristic.

## Required metrics

Every holdout A/B report (stage 3) and every clean-promotion proposal (stage 5)
must record all of:

- **raw resolved count** — official-harness resolved, not verdict, not score.
- **turns** — distribution, not just mean.
- **patch bytes** — distribution.
- **multi-file rate** — fraction of winners touching >1 file.
- **added-def rate** — fraction of winners that add a new definition.
- **false-reject count** — rejected candidates lacking executable
  counter-evidence (must be 0 to promote to clean).
- **false-admit count** — admitted candidates later shown wrong, where
  measurable.
- **research-contamination label** — `clean` or `research-contaminated`. Any run
  touching a research knob/preset is `research-contaminated` and cannot be
  reported as clean score.

## HARD promotion blockers

A signal exhibiting ANY of these can NEVER become clean authority, regardless of
how many instances it recovers:

- **issue ID or issue-family regex** — matching on the issue id, repo name, or an
  issue-family keyword pattern (e.g. `postgresql|mysql|sqlite|oracle`).
- **file-path patch matching for known instances** — vetoing/admitting because a
  patch touches a file path known to be the gold owner for a specific instance.
- **magic threshold without holdout** — any numeric cutoff (`>= 3`, `+50`,
  `DEFAULT_MAX_TESTS=12`, score weight) that has not survived a stage-3 holdout on
  non-tuned instances.
- **single-instance green as general proof** — one instance flipping
  miss→resolved is never general evidence; it is a research anecdote.
- **hidden PASS_TO_PASS / test_patch labels in engine code** — reading the
  oracle's `PASS_TO_PASS`, `FAIL_TO_PASS`, `test_patch`, or any held-out grading
  label inside the selector / verification engine. The engine must decide from
  executed evidence and public contracts only.

## Definition of done

- There is a written path from idea to clean authority (this document).
- Research wins cannot silently become default benchmark claims (clean score vs
  research score are separated and labelled).
- A `researchOnly` signal can never be a clean hard veto — enforced by
  `tests/unit/authority-promotion-policy.test.ts`, which fails if any
  `researchOnly` signal returns `true` from `isCleanHardVeto(signal, "clean")`,
  and fails if a new `SIGNAL_AUTHORITY` member appears without a classification.
