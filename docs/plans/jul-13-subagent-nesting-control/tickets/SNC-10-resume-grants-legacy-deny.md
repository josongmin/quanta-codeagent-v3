# SNC-10 — depth-preserving resume grants and legacy fail-closed behavior

**Priority:** P0
**Depends on:** SNC-09
**Parallelizable:** no

## Objective

Resume an existing agent at its persisted depth without minting a new lineage edge.

## Owned surfaces

- `src/agent/spawn-authority/resume.ts` (new)
- `src/agent/subagent-resume/resumer.ts`
- `src/agent/subagent-resume/policy.ts`
- `tests/unit/subagent-resume-lineage-hellgate.test.ts` (new)

## Required changes

1. `authorizeResume` accepts only validated V2 lineage receipts.
2. Preserve persisted depth exactly; do not use the current caller's depth.
3. Compute future-spawn ceiling as `min(persistedCap, currentManagedCeiling)`.
4. Carry both `persistedPolicyId` and effective `policyId`.
5. Execute through `runDescendantAgent(ResumeGrantV1, ...)`, not a fresh child admission.
6. V1/missing/malformed lineage remains interrupted with `lineage_missing` or precise typed deny.
7. User-approved “restart as new task” stays a separate new execution, not resume coercion.

## Hellgates

- persisted d2 resumed from root remains d2
- persisted cap3 + current cap1 resumes d2 but exposes no new spawn
- current wider policy cannot widen persisted policy
- V1, tampered digest, and malformed depth do not fork
- resumed grant is single-consumer

## Acceptance

```sh
bun test tests/unit/subagent-resume-lineage-hellgate.test.ts
bun test tests/unit/subagent-resume-hellgate.test.ts
bun test tests/unit/subagent-resume-replay-hellgate.test.ts
bun test tests/unit/runner/subagent-resume-wire.test.ts
bun test tests/integration/resume-e2e.test.ts
bun run typecheck
```

## Stop rule

Stop if resume calls `authorizeNewChild` or `scheduler.fork(spec)` without a resume grant.

