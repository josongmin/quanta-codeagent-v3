# SNC-11 — projection/admission telemetry and executable invariants

**Priority:** P1
**Depends on:** SNC-08, SNC-10
**Parallelizable:** no

## Objective

Emit low-cardinality metrics and structured events that can prove projection/admission/resume consistency.

## Owned surfaces

- `src/agent/spawn-authority/telemetry.ts` (new)
- authority/projection/resume call sites
- existing `AgentConfig.metrics` and trace/debug ports
- `tests/unit/subagent-spawn-telemetry-hellgate.test.ts` (new)

## Required events

- `agent.spawn.projection.v1`: once per effective registry materialization
- `agent.spawn.admission.v1`: once per spawn or resume attempt

Structured events may include ids. Metric labels are limited to source, decision, deny code, and bounded depth buckets. `policyId`, session id, agent id, task id, and handle id are forbidden metric labels.

## Executable invariants

1. admitted child depth equals parent depth plus one
2. resumed depth equals persisted depth
3. same policy + host-depth deny cannot coexist with exposed spawn projection
4. requested-cap deny may coexist with exposed projection
5. internal spawn may have `projectionDecision:null` but must have admission evidence
6. every source in the inventory emits one admission event per attempt

## Acceptance

```sh
bun test tests/unit/subagent-spawn-telemetry-hellgate.test.ts
bun test tests/unit/subagent-spawn-callsite-inventory-hellgate.test.ts
bun test tests/unit/subagent-central-projection-hellgate.test.ts
bun test tests/unit/subagent-resume-lineage-hellgate.test.ts
bun run typecheck
```

## Stop rule

Stop if telemetry failure can fail agent execution or if raw identifiers enter metrics labels.

