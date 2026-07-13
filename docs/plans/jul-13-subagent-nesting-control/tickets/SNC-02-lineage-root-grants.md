# SNC-02 — explicit lineage and root grant assembly

**Priority:** P0
**Depends on:** SNC-01
**Parallelizable:** no

## Objective

Replace `undefined means root` with a validated discriminated lineage and authority-issued root grant.

## Owned surfaces

- `src/agent/spawn-authority/lineage.ts` (new)
- `src/agent/spawn-authority/root-grant.ts` (new)
- `src/host/runtime/agent-config-assembler.ts`
- `src/host/runtime/agent-arg-builder.ts`
- root assembly fixtures/tests

## Required changes

1. Implement `AgentLineageV1` root/descendant variants and total validators.
2. Root requires `kind:"root"`, `depth:0`, `rootSessionId`, and a policy snapshot.
3. Descendant requires positive safe depth and `parentAgentId`.
4. Root grant construction is available only from root composition surfaces; tests use a dedicated fixture factory.
5. Identify the canonical existing session/agent identifiers reused for `rootSessionId` and `parentAgentId`; record the decision in the report.
6. Do not add a second genealogy registry.

## RED rail

Extend `subagent-lineage-authority-red-hellgate.test.ts` for malformed discriminants, absent lineage, unsafe depth, and copied plain objects lacking the private brand.

## Acceptance

```sh
bun test tests/unit/subagent-lineage-authority-red-hellgate.test.ts
bun test tests/unit/host/host-capability-derivation.test.ts
bun run typecheck
```

## Stop rule

Stop if any production root still reaches execution only because `AgentConfig.depth` is absent.

