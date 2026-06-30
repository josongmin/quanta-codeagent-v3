# T3 — surface thinning and shared boot

**Priority:** P2  
**Depends on:** T1, T2  
**Parallelizable:** partial

## Problem

`src/apps/bench/index.ts` and `src/apps/bench/cli.ts` are still fat surfaces:

- both own terminal boot wiring
- both own OTel boot wiring
- both duplicate argv helpers
- `index.ts` still owns too much runtime/config mode selection
- `cli.ts` owns large subcommand-specific orchestration bodies

## Goal

Make `index.ts` and `cli.ts` thin host adapters:

- boot and dispatch only
- no reusable runtime semantics
- no duplicated boot/argv helpers

## Scope

- `src/apps/bench/index.ts`
- `src/apps/bench/cli.ts`
- any new app-surface helpers such as `boot.ts`, `argv.ts`, `commands/*`

## Entry conditions

- `T2` typed config seam must exist, otherwise this ticket turns into sideways code motion
- baseline line counts for `index.ts` and `cli.ts` should be recorded in the report

## Exact edit surfaces

Likely touched:

- `src/apps/bench/index.ts`
- `src/apps/bench/cli.ts`
- any new `src/apps/bench/boot*.ts`, `argv*.ts`, `commands/*`
- tests that pin surface ownership or shared bench adapter behavior

## Required changes

1. Extract shared surface-only boot helpers.
   - terminal I/O setup
   - OTel boot and teardown
   - dotenv/env default load
2. Extract shared argv/value-flag parsing helpers into one place.
3. Move subcommand bodies out of `cli.ts` where that reduces owner-local size without pushing reusable runtime semantics back into `src/apps/**`.
4. Keep surface concerns in `src/apps/bench/**`; if a helper becomes reusable runtime logic, move it below `src/apps/**`.

## Suggested implementation order

1. extract shared boot helper(s)
2. extract shared argv helper(s)
3. peel subcommand bodies into app-surface command modules
4. verify no reusable runtime semantics were stranded in `src/apps/bench/**`

## Explicit non-goals

- moving boot helpers into `src/runner/**` if they are surface-specific
- remote backend redesign; that belongs in `T4`
- selection/repair decomposition; that belongs in `T5`

## Definition of done

- `index.ts` and `cli.ts` no longer duplicate boot or argv helpers
- both files are materially smaller and read primarily as routing/composition surfaces
- reusable runtime semantics stay outside `src/apps/**`

## Deliverables

- shared app-surface helper modules
- reduced `index.ts` / `cli.ts`
- report with before/after line counts and removed duplication list

## Proof rails

```sh
bun run typecheck
bun test tests/unit/surface-coupling-ratchet.test.ts
bun test tests/unit/terminal-defaults-ratchet.test.ts
bun test tests/unit/apps/bench/shared-verify-select-adapters.test.ts
```

## Stop rule

Do not satisfy this ticket by moving code sideways between `index.ts` and `cli.ts` only. Shared duplication must actually disappear.

## Blocked if

- the shared boot helper starts importing runner semantics
- surface extraction cannot proceed because config ownership is still unresolved
