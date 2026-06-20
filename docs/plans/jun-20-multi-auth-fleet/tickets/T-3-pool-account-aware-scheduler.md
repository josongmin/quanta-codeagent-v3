# T-3: pool account-aware scheduler

**Priority:** P0 · **Size:** L · **Deps:** [T-1](T-1-auth-pool-manifest-and-resolver.md), [T-2](T-2-auth-lease-manager.md) · **Posture:** default-OFF unless pool configured

## Deliverable

Wire `AuthLeaseManager` into `pool` so each chunk acquires an account lease
before it provisions or reuses a box.

Chosen routing unit:

- **chunk gets one account lease**
- box reuse prefers the same `accountLabel`
- if only another idle box exists, the worker may reuse it and overwrite the
  stripped auth file for this chunk

This ticket is the core scheduling change.

## Touch files

- `src/apps/bench/cli.ts`
- `src/apps/bench/remote/pool.ts`
- `src/apps/bench/remote/box-session.ts`
- new `tests/unit/bench-pool-auth-lease-hellgate.test.ts`
- new `tests/integration/bench-pool-auth-pool-cli-dry-run.test.ts`

## Acceptance criteria

- [ ] chunk acquires a lease before box launch / reuse
- [ ] worker releases the lease on success, requeue, and throw
- [ ] same-account idle box is preferred over a fresh launch
- [ ] other-account idle box may still be reused if policy allows
- [ ] `workers=2` with two healthy accounts can drain two chunks concurrently
- [ ] same account cannot be oversubscribed past its slot budget
- [ ] pool dry-run shows per-chunk account selection plan
- [ ] legacy single-auth path remains byte-identical when no pool is configured

## Hellgates

- `bun test tests/unit/bench-pool-auth-lease-hellgate.test.ts`
- `bun test tests/integration/bench-pool-auth-pool-cli-dry-run.test.ts`

Red cases this ticket must pin:

- lease acquired after box launch (wrong ownership order)
- requeued chunk loses its lease accounting
- pool still applies only one global "shared OAuth" backoff lane
