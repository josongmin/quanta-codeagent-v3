# PMX-03 - pinned official evaluator adapter and four-state outcomes

**Priority:** P0

**Depends on:** PMX-00, PMX-02

**Blocks:** PMX-04, PMX-05, all live gates

## Goal

Invoke the pinned upstream evaluator without reimplementing it, preserve its raw
evidence, and project each assigned instance into an honest four-state outcome.

## Canonical ownership

- `src/apps/bench/harness/promax/**` owns the process adapter, evaluator argv,
  raw artifact capture, and ProMax result classification adapter.
- `src/runner/batch/eval/**` owns the app-independent official-grade disposition
  and receipt types consumed by runner/report code.
- `src/apps/bench/remote/**` owns transport and chunk coverage, but carries the
  same generic receipt instead of parsing a ProMax-only verdict format.
- BFND-02 owns the canonical report envelope/writer. PMX-03 defines the generic
  SWE official-grade receipt consumed later by its `swe-bench` report branch; it
  does not alter the Terminal trial receipt.
- PMX-05 owns aggregation/rendering only; it must not reinterpret raw evaluator
  states.

Do not place the evaluator under `src/apps/bench/promax/evaluator`, implement a
new remote backend, or make runner import an `apps/bench` type.

## Process boundary

The TypeScript wrapper builds an argv array and spawns exactly:

```text
python <PINNED_ROOT>/src/evaluation/test_run.py
  --pred <preds.json>
  --golden <campaign-golden.json>
  --eval <PINNED_ROOT>/data/eval.json
  --output <pass-rate.json>
  --workers 1
```

`preds.json` is a JSON array of `{instance_id, model_patch}`. The wrapper does
not import, copy, or rewrite evaluator internals. Upstream use of shell strings
inside `test_run.py` is part of the pinned semantics.

## Raw receipt

Retain:

- evaluator argv, cwd, Python path/version, start/end time, exit status;
- upstream manifest and evaluator file digest;
- input prediction/golden/eval digests;
- unmodified `pass-rate.json`;
- wrapper stdout/stderr;
- per-instance official `model` and `golden` objects;
- compact classification and reason derived from those objects.

Large raw logs may live beside the report; the report carries immutable paths
and digests rather than truncating the only evidence.

## Classification authority

`passed` is retained for audit but never used alone.

| Golden official result | Model official result | Quanta outcome |
|---|---|---|
| `success` | `success` | `resolved` |
| `success` | `apply_failed` | `model_miss / patch_apply_failed` |
| `success` | `test_patch_apply_failed` | `model_miss / test_patch_apply_failed` |
| `success` | `timeout_apply` | `model_miss / model_apply_timeout` |
| `success` | `timeout_eval` | `model_miss / model_eval_timeout` |
| `success` | `non zero exit` | `model_miss / test_failed` |
| `success` | `need_human_review` | `ambiguous / upstream_need_human_review` |
| non-success known failure | any | `infra_invalid / golden_<reason>` |
| `need_human_review` | any | `ambiguous / upstream_need_human_review` |
| missing/unknown/malformed | any | `infra_invalid / schema_invalid` |

Empty or invalid predictions must still have golden authority: either run them
through the official evaluator or pair them with an already-valid, identical-
provenance gold receipt. With golden success they are model misses with an
explicit reason; they are never infrastructure holes. Missing output, process
crash, unavailable evaluator, and output-schema drift are infrastructure-invalid.

The existing `{resolved, gradingCompleted}` seam is insufficient to preserve
`ambiguous` and reason subtypes. Add an optional generic official-grade
disposition/receipt field at the runner seam, thread it through `InstanceResult`,
and preserve existing families when absent. Do not make runner code import an
apps/bench-specific type.

## Generic grade-receipt contract

PMX-03 also owns the remote result-contract migration required before PMX-04.
The current remote `{resolved, unresolved, errored, emptyPatch}` arrays cannot be
the authority for ProMax. Define one generic contract equivalent to:

```text
OfficialGradeDisposition
  state: resolved | model_miss | infra_invalid | ambiguous
  reason: stable typed reason
  grading_valid: boolean
  raw_artifact_ref + digest
  evaluator model/golden result summary

OfficialGradeReceipt
  assigned_instance_ids
  dispositions_by_instance_id
  evaluator/provenance metadata
```

`missing` is not emitted by the evaluator. Remote coverage derives it exactly as
`assigned - keys(dispositions)` after retries. Existing Verified/Live/Pro
backends adapt their outcomes into the same contract. Legacy four-array views may
be derived at an explicit compatibility boundary, but they cannot remain a
second mutable truth or drive ProMax reporting.

Terminal-Bench does not adapt Harbor trials into this contract. It is a separate
BFND-02 report branch with different completeness and scoring semantics.

## Equal-output upstream behavior

The wrapper must not attempt to correct the upstream equal-output SUCCESS
promotion. Record the pinned evaluator version and raw output so the result is
auditable. Gold preflight avoids triggering the promotion by supplying a
deterministic, syntactically valid-looking but guaranteed non-applying sentinel
model patch. Use a campaign-unique missing-path deletion hunk and prove that path
absent in every selected image before launch. Then require:

- model result is `apply_failed`;
- golden result is `success`;
- the gate ignores top-level `passed`.

Prove this sentinel contract on PMX-7 before Gold-170. Never use the golden patch
as `model_patch` for a gold preflight.

## Tests

- serializer produces an array with exactly `instance_id` and `model_patch`;
- argv/cwd are exact and contain no shell interpolation at the TS boundary;
- fixture coverage exercises every official reason and all four outcomes;
- golden non-success always prevents model scoring;
- model timeout with golden success remains a model miss;
- `NEED_HUMAN_REVIEW` remains ambiguous;
- unknown schema fails closed;
- top-level `passed:true` with non-success nested state does not forge resolved;
- sentinel gold fixture cannot become resolved through the equal-output path;
- evaluator nonzero/no-output keeps raw stdout/stderr and yields infra-invalid;
- remote receipt round-trip preserves every disposition and derives `missing`
  only from assigned-set coverage;
- duplicate instance dispositions, unknown state/reason, or a disposition for an
  unassigned ID fail closed;
- legacy bucket projections are derived from the generic receipt and cannot
  overwrite it;
- default Verified/Live/Pro `PythonSwebenchResult` behavior is unchanged.

## Definition of done

One fixture-driven classification table covers every official result state, the
official script remains byte-identical to its pinned hash, and the runner/report
and remote full/pool paths preserve resolved, model miss, infrastructure invalid,
ambiguous, and coverage-derived missing without a ProMax-only parser.
