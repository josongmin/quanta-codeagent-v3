/**
 * §25.1 — Declarative workflow orchestration engine: types + closed ports.
 *
 * Mirrors the harness `Workflow` tool's operator set (agent / parallel /
 * pipeline / phase + dynamic fan-out + bounded loop) but as a DECLARATIVE node
 * tree executed by a deterministic walker — NOT an arbitrary-JS interpreter
 * (that would be an unbounded sandbox surface quanta deliberately avoids). The
 * tree is built programmatically via the `@/workflow` builders; each `agent`
 * node is one subagent spawn through the injected {@link AgentRunPort}.
 *
 * SLICE: `@/workflow` — library slice. Imports ONLY `zod` (+ `@/shared` if
 * ever needed). It NEVER reaches `@/agent`/`@/subagent`/`@/tool`: the bridge to
 * a real subagent loop is the {@link AgentRunPort}, bound at the composition
 * root. This keeps the engine pure + unit-testable with a fake port.
 *
 * Default-OFF discipline: nothing runs on import. The engine acts only when a
 * caller invokes `runWorkflow(node, { agentRun })`. No clock / randomness in the
 * core (resume-safe + deterministic tests); the only effect is the injected
 * `agentRun`.
 */

import type { ZodType } from "zod"

// ============================================================================
// Context — read-only view of completed step results
// ============================================================================

/**
 * Read-only view of completed step results, addressed by step id. Builder
 * callbacks (`prompt`, `over`, `body`, `until`) receive this so a downstream
 * step can read an upstream step's structured output.
 */
export interface WorkflowContext {
  /**
   * The validated structured value (when the step declared a `schema`) or the
   * raw agent text (no schema) of a COMPLETED, SUCCESSFUL step. Returns
   * `undefined` when the step never ran, failed, was skipped, or has not yet
   * completed. Generic for caller convenience — the cast is the caller's
   * assertion (the engine stores `unknown`).
   */
  get<T = unknown>(id: string): T | undefined
  /** True iff step `id` completed successfully. */
  has(id: string): boolean
}

// ============================================================================
// Node tree (discriminated union)
// ============================================================================

/** One subagent invocation. The atom of a workflow. */
export interface AgentNode {
  readonly type: "agent"
  /** Unique across the whole workflow — results are keyed by it. A duplicate id
   *  at runtime is a fail-closed error (never a silent overwrite). */
  readonly id: string
  /** Static prompt, or a function of the prior-results context. A throwing
   *  builder fails THIS step (`builder_threw`), never the whole run. */
  readonly prompt: string | ((ctx: WorkflowContext) => string)
  /** When set, the agent's text is parsed as JSON + validated; on a mismatch
   *  the agent is re-prompted up to {@link maxRetries} times, then the step
   *  fails (`schema_invalid`). Absent ⇒ the raw text is the step value. */
  readonly schema?: ZodType
  /** Display label for progress events (defaults to `id`). */
  readonly label?: string
  /** Structured-output validation retries (default 2 ⇒ up to 3 total calls). */
  readonly maxRetries?: number
}

/** Run children IN ORDER. SOFT: a failed child does NOT skip later children
 *  (its result is simply `undefined` to downstream `ctx.get`). */
export interface SequenceNode {
  readonly type: "sequence"
  readonly children: ReadonlyArray<WorkflowNode>
}

/** Run children CONCURRENTLY with a BARRIER (await all). A failed child does
 *  not affect its siblings. The shared concurrency cap still throttles the
 *  underlying agent runs. */
export interface ParallelNode {
  readonly type: "parallel"
  readonly children: ReadonlyArray<WorkflowNode>
}

/** Naming wrapper — emits a `phase_enter` event, then runs `body`. */
export interface PhaseNode {
  readonly type: "phase"
  readonly name: string
  readonly body: WorkflowNode
}

/** Dynamic fan-out: the item list is computed at runtime from prior results,
 *  then `body` is instantiated per item. `mode` defaults to `parallel`. */
export interface FanoutNode {
  readonly type: "fanout"
  readonly over: (ctx: WorkflowContext) => ReadonlyArray<unknown>
  readonly body: (item: unknown, index: number) => WorkflowNode
  readonly mode?: "parallel" | "sequential"
}

/** Per-item staged flow with NO barrier between stages: item A can be in stage
 *  3 while item B is still in stage 1. Each stage is an agent; the prior
 *  stage's value is threaded in as `prev`. A failed stage SKIPS that item's
 *  remaining stages (`pipeline_short_circuit`); items are independent. */
export interface PipelineNode {
  readonly type: "pipeline"
  readonly over: (ctx: WorkflowContext) => ReadonlyArray<unknown>
  readonly stages: ReadonlyArray<(prev: unknown, item: unknown, index: number) => AgentNode>
}

/** Bounded repeat: run `body(iteration, ctx)` up to `maxIterations` times,
 *  stopping early when `until(ctx)` returns true (checked AFTER each
 *  iteration). The cap is a hard backstop — `until` is the intended exit. */
export interface LoopNode {
  readonly type: "loop"
  readonly maxIterations: number
  readonly body: (iteration: number, ctx: WorkflowContext) => WorkflowNode
  readonly until?: (ctx: WorkflowContext) => boolean
}

export type WorkflowNode =
  | AgentNode
  | SequenceNode
  | ParallelNode
  | PhaseNode
  | FanoutNode
  | PipelineNode
  | LoopNode

// ============================================================================
// Ports — closed seams (bound at the composition root)
// ============================================================================

export interface AgentRunRequest {
  readonly prompt: string
  readonly label?: string
  /** Cooperative cancellation — the production adapter forwards this to the
   *  forked subagent loop so an aborted workflow tears down its children. */
  readonly signal?: AbortSignal
}

export interface AgentRunResult {
  readonly ok: boolean
  /** The agent's final text (the StructuredOutput payload when a schema is in
   *  play). Empty string is allowed. */
  readonly text: string
  /** Output tokens this run consumed, if the adapter can report it — used by
   *  the optional {@link BudgetPort} accounting. */
  readonly tokensUsed?: number
  readonly errorMessage?: string
}

/**
 * The bridge to a real subagent loop. PRODUCTION binds this to the subagent
 * runner / background scheduler at the composition root; TESTS pass a fake.
 * Contract: `run` SHOULD NOT throw (a thrown error is caught and mapped to an
 * `agent_error` step failure, so the engine never crashes on a flaky adapter).
 */
export interface AgentRunPort {
  run(req: AgentRunRequest): Promise<AgentRunResult>
}

/**
 * Optional token-budget gate (mirror of the harness `budget`). The engine
 * reads `remaining()` BEFORE each agent run; `<= 0` skips the remaining agent
 * steps (`budget_exhausted`). Absent ⇒ unbounded (no gating). The engine does
 * not mutate the budget — the adapter charges it via the same accounting the
 * subagent loop already does; `remaining()` reflects the shared pool.
 */
export interface BudgetPort {
  remaining(): number
}

// ============================================================================
// Events + outcomes
// ============================================================================

export type StepFailureReason =
  | "agent_error" // adapter returned ok:false or threw
  | "schema_invalid" // structured output failed validation after retries
  | "builder_threw" // a prompt/over/body builder threw
  | "duplicate_id" // a step id collided with an already-recorded step
  | "aborted" // the run was aborted before/at this step

export type SkipReason =
  | "budget_exhausted"
  | "max_agents" // the runaway backstop tripped
  | "pipeline_short_circuit" // an earlier stage of this item failed
  | "aborted"

export type StepOutcome =
  | { readonly id: string; readonly ok: true; readonly value: unknown; readonly text: string }
  | {
      readonly id: string
      readonly ok: false
      readonly reason: StepFailureReason
      readonly error: string
    }

export type WorkflowEvent =
  | { readonly type: "phase_enter"; readonly name: string }
  | { readonly type: "step_start"; readonly id: string; readonly label: string }
  | {
      readonly type: "step_complete"
      readonly id: string
      readonly ok: boolean
      readonly reason?: StepFailureReason
    }
  | { readonly type: "step_skipped"; readonly id: string; readonly reason: SkipReason }

export interface WorkflowSink {
  emit(event: WorkflowEvent): void
}

export interface WorkflowResult {
  /** True iff NO step failed. (Skips alone do not flip this — they are a
   *  deliberate gate, recorded as events, not failures.) */
  readonly ok: boolean
  /** Every recorded step outcome, keyed by id (insertion order preserved). */
  readonly results: ReadonlyMap<string, StepOutcome>
  /** Ordered event log (also streamed to `sink` if supplied). */
  readonly events: ReadonlyArray<WorkflowEvent>
  /** Total agent runs actually dispatched (counts retries; excludes skips). */
  readonly agentRuns: number
}

export interface RunWorkflowOptions {
  readonly agentRun: AgentRunPort
  /** Max concurrent agent runs (default 8). The cap the harness derives from
   *  cpu cores; here it is explicit/injectable. */
  readonly concurrency?: number
  /** Hard runaway backstop on TOTAL agent runs (default 1000). */
  readonly maxAgents?: number
  readonly signal?: AbortSignal
  readonly sink?: WorkflowSink
  readonly budget?: BudgetPort
}
