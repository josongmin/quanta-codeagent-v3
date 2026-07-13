# SNC-05 — migrate standard runner producers

**Priority:** P0
**Depends on:** SNC-04
**Parallelizable:** yes, with SNC-06 and SNC-09 on disjoint files

## Objective

Move the normal `createSubagentRunner` paths to central admission and remove request depth as authority or metadata input.

## Owned surfaces

- `src/agent/subagent-runner.ts`
- `src/agent/tier1/subagent.ts`
- `src/agent/tier1/subagent-batch.ts`
- `src/subagent/agent-tool.ts`
- `src/subagent/handlers-6.ts`
- workflow/CSV adapters reached from those builders
- focused subagent tests

## Required changes

1. Runner accepts parent lineage plus `SpawnSourceV1`, calls `authorizeNewChild`, then `runDescendantAgent`.
2. Remove `opts.maxDepth` production authority; tests inject a policy snapshot.
3. Remove `SubagentRequest.depth`, or retain `assertedDepth` only for mismatch telemetry during a bounded migration.
4. Use grant lineage for child config, run id, nickname/meta, hooks, mailbox parent, and task records.
5. Cover `agent`, `spawn_agent`, `spawn_batch`, `spawn_agents_on_csv`, and `run_workflow` sources exactly once.
6. Deny before worktree creation or task registration.

## Acceptance

```sh
bun test tests/unit/subagent-runner.test.ts tests/unit/subagent-6-tools-hellgate.test.ts
bun test tests/unit/subagent-batch-hellgate.test.ts tests/unit/spawn-agents-csv-hellgate.test.ts
bun test tests/integration/subagent-fork-e2e.test.ts tests/integration/subagent-6tool-hell-e2e.test.ts
rg -n "req\.depth|opts\.maxDepth|depth: parentDepth \+ 1" src/agent/subagent-runner.ts src/agent/tier1 src/subagent
bun run typecheck
```

The final `rg` may only find explicitly documented diagnostic compatibility code.

## Stop rule

Stop if different producers implement their own cap check or child-depth arithmetic.

