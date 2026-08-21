# PMX-02 - corpus adapter, no-leak boundary, and nested samples

**Priority:** P0

**Depends on:** PMX-00; BFND-01; PMX-01's frozen `DatasetFamilyProfile` interface

**Blocks:** PMX-03 and live campaign gates

## Goal

Ingest the official JSON-array corpus and eval map without exposing grader-only
material to the agent. Produce one deterministic nested sample family.

## Canonical ownership

- `src/apps/bench/profiles/promax.ts` owns decoding the ProMax JSON array and
  projecting it into explicit public and grader-only artifacts during trusted
  campaign preparation.
- `src/runner/batch/corpus/**` remains the only owner of generic public task
  preparation, repository checkout/cache, and conversion into runner `Instance`.
- `src/apps/bench/harness/promax/**` receives the grader-only bundle by
  `instanceId` after generation; runner and agent code never import that bundle.
- full, pool, chunk, and dry-run call the resolved profile. None parses the
  dataset independently.
- all paths receive BFND-01's `swe-bench` config branch with
  `datasetFamily:"promax"`; corpus code does not inspect `BenchmarkSuite` again.

Do not create a second ProMax corpus runner, repository-preparation path, or
remote-only JSON parser. The existing app corpus barrel continues to re-export
the canonical runner corpus rather than becoming another implementation owner.

## Two-artifact runtime boundary

The gold-bearing official dataset is not the file consumed by the agent run.
Trusted preparation validates PMX-00, then emits:

```text
public-tasks.json
  ordered PromaxAgentTaskView rows only

grader-bundle/
  PromaxGraderTaskView rows + eval metadata + pinned manifest reference
```

Both artifacts carry source-manifest and content digests. The agent-side runtime
opens only `public-tasks.json`; it receives neither the grader-bundle path nor an
environment variable pointing to it. The harness adapter opens the grader bundle
after model patch capture. On a remote run, transport places the grader bundle
outside the agent workspace/jail and may defer transfer until generation is
complete. Selection and launchability checks use the public artifact and PMX-00
manifest ID/digest metadata, not a reread of gold-bearing rows.

## Required types

Use separate structures, with no broad raw-row object crossing the boundary:

```text
PromaxAgentTaskView
  instanceId, repo, baseCommit, problemStatement, language

PromaxGraderTaskView
  instanceId, patch, testPatch, evalScript, imageName,
  workingDir, environmentSetupCommit, source metadata
```

The agent-side `Instance` for ProMax must not carry `goldPatch`, `testPatch`, or
`evalScript`. The grader resolves its view by `instanceId` from an isolated
bundle after patch generation. Grader files must not be copied into the agent
workspace or included in repo-map/index roots.

The existing broad `SwebenchTask.raw` shape is not an acceptable ProMax public
boundary. Add or reuse a narrow generic public-task contract in runner; convert
the `PromaxAgentTaskView` to that contract at composition. Do not attach the
original ProMax row or grader-bundle path as an escape hatch.

## Dataset requirements

- support the official JSON array; do not force it through the current JSONL-only
  reader;
- require exact data/eval ID-set equality from PMX-00;
- preserve `language`, `image_name`, `working_dir`, and
  `environment_setup_commit` as grader metadata;
- keep `working_dir` raw but do not use it to alter pinned evaluator behavior;
- do not synthesize local `testCmd` from hidden eval metadata;
- do not use the gold patch to choose localization files, LSP targets, prompts,
  or tools;
- use public `language` metadata for language/toolchain preflight.

Add a ProMax-aware dataset reader to remote launchability and selection
preflight through `DatasetFamilyProfile.preflight` instead of duplicating parsing
in full and pool paths. The current JSONL-only remote preflight reader must
receive already-decoded profile rows or a generic injected reader; it must not
grow a `promax` branch.

## Nested sample manifest

Define a versioned deterministic algorithm, for example stable SHA-256 ordering
of `algorithm_version + dataset_revision + seed + language + instance_id`, with
bytewise ID tie-breaks.

- PMX-7: first 1 per language.
- PMX-14: first 2 per language; contains PMX-7.
- PMX-40 quotas:

| Language | Full | PMX-40 |
|---|---:|---:|
| C | 20 | 5 |
| C++ | 22 | 5 |
| Go | 23 | 5 |
| Java | 26 | 6 |
| Python | 29 | 7 |
| Rust | 22 | 5 |
| TypeScript | 28 | 7 |
| Total | 170 | 40 |

- PMX-170: all IDs.

Each manifest records dataset revision, seed, algorithm version, ordered IDs,
language quotas, parent subset digest, and its own SHA-256. A separate
architecture-stress sample may exist later, but must not be called PMX-40 or be
mixed with the primary language-stratified result.

The nested-sample generator may remain ProMax-specific because the current
`src/apps/bench/sampler.ts` owns Best-of-N attempt selection, not dataset subset
selection. The operator command and runtime both import one pure sample-manifest
implementation; neither reimplements ordering or quota logic.

## Tests

- official-shaped JSON array loads 170 records;
- all seven language counts match the manifest;
- data/eval mismatch, duplicate ID, missing image, or empty eval script fails;
- `PMX-7 ⊂ PMX-14 ⊂ PMX-40 ⊂ PMX-170` is asserted;
- regenerated samples are byte-identical for the same revision/seed;
- changing seed or algorithm version changes the manifest digest;
- serialized agent view contains none of `patch`, `test_patch`, `eval_script`,
  `image_name`, or golden output;
- no public task exposes a broad `raw` object containing grader fields;
- the agent runtime succeeds when the grader bundle is deliberately unavailable,
  until the separate grading step is invoked;
- filesystem/tool-jail tests prove the agent cannot open the grader bundle or
  learn its path through config, env, prompt, repo map, or index roots;
- agent workspace/index construction cannot reach the grader bundle path;
- local/full/pool/dry-run resolve the same ordered IDs through one profile reader;
- replacing the profile reader with a failing fake makes every surface fail
  before repository preparation, proving no bypass parser exists;
- a red-on-injection test adds a gold field to the agent projection and fails.

## Definition of done

The runner can prepare all 170 public task views while the grader can resolve
all 170 private views, and no shared object or filesystem root makes gold data
reachable from the agent process. Corpus parse, repository preparation, and
sample ordering each have exactly one implementation owner.
