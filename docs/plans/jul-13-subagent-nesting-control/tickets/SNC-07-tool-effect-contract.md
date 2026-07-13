# SNC-07 — required tool-effect contract and exhaustive annotation

**Priority:** P1
**Depends on:** SNC-05, SNC-06
**Parallelizable:** no

## Objective

Make every runtime tool state whether it spawns, manages, observes, or does not affect descendant agents. Omission must be a compile error.

## Owned surfaces

- `src/tool/types.ts`
- tool factories across `src/tool/**`, `src/agent/tier1/**`, and app-injected tools
- `src/tool/surface/gated-tools.ts`
- `tests/unit/tool-agent-effect-parity-hellgate.test.ts` (new)

## Contract

```ts
type AgentToolEffect =
  | "none"
  | "spawn-descendant"
  | "manage-descendant"
  | "observe-descendant"
```

`ToolCore.agentEffect` is required. Do not make it optional and do not provide a registry fallback.

## Classification requirements

- spawn: `agent`, `spawn_agent`, `spawn_batch`, `spawn_agents_on_csv`, `run_workflow`, `subagent_fork`, `delegate`, `branch_search`, `git_review_diff`
- manage: stop/close/input/force-background controls
- observe: output/wait/list/poll/await/introspection
- none: team membership, mailbox coordination, and all unrelated tools

## Implementation sequence

1. Add the required union and let typecheck enumerate missing factories.
2. Annotate `none` mechanically in bounded directory batches.
3. Classify descendant tools from behavior, not names.
4. Add parity against `GATED_TOOLS.risk` and the known spawn-port consumers.
5. Ensure namespaced/cloned tools preserve `agentEffect` via spread.

## Acceptance

```sh
bun run typecheck
bun test tests/unit/tool-agent-effect-parity-hellgate.test.ts
bun test tests/unit/tool-surface-manifest-hellgate.test.ts
bun test tests/unit/capability/capability-exposure-matches-reality-hellgate.test.ts
bun test tests/unit/god-code-ratchet.test.ts
```

## Stop rule

Stop if `none` is inferred by absence or if a name list becomes the runtime authority.

