# T4 — single `DatasetFamilyProfile` backend port (headline ticket)

**Priority:** P1 — **this is the "통합 관리 편하게" payoff**
**Depends on:** T2 (typed family config + the bypass fix)
**Parallelizable:** partial

## Why this is the real consolidation lever

SWE-bench Pro already landed. The dataset-family seam (`dataset-family.ts`: `DatasetFamily = "verified" | "live" | "pro"`) exists — but family behavior is smeared across **four owner layers**, each re-deciding family with raw string compares:

1. **corpus-parse** — `runner/batch/corpus/dataset.ts` `normalizeProRow` + `parseTasksForFamily` (`dataset-family.ts:38`), today not wired into `readSwebenchTasks`
2. **grade-harness selection** — `gradeEvaluatorForFamily` (`dataset-family.ts:46`) + `buildPythonSwebench` (`run-main.ts:699`), today hard-coding the official evaluator
3. **remote env-profile** — `ec2-lifecycle.ts` `resolveSwebenchPipSpec` (:52), `resolveSwebenchNamespace` (:65, `starryzhang` vs `swebench`), `isLiveRun` (:43), shim staleness; `box-session.ts buildProEnv` (:332)
4. **preflight** — `box-session/dataset-preflight.ts`

This is exactly why T4 cannot fold into T2: making config typed fixes the *input plumbing* but not the per-family **backend port**. Adding a 5th family today means editing all four layers. This ticket makes it one.

## Goal

One typed `DatasetFamilyProfile` that owns all four family-conditional behaviors, with every consumer routed through it. Adding a dataset family becomes: implement one profile object + register it.

## Scope

- `src/apps/bench/dataset-family.ts` (promote to the profile registry / SSOT)
- `src/runner/batch/corpus/dataset.ts` (parse/normalize behind the profile)
- `src/apps/bench/run-main.ts` (`readSwebenchTasks`, `buildPythonSwebench` route through the profile)
- `src/apps/bench/remote/box-session.ts`, `remote/box-session/ec2-lifecycle.ts`, `remote/box-session/dataset-preflight.ts` (pip-spec/namespace/preflight read from the profile, not raw env)
- new `src/apps/bench/profiles/*` or an equivalent typed registry

## Required changes

1. Define `DatasetFamilyProfile` with the four behaviors as typed fields/methods:
   - `parseRow` (normalize) · `gradeEvaluator` (harness selection) · `remoteEnv` (pip-spec, docker namespace, on-box env) · `preflight`
2. Build a small registry keyed by `DatasetFamily`; `verified`/`live`/`pro` each become one profile object.
3. Route every consumer (local parse/grade in `run-main.ts`, remote env in `ec2-lifecycle.ts`/`box-session.ts`, preflight) through the resolved profile. Delete the raw `=== "pro"` / `.toLowerCase() !== "pro"` string compares.
4. Preserve default Verified behavior byte-for-byte when no alternate family is selected.

## Definition of done

- adding a dataset family touches **one place** (a new profile object + registration), provable by description in the report
- no consumer reads `QUANTA_SWEBENCH_DATASET_FAMILY` raw to branch behavior — all go through the profile
- local and remote paths share the same profile resolution (no divergent family logic)
- default Verified path is unchanged unless a non-default family is selected

## Proof rails

```sh
bun run typecheck
rg -n "=== \"pro\"|!== \"pro\"|QUANTA_SWEBENCH_DATASET_FAMILY" src/apps/bench src/runner/batch   # expect: only the profile resolver, not scattered consumers
bun test tests/unit/bench-sg-ingress-ssot-hellgate.test.ts
bun test tests/unit/bench-detached-poll-box-death-hellgate.test.ts
# add: a profile-registry unit test proving each family resolves all four behaviors
```

Use owner-local fakes; do not require a live EC2 proof to land the seam, but record what stays unverified live.

## Stop rule

If adding a hypothetical family #4 still means editing parse + grade + remote-env + preflight separately, the port is not finished — they must all resolve from the one profile.

## Blocked if

- T2's typed family field and bypass fix are not in place (parse/grade still ignore the seam)
