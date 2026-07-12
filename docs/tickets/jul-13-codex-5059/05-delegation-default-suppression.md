# C5059-05 — Default-suppress unrequested delegation

- **Priority:** P0
- **Class:** TRUE-GAP
- **Effort:** S
- **Status:** READY
- **Dependencies:** none

## Goal

Use one prompt-policy source to make single-agent execution the default and allow subagent fan-out only when delegation is explicitly authorized and the work is structurally parallel.

## Current defect

The `agent` tool description recommends running many children, while neither the system prompt nor the 6-tool `spawn_agent` contract states when delegation is prohibited. This biases routine analysis toward unnecessary fan-out.

## Policy

Do not spawn unless the user, applicable repo rules, or an activated skill explicitly asks for subagents, delegation, or parallel agent work. Requests for depth, research, investigation, thoroughness, or detailed analysis are not authorization.

When delegation is authorized, spawn only if:

- subtasks are independent and meaningful;
- write sets are disjoint or children are read-only;
- parent synthesis ownership is explicit;
- expected wall-time benefit exceeds coordination cost.

## Ownership

- Put policy text in one prompt atom/directive SSOT, not duplicated across tool descriptions.
- `agent` and `spawn_agent` descriptions should describe mechanics. Any fan-out sentence must begin with the condition that delegation is already authorized.
- Wire the policy only when a subagent surface is exposed; do not add irrelevant prompt bytes to sessions without subagent tools.

## Rollout

1. Add an opt-in measurement arm first.
2. Compare current fan-out-biased prompt vs suppression policy.
3. If acceptance holds, make suppression the default and retain an explicit host override for dedicated multi-agent experiments.

## Metrics

- unauthorized/unnecessary spawn rate;
- task and verifier success;
- total tokens and wall time;
- duplicated exploration;
- write collisions/merge conflicts;
- child error propagation;
- parent synthesis failure;
- useful parallelism rate for explicitly authorized tasks.

## Acceptance

- A normal “inspect this deeply” case performs zero spawn.
- Explicit “use parallel subagents” still exposes and uses the existing fan-out paths.
- Repo/skill authorization is honored without requiring duplicate user text.
- Sequential tasks do not lose success rate.
- Explicitly parallel tasks retain useful wall-time improvement.
- Prompt snapshots prove the policy appears exactly once and default-OFF/override variants are deterministic.

## Non-goals

- Runtime prohibition of all model-initiated delegation.
- Removing subagent tools or concurrency support.
- Changing immediate slot-release semantics.
- Building a new orchestrator.

