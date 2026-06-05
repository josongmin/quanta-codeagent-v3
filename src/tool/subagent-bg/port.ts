/** Duck-typed mirror of `BackgroundSubagentScheduler` from
 *  `@/agent/subagent-background` (ADR-0130). Kept here so the `@/tool` slice
 *  does NOT import `@/agent` (slice fence, RFC §3.1; biome enforces).
 *
 *  MIRROR INVARIANT — this file mirrors ONLY the tool-exposed subset of the
 *  producer: `fork` / `poll` / `await`. The producer's broader scheduler also
 *  exposes `cancel` / `list` / `prune` / persistence helpers, but the current
 *  `@/tool/subagent-bg` slice does not surface tools for them. Widen this port
 *  only when a new tool actually needs that method.
 *
 *  Reviewers MUST keep the shared result/status shapes in sync with the
 *  producer. `tests/unit/subagent-background-hellgate.test.ts` seals both the
 *  status union and the minimal 3-method tool port.
 *
 *  Contract preserved here:
 *   - `fork()` may throw the producer's typed cap-exceeded error.
 *   - `poll()` / `await()` are no-throw; the tools map `null` to
 *     `unknown-handle: ...` ToolResults. */

export type SubagentBgHandleId = string

export type SubagentBgStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

/** Closed outcome of `forceBackground` (ADR-0487) — mirror of the producer's
 *  `ForceBackgroundOutcome`. No-throw; the tool maps each arm to a stable
 *  ToolResult line. */
export type SubagentBgForceOutcome =
  | "promoted_now"
  | "moved_to_front"
  | "already_running"
  | "not_found"
  | "queue_disabled"

export interface SubagentBgResult {
  readonly status: SubagentBgStatus
  readonly outputSummary: string
  readonly outputDetail?: string
  readonly errorMessage?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly turns: number
}

export interface SubagentBgSpec {
  readonly task: string
  readonly modelOverride?: string
  readonly maxTurns?: number
  readonly workspace?: string
  readonly metadata?: Readonly<Record<string, string>>
}

/** Narrow scheduler port the shipped tools consume. The producer-side
 *  `BackgroundSubagentScheduler` is a strict superset.
 *
 *  MIRROR INVARIANT — `forceBackground` (ADR-0487) is added because the
 *  `subagent_force_background` tool surfaces it; `cancel`/`list`/`prune`/
 *  persistence remain unmirrored (no tool needs them yet). */
export interface BackgroundSubagentSchedulerPort {
  fork(spec: SubagentBgSpec): SubagentBgHandleId
  poll(id: SubagentBgHandleId): SubagentBgResult | null
  await(id: SubagentBgHandleId, opts?: { signal?: AbortSignal }): Promise<SubagentBgResult | null>
  /** Promote a queued handle to run NOW (or the FIFO head). No-throw; returns
   *  a closed {@link SubagentBgForceOutcome}. ADR-0487. */
  forceBackground(id: SubagentBgHandleId, opts?: { allowBurst?: boolean }): SubagentBgForceOutcome
}
