# SWE-Bench ProMax integration tickets

Status: **ARCHITECTURE-AUDITED / PLANNED**

Final architecture audit: **GO for implementation only after the Foundation
gate closes.** ProMax runtime code is not implemented by this packet. The audit
establishes owner boundaries, dependencies, proof rails, and campaign promotion
rules; it is not execution evidence.

Shared suite/config/report/dashboard ownership is defined by the
[benchmark foundation packet](../../aug-21-bench-foundation/tickets/README.md).
This packet implements only the `promax` family and its evaluator/corpus/remote
behavior inside the `swe-bench` suite.

Authoring snapshot: `11a54656bfc8` on 2026-08-21. The worktree already had unrelated
changes in `package.json`, `src/llm/adapters/chatgpt-oauth.ts`, and
`src/llm/factory.ts`; those are outside this packet.

Additional uncommitted bench and Terminal-Bench changes appeared concurrently
while this packet was being researched. They were preserved and are not treated
as a landed ProMax baseline. PMX implementation must start by freezing a clean
current SHA and re-auditing any overlapping family, preset, corpus, and remote
routing changes; a dirty overlay is not acceptance evidence.

## Decision

Add ProMax as a new `promax` dataset family nested under
`benchmarkSuite: "swe-bench"`. Do not alias it to the existing
ScaleAI `pro` family: the corpus schema, prediction contract, evaluator, images,
and result semantics are different.

`benchmarkSuite: "promax"` is invalid. ProMax extends the SWE family registry;
Terminal-Bench extends the outer suite registry.

The pinned upstream evaluator is an immutable executable dependency. Quanta may
invoke it and classify its output, but must not copy its logic into TypeScript,
patch it, or silently replace its Docker behavior.

## Integration authority - no duplicate framework

ProMax extends the existing bench framework; it does not create a parallel
bench stack. The following ownership is normative for every PMX ticket:

| Concern | Existing canonical owner | ProMax delta | Forbidden duplicate |
|---|---|---|---|
| suite dispatch and typed union | [BFND-01](../../aug-21-bench-foundation/tickets/BFND-01-suite-and-config.md) | consume the `swe-bench` branch | a `promax` suite or product-local suite union |
| CLI/env resolution and typed SWE config | [jun-30 T2](../../jun-30-bench-modularity-extensibility/tickets/02-typed-bench-config-ssot.md) | add typed ProMax family fields | a second ProMax config resolver or in-process argv-to-env bridge |
| family behavior registry | [jun-30 T4](../../jun-30-bench-modularity-extensibility/tickets/04-extension-profiles-and-backend-ports.md) | register one `promax` profile | a second registry under `promax/` or scattered `family === "promax"` branches |
| public task/repository preparation | `src/runner/batch/corpus/**` | safe public projection and JSON-array adapter | a ProMax clone/checkout/corpus runner |
| evaluator and Docker image lifecycle | `src/apps/bench/harness/**` | `harness/promax/**` adapter and image receipt implementation | evaluator/image semantics inside remote provisioning code |
| remote provisioning, transport, retry, and coverage | `src/apps/bench/remote/**` | carry the resolved profile and generic grade receipts | a ProMax-only remote backend or verdict parser |
| grade disposition | `src/runner/batch/eval/**` | generic SWE official-grade disposition used by ProMax | ProMax-only remote verdict payload |
| report envelope/persistence | [BFND-02](../../aug-21-bench-foundation/tickets/BFND-02-canonical-report-envelope.md) | add generic official-grade totals to the SWE report branch | ProMax writer, report root, or top-level schema |
| dashboard dispatch | [BFND-03](../../aug-21-bench-foundation/tickets/BFND-03-dashboard-projectors.md) | render ProMax inside the SWE projector | top-level ProMax projector or independent score/coverage derivation |
| upstream bundle provenance | `src/apps/bench/promax/provenance/**` | immutable ProMax manifest validation | another parser in the tool, remote, or dashboard layers |

BFND-01 and the existing T2/T4 tickets are prerequisites, not text to reimplement
inside PMX-01. If their implementation is absent at the frozen start SHA, land
them as generic foundation first. PMX-01 then contains only the `promax`
registration and required fail-closed hardening. One commit series may close the
gates, but the code must still have one suite config owner, one typed SWE config
owner, and one family profile registry.

## Verified upstream snapshot

Checked against these primary sources on 2026-08-21:

- upstream repository: <https://github.com/key4127/SWE-Bench-ProMax>
- upstream commit: `77041028bc4e2135644b63b504aa961a68aafbb6`
- Hugging Face dataset: <https://huggingface.co/datasets/swe-bench-promax/SWE-Bench-ProMax>
- Hugging Face revision: `8ee33ee5321b3572cc6c20e3a2392f04683174b2`
- `swe-bench-promax.json` SHA-256:
  `f1f084836da779f58fe4150fb786d22c54d0f848d232dd3106aeff4b2dfcc7e9`
- `eval.json` SHA-256:
  `5730a8003ebb7b720b3c6580d54d0c7c1b5a50970b771f4a3850144aaeb74bbf`
- `test_run.py` SHA-256:
  `af2ee720de8a51a921f4af2617937c45f4e3b983549b640756b0fa8b2c1bf42d`

At this snapshot, the GitHub and Hugging Face data files are byte-identical,
the dataset and eval ID sets are exactly equal, and both contain 170 IDs. The
sorted ID-set digest is
`19944e595bcace14b7dd77a341367dc6b93f2d40758854472c50ba6c1adad8ff`.

Language counts are C 20, C++ 22, Go 23, Java 26, Python 29, Rust 22, and
TypeScript 28. `working_dir` has four observed values, but the pinned evaluator
applies patches under hard-coded `/testbed`; Quanta must preserve `working_dir`
as raw metadata without changing evaluator semantics.

These hashes are research evidence, not forever-default constants. PMX-00 must
refresh and explicitly approve them at implementation start because upstream is
actively maintained and advertises a v2.

## Upstream evaluator facts that shape this plan

The pinned `test_run.py`:

- invokes Docker through `subprocess.run(..., shell=True)`;
- evaluates both the model patch and the golden patch;
- emits `passed`, `model`, and `golden` per instance;
- exposes `SUCCESS`, `APPLY_FAILED`, `TEST_PATCH_APPLY_FAILED`, `TIMEOUT_APPLY`,
  `TIMEOUT_EVAL`, `NON_ZERO_EXIT`, and `NEED_HUMAN_REVIEW`;
- can promote equal model/golden stdout, stderr, and reason to `SUCCESS` when no
  timeout or model apply error was recorded;
- summarizes only golden-success rows in its headline denominator.

Therefore `passed` and the printed pass rate are not Quanta's reporting SSOT.
The official result file remains authoritative raw evidence; Quanta adds a
lossless four-state projection and always reports coverage.

## Non-negotiable invariants

1. `pro` and `promax` never share a grader or report partition.
2. Explicit unknown dataset families fail; only an absent selector defaults to
   `verified`.
3. Agent-visible data and grader-only data are different types and storage
   roots. Gold patch, test patch, eval script, golden output, and derived image
   receipts never enter the agent workspace, prompt, repo map, or index root.
4. The official evaluator runs from an exact commit with verified file hashes.
5. Raw official output, wrapper stdout/stderr, command argv, exit status, and
   artifact digests are retained.
6. Every instance records source image reference, registry digest, local image
   ID, and platform. Mutable tags alone are not replay evidence.
7. Headline reporting includes `assigned`, `grading_valid`, `resolved`,
   `model_miss`, `infra_invalid`, `ambiguous`, and `missing`.
8. `PMX-7 ⊂ PMX-14 ⊂ PMX-40 ⊂ PMX-170` is one deterministic nested
   sample family, not four independently chosen samples.
9. Full model inference is forbidden before PMX-170 gold preflight closes.
10. New behavior lives in cohesive `promax/` and remote helper modules. Do not
    grow near-limit `run-main.ts`, `box-session.ts`, or `ec2-lifecycle.ts` beyond
    thin composition wiring. `promax/` may own provenance and family-specific
    projections; evaluator/image behavior belongs to `harness/promax/`, generic
    grade/report types belong to runner, and remote owns transport only.

## Foundation gate

Before PMX-01 implementation:

1. freeze a clean current SHA and classify every overlapping dirty bench change;
2. verify or land BFND-01's suite/config discriminated union;
3. verify or land jun-30 T2 typed config without in-process env mutation;
4. verify or land jun-30 T4's single `DatasetFamilyProfile` registry for
   `verified`, `live`, and `pro`;
5. prove local/full/pool/chunk consumers receive the same resolved profile;
6. record a static inventory of raw family env reads and legacy verdict bucket
   consumers so later tickets can prove the count only goes down.

Before PMX-05 implementation, BFND-02 and BFND-03 must own the shared report
envelope/writer and dashboard projector registry. PMX-05 adds only SWE/ProMax
payload fields and family rendering.

An env variable may serialize typed configuration across a real subprocess/SSH
boundary. It is not an authority channel between functions in one process.

## Execution order

| Order | Ticket | Gate closed |
|---:|---|---|
| F0 | [BFND-01](../../aug-21-bench-foundation/tickets/BFND-01-suite-and-config.md) + jun-30 T2 + T4 | one suite config, one typed SWE config, one family registry |
| 0 | [PMX-00](./PMX-00-upstream-provenance.md) | upstream and artifact identity |
| 1 | [PMX-01](./PMX-01-family-and-config.md) | `promax` registration through the existing typed route |
| 2 | [PMX-02](./PMX-02-corpus-boundary-and-samples.md) | 170-row ingest, no-leak types, nested samples |
| 3 | [PMX-03](./PMX-03-official-evaluator-and-outcomes.md) | immutable harness adapter and generic grade receipt |
| 4 | [PMX-04](./PMX-04-remote-and-image-provenance.md) | reproducible Docker execution through the existing remote backend |
| F1 | [BFND-02](../../aug-21-bench-foundation/tickets/BFND-02-canonical-report-envelope.md) + [BFND-03](../../aug-21-bench-foundation/tickets/BFND-03-dashboard-projectors.md) | shared report persistence and suite projector registry |
| 5 | [PMX-05](./PMX-05-reporting-and-dashboard.md) | SWE-branch denominator/coverage SSOT and render-only ProMax family view |
| 6 | [PMX-06](./PMX-06-campaign-gates.md) | PMX-7/14/40, Gold-170, then Full-170 |

F0 and PMX-00 may proceed independently. PMX-01 starts only after F0; pure
PMX-02 manifest/projection work may overlap once the profile interface is frozen.
PMX-03 depends on the grader-only view from PMX-02 and owns the generic remote
grade-receipt contract required by PMX-04. PMX-05 may build fixtures after
PMX-03 freezes that contract, but implementation consumes landed BFND-02/03 while
PMX-04 handles live infrastructure.

## Score contract

For a campaign with assigned set `A`:

```text
assigned = resolved + model_miss + infra_invalid + ambiguous + missing
grading_valid = resolved + model_miss
official_valid_rate = resolved / grading_valid
coverage = grading_valid / assigned
raw_rate = resolved / assigned
```

All three rates are shown together. A smaller valid denominator must never make
a run look better without the corresponding coverage loss being visible.

## Campaign flow

```text
Foundation BFND-01..03 + T2/T4 + PMX-00..05 static and hermetic rails
  -> PMX-7 gold sentinel: 7/7 golden SUCCESS
  -> same PMX-7 model smoke: 7/7 grading-valid
  -> PMX-14 canary: 14/14 grading-valid
  -> PMX-40 paired control/candidate
  -> predeclared continuation rule says continue
  -> PMX-170 gold sentinel preflight
  -> 170/170 golden SUCCESS, or versioned upstream-exception manifest
  -> PMX-170 model run
```

The gold sentinel is deliberately an apply-failing model prediction, not the
gold patch copied into `model_patch`. Using gold as both model and golden can hit
the upstream equal-output SUCCESS promotion and produce a vacuous preflight.
Gold gates inspect `golden.final_result`; they do not trust `passed`.

## Packet done

- PMX-14 is 14/14 grading-valid on an exact Quanta SHA.
- PMX-40 paired reports reproduce from the same manifests and budgets.
- PMX-170 gold preflight covers all 170 assigned instances, with any exception
  explicitly versioned instead of deleted from the denominator.
- Every report carries dataset, evaluator, image, Quanta, model, preset, budget,
  and dirty-state provenance.
- No report or dashboard merges `pro` with `promax`, hides missing rows, or calls
  a dirty-overlay/canary result a full benchmark result.
- A source/consumer inventory demonstrates one config resolver, one profile
  registry, one harness adapter, one remote grade-receipt contract, one report
  aggregation function, and one SWE projector registration; no ProMax-only
  parallel framework remains.
