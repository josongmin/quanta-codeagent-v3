# T4 — extension profiles and backend ports

**Priority:** P1  
**Depends on:** T2, T3  
**Parallelizable:** partial

## Problem

Bench is already evolving into a multi-dataset / multi-backend platform, but the current structure still makes extension expensive:

- dataset family behavior is still partly env-driven in remote paths
- local run, grade-only, full-remote, and pool paths do not yet share a clean typed execution profile boundary
- adding a new dataset/backend/profile still risks edits across surface, remote, and runner layers

## Goal

Make future bench extension owner-local:

- one dataset/profile selection site
- one backend adapter boundary
- explicit verifier / formatter / budget / remote behavior injection

## Scope

- `src/apps/bench/index.ts`
- `src/apps/bench/dataset-family.ts`
- `src/apps/bench/remote/backend.ts`
- `src/apps/bench/remote/full.ts`
- `src/apps/bench/remote/pool.ts`
- `src/apps/bench/remote/box-session.ts`
- any new `profiles/*` or equivalent typed composition surface

## Entry conditions

- `T2` typed config seam must exist
- `T3` surface thinning should be far enough along that profile/backend composition has one obvious home

## Exact edit surfaces

Likely touched:

- `src/apps/bench/index.ts`
- `src/apps/bench/cli.ts`
- `src/apps/bench/dataset-family.ts`
- `src/apps/bench/remote/backend.ts`
- `src/apps/bench/remote/full.ts`
- `src/apps/bench/remote/pool.ts`
- `src/apps/bench/remote/box-session.ts`
- new `src/apps/bench/profiles/*` or equivalent

## Required changes

1. Introduce a typed bench execution profile boundary.
   - dataset family
   - verifier / prediction format policy
   - budget / timeout policy
   - remote launch policy
2. Introduce or tighten backend adapter interfaces so local, grade-only, full-remote, and pool paths are explicit adapters rather than special-case branches.
3. Remove remote-path dependence on env-bridged dataset family or similar hidden control flow.
4. Preserve default Verified behavior when no explicit alternate profile is selected.

## Suggested implementation order

1. define the profile/backend interfaces
2. choose the single composition site
3. route local and remote paths through the typed profile
4. remove hidden env-based family/profile discovery from remote paths
5. prove that default Verified remains stable

## Explicit non-goals

- shipping every future dataset/backend in this ticket
- reworking official grading semantics beyond what is needed for a stable extension seam
- broad report/dashboard redesign beyond required profile tagging

## Definition of done

- adding one new dataset or backend is owner-local and does not require deep edits across multiple layers
- remote code receives typed family/profile inputs rather than discovering them from env side channels
- default run path remains byte-compatible unless a non-default profile is selected

## Deliverables

- typed profile/backend interfaces
- one composition site
- report describing what file(s) a future dataset/backend now needs to touch

## Proof rails

```sh
bun run typecheck
bun test tests/unit/bench-sg-ingress-ssot-hellgate.test.ts
bun test tests/unit/bench-detached-poll-box-death-hellgate.test.ts
bun run src/apps/bench/cli.ts grade --mode full --dry-run --dataset <fixture> --backend ec2
```

Use a cheap dry-run or owner-local fake where possible. Do not require a live EC2 proof just to land the structural seam, but record what remains unverified live.

## Stop rule

If "extensibility" still means editing both surface code and deep runtime code for one new profile, the seam is not finished.

## Blocked if

- remote path behavior still depends on ad hoc env mutation from CLI code
- the chosen profile/backend interface still leaks surface-specific concerns downward
