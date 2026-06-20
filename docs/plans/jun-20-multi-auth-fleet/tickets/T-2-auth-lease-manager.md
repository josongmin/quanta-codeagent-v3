# T-2: AuthLeaseManager

**Priority:** P0 · **Size:** L · **Deps:** [T-1](T-1-auth-pool-manifest-and-resolver.md) · **Posture:** pure-core

## Deliverable

Implement a pure in-memory `AuthLeaseManager` that owns per-account capacity,
cooldown, and release accounting.

It answers:

- which account can accept a new chunk now,
- how many slots it can consume,
- whether a 429 should cool down only this account,
- whether the next worker should wait, pick another account, or fail.

```ts
type AcquireRequest = {
  requestedSlots: number
  runId: string
  preferredAccountLabel?: string
}

type AuthLease = {
  accountLabel: string
  authFile: string
  grantedSlots: number
  release(result: {
    rateLimited: boolean
    lostBox: boolean
    completed: boolean
  }): void
}
```

## Touch files

- new `src/apps/bench/auth-pool/lease-manager.ts`
- `src/apps/bench/auth-pool/index.ts`
- new `tests/unit/bench-auth-lease-manager-hellgate.test.ts`

## Acceptance criteria

- [ ] account cannot exceed `maxParallel`
- [ ] account cannot exceed `maxBoxes` when configured
- [ ] 429 on account A cools down only A
- [ ] healthy account B can keep leasing while A cools down
- [ ] release always returns slots, even on throw / requeue / lost box
- [ ] deterministic tie-break rule exists (`preferred` > least-loaded > stable label order)

## Hellgates

- `bun test tests/unit/bench-auth-lease-manager-hellgate.test.ts`

Red cases this ticket must pin:

- slot leak after chunk requeue
- global backoff still fires when only one account was rate-limited
- a cooled-down account is immediately picked again
