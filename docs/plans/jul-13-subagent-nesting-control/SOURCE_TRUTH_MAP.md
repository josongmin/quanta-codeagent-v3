# Source truth map

## Authority and current numeric policy

| Concern | Current owner | Required owner after migration |
|---|---|---|
| depth derivation/cap | `src/agent/spawn-depth.ts` | `src/agent/spawn-authority/**` |
| runner admission/config | `src/agent/subagent-runner.ts` | grant issuer + descendant entry |
| root assembly | `src/host/runtime/agent-config-assembler.ts`, app/eval roots | explicit root grant factory |
| direct branch child | `src/agent/branch-search-runner.ts` | descendant entry with branch grant |
| persisted handle | `src/agent/subagent-persistence-store/types.ts` | versioned lineage receipt codec |
| resume | `src/agent/subagent-resume/resumer.ts` | resume grant preserving persisted depth |
| tool contract | `src/tool/types.ts` | required `agentEffect` on `ToolCore` |
| tool manifest | `src/tool/surface/{gated-tools,manifest}.ts` | drift detector, never runtime authority |
| feature catalog | `tools/feature-catalog/features/06-tier1/0150-subagent-spawn-depth-policy.yaml` | same YAML, migrated evidence/status |

## Live discovery commands

```sh
rg -n "childDepthOf|spawnDepthCap|spawnToolsAvailable|req\.depth" src/agent src/subagent
rg -n "runAgent\(" src/agent src/apps src/runner src/side-agent
rg -n "createSubagentRunner|scheduler\.fork\(" src
rg -n "QUANTA_MAX_DESCENDANT_DEPTH|QUANTA_SUBAGENT_MAX_DEPTH|SESSION_FORBIDDEN_KNOBS" src tests
rg -n "PersistedHandle|conversationSnapshotId|resumedFrom" src/agent/subagent-persistence-store src/agent/subagent-resume
rg -n "risk: \"spawns-subagent\"|GATED_TOOLS|BASE_TOOL_NAMES" src/tool/surface
```

## Required spawn-source inventory

The `SNC-00` fixture must classify at least:

- `agent`, `spawn_agent`, `spawn_batch`, `spawn_agents_on_csv`, `run_workflow`
- `subagent_fork`, `delegate`
- `branch_search`
- `git_review_diff`, guardian reviewer
- process/in-process side-agent
- root conversation, side conversation, bench/eval root entry points

`team_create`, `team_delete`, mailbox, wait/list/output/stop tools are not child-creation sources.

## Proof ladder

1. pure validator/admission unit tests
2. owner-local runner/projection/codec tests
3. AST/import completeness gates
4. focused integration tests per producer
5. typecheck + lint + god-code ratchet
6. feature catalog validate/build/diff at closeout

