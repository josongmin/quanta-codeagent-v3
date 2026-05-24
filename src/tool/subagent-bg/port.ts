/** Duck-typed mirror of `BackgroundSubagentScheduler` from
 *  `@/agent/subagent-background` (ADR-0130). Kept here so the `@/tool` slice
 *  does NOT import `@/agent` (slice fence, RFC §3.1; biome enforces).
 *
 *  MIRROR INVARIANT — structural equivalence with the producer. The producer
 *  side declares the canonical types; this file mirrors the SURFACE the
 *  three tools actually call (`fork` / `poll` / `await` / `cancel` is NOT
 *  surfaced as a tool, but kept in the mirror for completeness — a future
 *  `subagent_cancel` tool can pick it up without touching the port).
 *  Reviewers MUST keep both sides in sync; a consumer-side round-trip test
 *  in `tests/unit/subagent-background-hellgate.test.ts` asserts the literal
 *  status set matches between sides.
 *
 *  No throw on the SCHEDULER's await/poll/cancel/list/prune surface — that
 *  contract is preserved here exactly. The tools wrap the scheduler's
 *  surface and map any caught failure to `ok:false` ToolResults. */

export type SubagentBgHandleId = string

export type SubagentBgStatus = "running" | "completed" | "failed" | "cancelled"

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

/** Narrow scheduler port the 3 tools consume. The producer-side
 *  `BackgroundSubagentScheduler` is a superset — `list` / `cancel` / `prune`
 *  are present on the concrete but the tool surface only consumes
 *  fork/poll/await today. A future tool can extend the port. */
export interface BackgroundSubagentSchedulerPort {
  fork(spec: SubagentBgSpec): SubagentBgHandleId
  poll(id: SubagentBgHandleId): SubagentBgResult | null
  await(id: SubagentBgHandleId, opts?: { signal?: AbortSignal }): Promise<SubagentBgResult | null>
}
