# Multi-agent coordination — Task DAG / Leader-broker / Team-idle barrier (§4)

> Plan for the §4 backlog item "멀티에이전트 코디네이션 (Claude `--agent-teams`)".
> Status: PLANNED (jun-04). Reference: Claude Code `--agent-teams` (leader-mediated
> permission escalation + task dependency DAG + idle-notification beacon /
> team-idle barrier). Absorption target, default-OFF, SOTA++ / structural.

## 0. Why (the gap the audit found)

quanta already has the **transport** for multi-agent work but no **coordination
protocol on top**:

| Primitive | Status | File |
|---|---|---|
| Inter-agent transport (`request`/`response`/`broadcast` + `correlationId`) | ✅ | `src/agent/subagent-mailbox/` (`MailboxMessage`, `MailboxPort`) |
| Subagent spawn + registry + role (explorer/worker/none) | ✅ | `src/subagent/` (`TaskRegistry`, `AgentRole` ADR-0042) |
| Parallel fan-out (batch) | ✅ | `src/agent/tier1/subagent-batch.ts` |
| **Task dependency DAG** (blocks/blockedBy) | ❌ | — (`McpTaskInfo` is flat: `taskId/state/title/progress`) |
| **Leader-mediated permission escalation** (broker) | ❌ | — |
| **Team-idle barrier / idle beacon** | ❌ | — |

So fan-out today is flat + unordered; a worker that hits a permission wall just
fails; and the parent polls instead of awaiting a fan-in barrier.

## 1. Structural decisions

- **Home**: a new leaf slice `src/subagent/coordination/` — pure cores + ports.
  NOT `src/mcp/tasks/` (that mirrors an EXTERNAL MCP server's tasks; this is
  quanta's OWN subagent orchestration over `TaskRegistry`).
- **"Leader" = the parent agent that spawned the team.** No new `AgentRole` arm
  (`explorer|worker|none` unchanged) — the spawning agent IS the broker.
- **Reuse, don't reinvent**: broker rides `MailboxPort` (`request`/`response` +
  `correlationId`); escalation decision rides the existing `@/permission` decide
  path. Minimal new infrastructure.
- **All default-OFF**: with the knob unset, fan-out is byte-identical to today's
  flat parallel batch (no DAG ordering, no broker, no barrier).
- **Plane-clean**: `src/subagent/coordination/` imports only `@/shared` + the
  injected ports (mailbox / permission / registry) — biome fence holds.
- **No-throw, pure cores**: DAG/barrier logic is pure (testable without I/O);
  side-effects (dispatch, mailbox send, decide) are injected ports.

## 2. Three capabilities (independent slices)

### A. Task dependency DAG  (`coordination/dag.ts`, pure)
- **Model**: `TaskNode { id: string; dependsOn: readonly string[]; state: TaskState }`
  (`blockedBy` = `dependsOn`; `blocks` = derived reverse edges). Reuse the
  existing `TaskState` (`pending|in_progress|completed|failed|cancelled`).
- **Pure core**:
  - `detectCycle(nodes): { ok: true } | { ok: false; cycle: string[] }` (DFS /
    Kahn — a cyclic DAG is rejected at submit, never dispatched).
  - `readyTasks(nodes): TaskNode[]` — `pending` nodes whose every `dependsOn` is
    `completed`. A `failed`/`cancelled` dependency BLOCKS dependents (they never
    become ready) → surfaced as `blockedTasks(nodes)` so the leader sees the dead
    branch (no silent hang).
  - `onComplete(nodes, id): { nodes; newlyReady: TaskNode[] }` — mark `id`
    completed, return the nodes it unblocked.
- **Wiring**: `subagent-batch` dispatch consults `readyTasks` instead of firing
  all at once; on each child completion, `onComplete` releases dependents. Bounded
  by the existing worker ceiling. Knob `QUANTA_TEAM_DAG` (unset ⇒ flat = today).
- **Tests**: hellgate — cycle rejected; linear chain releases in order; diamond
  (A→{B,C}→D) D waits for both; failed dep blocks dependent (no hang, typed
  `blocked`); empty / single-node; ready-set is exactly the unblocked pending set.
  e2e — batch of 4 with deps fires in dependency order (capture dispatch order).

### B. Leader-mediated permission escalation  (`coordination/broker.ts`)
- **Flow**: worker hits a denied tool → sends a mailbox `request`
  (`body` = escalation envelope `{ tool, scope, reason }`, `to` = leader,
  `correlationId`) → leader's `brokerLoop` reads pending requests → calls the
  injected `EscalationDecider` (wraps `@/permission` decide / HITL) →
  approve|deny → mailbox `response` (same `correlationId`) → worker applies.
- **Pure helpers**: `parseEscalationRequest(msg)` (typed envelope or reject),
  `buildDecisionResponse(req, decision)` (correlationId round-trip), and a pure
  `brokerStep(pendingRequests, decide)` so the loop body is testable.
- **Reuse**: `MailboxPort` (transport, no new channel), `@/permission` (decide).
- **Security invariant (hellgate-sealed)**: a worker can NEVER self-grant — the
  ONLY path to a wider permission is a leader `response`; the worker applies a
  decision it did not author. (Mirrors the H2/B2 provenance posture: grants flow
  from the higher-authority source only.) Knob `QUANTA_TEAM_BROKER`.
- **Tests**: hellgate — request→decide(approve)→response round-trips the
  correlationId; deny → worker stays blocked; malformed envelope → rejected (no
  crash); a worker-authored "self-approval" message is NOT honored (the applier
  only trusts a leader-signed response); broker is idempotent on re-read.
  e2e — fake worker + fake leader over a real `createSubagentMailbox()`:
  blocked worker escalates → leader approves → worker proceeds; deny path stays
  blocked.

### C. Team-idle barrier + idle beacon  (`coordination/idle-barrier.ts`, pure)
- **Model**: `IdleBeacon { agentId: string; idleSince: number }`. A member is
  idle when it has a current beacon; the team is idle when EVERY member has one.
- **Pure core**: `teamIdle(beacons, members): boolean` (all members beaconed) +
  `idleSince(beacons, members): number | undefined` (max idleSince once all idle
  — the barrier-release timestamp). Clock injected (no `Date.now()`).
- **Wiring**: each subagent emits a beacon at turn-end (idle); the leader awaits
  `teamIdle` to fan-in (next phase / handoff / shutdown) instead of polling.
  Knob `QUANTA_TEAM_IDLE`.
- **Tests**: hellgate — partial beacons ⇒ not idle; all beacons ⇒ idle +
  release ts = max idleSince; a member re-activating clears its beacon ⇒ not
  idle; unknown member beacon ignored. e2e — 3 workers beacon one by one →
  barrier flips exactly when the last one idles.

## 3. Phasing (TDD, each phase PR-grade, default-OFF)

1. **Phase A — DAG core + batch wiring.** Highest impact, self-contained.
2. **Phase B — leader-broker.** Independent of A; rides mailbox + permission.
3. **Phase C — idle-barrier.** Smallest; pure predicate + beacon wiring.

Each phase ships: pure core + port(s) + wiring (default-OFF byte-identical) +
env knob (`runtime-config`) + feature-catalog YAML (09-integration) + hellgate +
e2e. Cores can be built in parallel (disjoint files); wiring serializes on
`subagent-batch` (Phase A) — so A's wiring lands before B/C touch the dispatcher.

## 4. Knobs (all default-OFF ⇒ byte-identical flat fan-out)

| Knob | Capability | Off behavior |
|---|---|---|
| `QUANTA_TEAM_DAG` | A | flat parallel batch (no ordering) |
| `QUANTA_TEAM_BROKER` | B | worker block stays a hard failure (today) |
| `QUANTA_TEAM_IDLE` | C | leader polls / no barrier |

## 5. Risks / invariants

- **Security (B)**: the broker is a grant path. Hellgate MUST seal "worker
  cannot self-grant; only a leader-authored response widens permission" — else
  it's a privilege-escalation hole. This is the load-bearing test.
- **Liveness (A)**: a `failed`/`cancelled` dependency must surface its dependents
  as `blocked` (typed), never an indefinite hang. Cycle is rejected at submit.
- **Coupling (A)**: DAG wiring touches `subagent-batch` dispatch — keep the
  change additive + gated (unset ⇒ the existing flat loop runs unchanged).
- **Determinism**: DAG ready-order + barrier timestamps use injected clock /
  stable tiebreak (byteCompare), never `Date.now()` / `localeCompare`
  (no-sketchy-code scanner).

## 6. Out of scope (separate items)
- Full desktop computer-use / real PTY (§5 — surface-gated native, Tauri).
- The host binding that resumes a heartbeat's target thread (H8 follow-up).
