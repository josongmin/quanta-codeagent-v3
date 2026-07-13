# SNC-03 — typed admission and single-consumer grant ledger

**Priority:** P0
**Depends on:** SNC-02
**Parallelizable:** no

## Objective

Make `authorizeNewChild` the only new-edge authority and issue non-reusable `SpawnGrantV1` values.

## Owned surfaces

- `src/agent/spawn-authority/admission.ts` (new)
- `src/agent/spawn-authority/grant-ledger.ts` (new)
- `src/agent/spawn-authority/types.ts` (new)
- `tests/unit/subagent-grant-admission-hellgate.test.ts` (new)

## Required changes

1. Validate parent lineage and policy before side effects.
2. Compute checked `childDepth = parent.depth + 1` exactly once.
3. Compute `effectiveCap = min(hostCap, requestedCap)`; reject requested widening.
4. Separate `host_depth_exceeded` from `requested_depth_exceeded`.
5. Issue privately branded, nonce-backed grants.
6. Enforce atomic `issued -> consumed`; add `issued -> receipt_committed -> consumed` for persistent paths.
7. Return typed denials; expected policy/lineage failures must not reject promises.

## Hellgates

- depth overflow and every malformed input
- cap truth table `0/1/2/3`
- requested cap lower/equal/higher than host cap
- same grant consumed twice
- copied/serialized/forged grant
- denied admission creates no worktree, task, registry entry, or loop

## Acceptance

```sh
bun test tests/unit/subagent-grant-admission-hellgate.test.ts
bun run typecheck
```

## Stop rule

Stop if the grant can be reconstructed from public fields or if consume happens after child-side effects begin.

