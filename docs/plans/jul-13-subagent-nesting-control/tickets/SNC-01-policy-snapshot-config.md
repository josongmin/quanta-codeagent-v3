# SNC-01 — immutable policy snapshot and config migration

**Priority:** P0
**Depends on:** SNC-00
**Parallelizable:** no

## Objective

Resolve one validated `SpawnPolicySnapshotV1` at root assembly and remove live policy re-reads from descendant admission/projection.

## Owned surfaces

- `src/agent/spawn-authority/policy.ts` (new)
- `src/shared/runtime-config.ts`
- `src/shared/runtime-config/types.ts`
- `src/shared/runtime-config-knobs/knobs-a.ts`
- `src/shared/knob-overrides.ts`
- policy-focused tests

## Required changes

1. Add canonical `maxDescendantDepth` validation using `Number.isSafeInteger` and non-negative bounds.
2. Resolve `QUANTA_MAX_DESCENDANT_DEPTH`; support documented legacy aliases only at root config assembly.
3. Same-valued aliases are accepted with deprecation evidence; conflicting values fail with `policy_conflict`.
4. Add every supported depth alias to `SESSION_FORBIDDEN_KNOBS`.
5. Compute stable `policyId` from canonical fields, not source env names.
6. Keep runtime default `3` in this ticket. The target `1` flip belongs only to SNC-12.
7. Per-call requested caps are not stored in the host snapshot and can only tighten later admission.

## RED rail

Add `tests/unit/subagent-policy-snapshot-hellgate.test.ts` covering invalid/unsafe values, aliases, conflicts, stable digest, and knob override rejection.

## Acceptance

```sh
bun test tests/unit/subagent-policy-snapshot-hellgate.test.ts
bun test tests/unit/runtime-config-knobs-default-parity-hellgate.test.ts
bun test tests/unit/runtime-config-knobs-parity-hellgate.test.ts
bun test tests/unit/web-daemon/api-knobs-no-leak-hellgate.test.ts
bun run typecheck
```

## Stop rule

Stop if compatibility requires silent precedence or a descendant reads `runtimeConfig()` to reconstruct policy.

