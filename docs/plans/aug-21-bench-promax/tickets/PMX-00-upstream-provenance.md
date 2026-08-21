# PMX-00 - freeze upstream and provenance bundle

**Priority:** P0

**Depends on:** none

**Blocks:** every other PMX ticket

## Goal

Create one fail-closed manifest that proves which ProMax dataset, eval metadata,
evaluator, and instance set a campaign uses. Do not let a Hugging Face revision
and a mismatched GitHub evaluator commit form an untracked hybrid.

## Required manifest

At minimum:

```text
schema_version
captured_at
upstream_repo_url
upstream_git_commit
hf_repo_id
hf_dataset_revision
dataset_path + sha256
eval_path + sha256
evaluator_path + sha256
dataset_count
dataset_ids_sha256
eval_ids_sha256
language_counts
```

Store the upstream checkout and gold-bearing files outside the Quanta source
tree. Store only the manifest and non-secret receipt schema in git. Copy the
resolved manifest into each campaign artifact directory.

## Required checks

- exact set equality: dataset IDs = eval IDs = manifest IDs;
- count 170 at the frozen v1 snapshot;
- unique, non-empty `instance_id`;
- required dataset fields have correct primitive types;
- every eval record has a non-empty `eval_script`;
- each data/eval/evaluator hash matches the manifest before any run;
- upstream checkout is detached at the declared commit;
- no fallback to `main`, `latest`, or an unverified local file.

## Suggested owners

- one pure manifest/check implementation under
  `src/apps/bench/promax/provenance/**`;
- a thin operator command under `tools/bench-promax/` that imports that exact
  validator for fetch/verify/print and does not parse the manifest itself. It is
  an offline provenance tool, not a bench runner or config resolver;
- frozen bundle root and Python path fields added to jun-30 T2's resolved bench
  config inside BFND-01's `swe-bench` branch, then exposed through the registered
  `promax` profile.

Do not put this logic in `run-main.ts`, remote bootstrap, the harness adapter, or
the dashboard. Those consumers receive only a validated immutable manifest or a
digest-addressed artifact reference.

## Ownership boundary

PMX-00 owns source identity and bundle validation only. It does not own:

- dataset-to-agent projection or nested sampling (PMX-02);
- evaluator invocation or outcome classification (PMX-03);
- Docker pull/inspect/platform receipts (PMX-04);
- report aggregation or dashboard rendering (PMX-05).

Every layer consumes the same validated manifest bytes. No consumer may create a
second relaxed schema, silently fill absent fields, or re-fetch moving upstream.

## Tests

- known-good 170/eval fixture manifest validates;
- one missing eval ID fails with that ID;
- duplicate dataset ID fails;
- one-byte evaluator mutation fails its SHA check;
- upstream and HF data with unequal hashes fail;
- empty selector/path never downloads `latest` implicitly;
- tool and runtime entrypoints produce the same validation result and manifest
  digest for identical bytes;
- the operator tool cannot launch a run, resolve model/preset knobs, or write a
  canonical bench report;
- anti-vacuum assertion proves the test fixture contains the expected known IDs.

## Definition of done

- a campaign cannot reach dataset parsing or Docker without a verified bundle;
- the manifest prints enough information to reproduce the exact upstream state;
- the report path receives the exact manifest bytes or their digest plus an
  immutable artifact link.

## Stop rule

If current upstream differs from the snapshot in `README.md`, stop and produce a
reviewable manifest diff. Do not refresh hashes in place and continue silently.
