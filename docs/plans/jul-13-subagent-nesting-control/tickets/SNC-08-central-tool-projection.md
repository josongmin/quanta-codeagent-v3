# SNC-08 — central effective-registry projection

**Priority:** P0
**Depends on:** SNC-07
**Parallelizable:** no

## Objective

Apply spawn capability projection once after base and feature tools are merged, using the same pinned policy as admission.

## Owned surfaces

- `src/agent/spawn-authority/projection.ts` (new)
- `src/agent/session-resources.ts`
- `src/agent/loop/session-bootstrap.ts`
- `src/agent/features.ts`
- builder-local gates in `src/agent/tier1/{subagent,subagent-batch,delegate,team}.ts`
- `tests/unit/subagent-central-projection-hellgate.test.ts` (new)

## Required changes

1. Materialize base registry + `features.extraTools` first.
2. Call `projectToolsForAuthority` exactly once before prompt/schema generation.
3. Remove only `agentEffect:"spawn-descendant"` when host policy cannot admit a child.
4. Preserve manage, observe, team, and mailbox tools.
5. Remove builder-local depth gates after parity is proven.
6. Projection uses the authority's effective `policyId`; no `runtimeConfig()` read.
7. Forced/internally injected spawn still reaches runtime admission.

## Hellgates

- base-registry and feature-registry spawn tools both disappear at leaf
- namespaced spawn tool disappears without name matching
- manage/observe/team/mailbox tools remain
- a spawn effect mutated to `none` fails parity
- projection policy differs from admission policy fails

## Acceptance

```sh
bun test tests/unit/subagent-central-projection-hellgate.test.ts
bun test tests/unit/subagent-nesting-capability-absence-hellgate.test.ts
bun test tests/unit/subagent-nesting-effective-cap-ssot-hellgate.test.ts
bun test tests/integration/multi-plane-e2e-hellgate.test.ts
bun run typecheck
```

## Stop rule

Stop if filtering happens before the effective registry exists or if builder-local and central filters remain dual owners.

