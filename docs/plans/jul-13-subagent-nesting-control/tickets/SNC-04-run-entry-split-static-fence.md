# SNC-04 — root/descendant run entry split and AST fence

**Priority:** P0
**Depends on:** SNC-03
**Parallelizable:** no

## Objective

Split the public execution surface into explicit root and descendant entries while keeping one private kernel.

## Owned surfaces

- `src/agent/loop/entry.ts`
- `src/agent/loop.ts`
- `src/agent/index.ts`
- `tests/unit/agent-run-authority-fence-hellgate.test.ts` (new)
- SNC-00 call-site inventory fixture

## Required changes

1. Add `runRootAgent(rootGrant, config)` and `runDescendantAgent(spawnOrResumeGrant, config)`.
2. Route both through a non-exported kernel.
3. Consume the grant before the loop begins.
4. Keep a temporary compatibility entry only for call sites frozen by SNC-00; each must be classified and burned down by SNC-06.
5. AST gate fails on kernel export/import, unclassified direct `runAgent`, or descendant-shaped config passed through root entry.
6. Preserve test injection via a typed execution port, not unrestricted `typeof runAgent` authority.

## Acceptance

```sh
bun test tests/unit/agent-run-authority-fence-hellgate.test.ts
bun test tests/unit/subagent-spawn-callsite-inventory-hellgate.test.ts
bun test tests/unit/agent-prewarm-loop-wire-hellgate.test.ts
bun run typecheck
```

## Stop rule

Stop if the AST fence requires an open-ended allowlist or if the private kernel remains importable.

