/**
 * Correlation context threaded through an agent run (RFC-0002 §5.1).
 *
 * All fields except `runId` are optional: when unset the agent behaves
 * byte-identically to today (project-standard optional-context pattern).
 * Propagated via `AgentConfig.run?` and carried on every `TrajectoryEvent`
 * so a run can be sliced run → instance → attempt → turn → tool_use.
 */
export interface RunContext {
  /** One bench/session run. */
  runId: string
  /** SWE-bench instance under evaluation. */
  instanceId?: string
  /** Best-of-N attempt index (0-based). */
  attempt?: number
  /** ReAct turn (advanced by the loop). */
  turn?: number
  /** Tool-use id of the in-flight dispatch. */
  toolUseId?: string
}
