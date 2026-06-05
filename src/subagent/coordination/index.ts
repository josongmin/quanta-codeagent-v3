/**
 * Multi-agent coordination slice barrel (plan: docs/plans/multiagent-coordination.md).
 *
 * Capability A — Task dependency DAG: a pure no-throw core (`dag.ts`) + a
 * bounded effectful gate (`dag-gate.ts`) that drives it over the existing
 * parallel batch runner. Default-OFF: the composition root only wraps the
 * runner when `QUANTA_TEAM_DAG` is on AND a batch carries dependency edges.
 *
 * Capability B — Leader-mediated permission escalation (`broker.ts`): pure
 * envelope + helpers over the injected mailbox + a duck-typed permission
 * decider. Default-OFF (`QUANTA_TEAM_BROKER`). Load-bearing security invariant:
 * a worker can never self-grant; only a leader-authored response widens a
 * permission.
 *
 * Slice fence (`src/subagent/**`): all modules import only `@/shared` +
 * siblings — pure leaf, no `@/mcp`/`@/agent` (the mailbox + permission decider
 * are injected, duck-typed ports).
 */

export {
  applyDecisionResponse,
  type BrokerMailbox,
  type BrokerMessage,
  brokerLoop,
  brokerStep,
  buildDecisionResponse,
  type DecisionResponse,
  type EscalationDeciderPort,
  type EscalationDecision,
  type EscalationRequest,
  parseEscalationRequest,
} from "./broker"
export {
  blockedTasks,
  type CycleCheck,
  detectCycle,
  onComplete,
  readyTasks,
  type TaskNode,
  type TaskState,
} from "./dag"
export {
  type CreateGateResult,
  createDagGate,
  DAG_BLOCKED_TEXT,
  type DagGate,
  type DagRunner,
  type DagRunnerRequest,
  type DagRunnerResult,
  type GateOutcome,
  wrapRunnerWithDagGate,
} from "./dag-gate"
// Capability C — team-idle barrier (`QUANTA_TEAM_IDLE`): pure beacon transforms
// + a thin in-memory port with an injected clock. The leader fans IN by awaiting
// `teamIdle` instead of polling. Default-OFF (no beacons ⇒ no barrier).
export {
  clearBeacon,
  createIdleBarrier,
  type IdleBarrierOptions,
  type IdleBarrierPort,
  type IdleBeacon,
  idleSince,
  teamIdle,
  upsertBeacon,
} from "./idle-barrier"
