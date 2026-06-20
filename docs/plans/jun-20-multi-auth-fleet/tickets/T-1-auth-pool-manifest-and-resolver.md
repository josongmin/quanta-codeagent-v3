# T-1: AuthPool manifest + resolver

**Priority:** P0 · **Size:** M · **Deps:** — · **Posture:** type-lock

## Deliverable

Add a typed `AuthPool` manifest loader so bench entrypoints can resolve either:

1. the legacy single `QUANTA_BENCH_AUTH_FILE`, or
2. a multi-account manifest via `QUANTA_BENCH_AUTH_POOL` / `--auth-pool`.

This ticket only defines the contract and resolver. It does **not** schedule work.

```ts
type AuthPoolEntry = {
  label: string
  authFile: string
  maxParallel: number
  maxBoxes?: number
  cooldownBaseSec?: number
  weight?: number
  disabled?: boolean
}

type AuthSource =
  | { kind: "single"; authFile: string }
  | { kind: "pool"; accounts: readonly AuthPoolEntry[] }
```

## Touch files

- new `src/apps/bench/auth-pool/types.ts`
- new `src/apps/bench/auth-pool/load.ts`
- new `src/apps/bench/auth-pool/index.ts`
- `src/apps/bench/cli.ts`
- new `tests/unit/bench-auth-pool-load-hellgate.test.ts`
- new `tests/integration/bench-auth-pool-cli-dry-run.test.ts`

## Acceptance criteria

- [ ] duplicate / empty account labels fail fast
- [ ] `maxParallel <= 0` is rejected
- [ ] unset pool => current single-auth path unchanged
- [ ] dry-run may read the manifest, but must not read auth JSON contents
- [ ] dry-run prints account labels only, never file contents
- [ ] resolver shape is shared by `pool` and `grade --mode full`

## Hellgates

- `bun test tests/unit/bench-auth-pool-load-hellgate.test.ts`
- `bun test tests/integration/bench-auth-pool-cli-dry-run.test.ts`

Red cases this ticket must pin:

- manifest silently accepts duplicate labels
- pool path changes behavior even when only `QUANTA_BENCH_AUTH_FILE` is set
- dry-run touches on-disk token files
