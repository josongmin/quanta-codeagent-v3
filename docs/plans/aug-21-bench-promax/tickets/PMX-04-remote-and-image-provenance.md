# PMX-04 - remote Docker execution and per-instance image provenance

**Priority:** P0

**Depends on:** PMX-00, PMX-01, PMX-02, PMX-03

**Blocks:** live PMX-7 and larger gates

## Goal

Provision a reproducible amd64 grading box, bind the exact upstream evaluator,
and make every instance image immutable and auditable.

## Owner split

This ticket extends two existing owners without merging them:

- `src/apps/bench/harness/promax/**` owns evaluator environment preparation,
  image-reference derivation, pull/inspect/start/cp/exec preflight, digest and
  platform classification, and the resulting image receipt;
- `src/apps/bench/remote/**` owns EC2/SSH provisioning, artifact transport,
  retry/requeue, cleanup, and assigned-set coverage;
- `src/apps/bench/profiles/promax.ts` supplies the typed bootstrap specification
  selected at composition; remote code does not rediscover family behavior;
- BFND-01 supplies the outer `swe-bench` config identity; remote receives the
  resolved family profile and does not branch on `BenchmarkSuite` again;
- PMX-03's generic `OfficialGradeReceipt` is the only verdict payload returned
  through full/pool/chunk paths.

The existing `harness/` barrel remains the single external import surface for
Docker image lifecycle and official grader adapters. Remote modules may invoke
that port on-box but must not duplicate image classification, evaluator result
parsing, or ProMax command semantics.

## Required remote design

- clone/fetch the upstream repository at the exact manifest commit; never use a
  depth-1 checkout of moving `main`;
- verify all three upstream file hashes on-box before launch;
- create a dedicated Python environment for the pinned evaluator;
- require Docker daemon readiness, sufficient disk, and `linux/amd64`;
- keep evaluator workers at 1 until a measured concurrency campaign changes it;
- separate patch-generation concurrency from grader concurrency;
- thread the resolved `promax` profile/bootstrap specification into box
  provisioning and chunk command builders;
- add only generic transport/process-boundary helpers to box-session siblings.
  ProMax evaluator/image behavior stays in `harness/promax/**`; do not add large
  family branches to `box-session.ts` or `ec2-lifecycle.ts`.

## Image freeze

For all assigned instances, resolve and record:

```text
instance_id
source_image_name
registry_repo_digest
local_image_id
os
architecture
resolved_at
```

Generate a campaign-local `campaign-golden.json` from the verified source data
by replacing only `image_name` with its digest-pinned reference. Prove by a
structural diff that every other field and array order is unchanged. Preserve
both source and derived file digests in the campaign receipt.

This mechanical derivation keeps `test_run.py` immutable while preventing its
internal `docker pull <mutable-tag>` from changing image content between runs.

## Preflight

Before spending model tokens:

- pull every selected digest-pinned image;
- inspect platform and local image ID;
- prove a disposable container can start;
- prove `docker cp` and `docker exec` work;
- prove the campaign-unique gold-sentinel target path is absent;
- verify no image reference resolves to a different digest than the manifest;
- clean the disposable container, not the cached image;
- classify pull/start/cp/exec failures separately in the receipt.

This preflight is implemented once by the harness image-lifecycle owner and is
used by gold and model runs. Remote code persists/transports the returned
receipt; it does not reproduce the checks with shell-output heuristics.

The source `working_dir` values remain recorded, but the wrapper does not route
them into patch application: pinned upstream uses `/testbed`. Any resulting gold
failure becomes an explicit upstream exception candidate, not a local semantic
patch.

## Multilingual execution posture

The repository's default remote preset is `agentless-v3-thin-strict`, while the
current remote hard gate proves only `pyright-langserver`. ProMax spans seven
languages. Therefore:

- PMX integration smoke uses an explicitly frozen portable preset; it never
  inherits the repo default implicitly;
- gold-only gates do not start the Quanta agent or require an LSP;
- a product arm that claims live LSP must preflight the declared server for each
  language and report unsupported Java explicitly;
- until multilingual readiness is proven, do not use strict-LSP admission for
  the cross-language headline or infer language from gold-patch paths.

## Tests

- remote dry-run includes exact commit, paths, workers=1, and `promax` family;
- moving `main` cannot change the on-box checkout;
- source/derived golden structural diff permits only `image_name`;
- image tag resolving to a changed digest fails;
- non-amd64 platform fails before model launch;
- pull/start/cp/exec faults map to distinct infra reasons;
- local harness fake and remote transport fake produce the same typed image
  receipt schema; remote does not classify raw Docker output itself;
- full and pool preserve PMX-03 dispositions and coverage-derived missing rows
  without converting them to legacy four-bucket authority;
- ProMax env is not forwarded for Verified/Live/Pro;
- Pro env is not reused for ProMax;
- family selection is read from the resolved profile, not live process env inside
  provisioning or chunk consumers;
- box modules remain below the god-module threshold after extraction.

## Definition of done

The same campaign bundle can provision a fresh amd64 box and reproduce the same
evaluator files and image content for every assigned instance without relying on
mutable upstream branches or tags. Harness owns image/evaluator semantics, remote
owns transport/coverage, and neither duplicates the other's decisions.
