# SNC-09 — persisted handle V2 and receipt-before-run

**Priority:** P0
**Depends on:** SNC-03, SNC-04
**Parallelizable:** yes, with SNC-05/SNC-06 on disjoint files

## Objective

Persist validated lineage and policy provenance before a background child loop can start.

## Owned surfaces

- `src/agent/subagent-persistence-store/types.ts`
- `src/agent/subagent-persistence-store/jsonl-store.ts`
- `src/agent/subagent-persistence-store/hydrating-scheduler.ts`
- `src/agent/subagent-background/**` persistence integration only
- `tests/unit/subagent-persistence-v2-hellgate.test.ts` (new)

## Required changes

1. Introduce explicit `PersistedHandleV2` with `version:2`, lineage, and policy receipt.
2. Keep a parser that distinguishes V1 from malformed V2; do not coerce V1 into root lineage.
3. Validate safe integers, discriminants, and policy digest on decode.
4. Enforce `grant issued -> receipt durable save -> grant receipt_committed -> child start`.
5. On save failure, create no child loop and return a typed persistence failure.
6. Preserve lineage fields in every later status snapshot.

## Hellgates

- valid V2 round trip
- torn/corrupt JSONL tail and malformed lineage
- unsafe depth and digest mismatch
- receipt write failure starts zero loops
- status transitions cannot drop lineage
- V1 is recognizable but not resume-authorized

## Acceptance

```sh
bun test tests/unit/subagent-persistence-v2-hellgate.test.ts
bun test tests/unit/subagent-persistence-hellgate.test.ts
bun test tests/unit/subagent-persistence-hydrate-hellgate.test.ts
bun test tests/unit/subagent-persistence-jsonl-hellgate.test.ts
bun run typecheck
```

## Stop rule

Stop if the store interface allows a `running` V2 handle without a lineage receipt.

