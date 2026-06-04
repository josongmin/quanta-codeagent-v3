/**
 * Multi-agent coordination slice barrel (plan: docs/plans/multiagent-coordination.md).
 *
 * Capability A — Task dependency DAG: a pure no-throw core (`dag.ts`) + a
 * bounded effectful gate (`dag-gate.ts`) that drives it over the existing
 * parallel batch runner. Default-OFF: the composition root only wraps the
 * runner when `QUANTA_TEAM_DAG` is on AND a batch carries dependency edges.
 *
 * Slice fence (`src/subagent/**`): both modules import only `@/shared` +
 * siblings — pure leaf, no `@/mcp`/`@/agent`.
 */

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
