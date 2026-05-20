import type { z } from "zod"

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Subagent recursion depth of the agent that owns this call (0 = root).
   *  Optional + duck-typed: the subagent slice reads it to enforce maxDepth;
   *  absent ⇒ treated as 0. Propagated by the dispatch seam from
   *  `AgentConfig.depth` (SOTA++ subagent absorption, ADR-0011). */
  depth?: number
  /** Session-scoped WorkingState handle (Codex memory L3 absorption). Optional
   *  and duck-typed so the `@/tool` slice never imports `@/agent`: the agent
   *  loop builds the concrete instance when `AgentConfig.workingState` is set,
   *  and the `update_working_state` meta-tool mutates it through this seam.
   *  Absent ⇒ working-state feature is OFF (byte-identical for all callers). */
  workingState?: WorkingStateHandle
}

/** Duck-typed handle a tool uses to mutate or read the session WorkingState
 *  without importing `@/agent`. The agent loop is the only producer; tools are
 *  the consumers. `snapshot()` returns the current state by reference; callers
 *  must treat it as read-only and route mutations through `mutate()`. */
export interface WorkingStateHandle {
  /** Apply a partial replacement to the current state. Each provided field is
   *  a REPLACEMENT for the corresponding state field — absent fields preserve
   *  existing state. `hypothesis: null` clears the field. */
  mutate(patch: WorkingStatePatch): WorkingStateSnapshot
  /** Read-only snapshot of the current state. */
  snapshot(): WorkingStateSnapshot
}

/** Structural duck-typed mirror of `WorkingState` (kept here so `@/tool` is
 *  slice-isolated from `@/agent`). Fields are intentionally `unknown` shapes to
 *  the tool — the concrete tool re-derives them via zod. */
export interface WorkingStateSnapshot {
  ownerShortlist: { file: string; reason: string }[]
  hypothesis?: string
  blockers: { what: string; surface: string }[]
  nextStepQueue: { what: string; deferred?: boolean }[]
  deferredValidation: { rail: string; reason: string }[]
}

/** Patch shape for `WorkingStateHandle.mutate`. Each present field REPLACES
 *  the corresponding state field; `hypothesis: null` clears it. `| undefined`
 *  is spelled explicitly on every optional so a zod `.optional()` parse output
 *  (which is structurally `T | undefined`) is assignable under
 *  `exactOptionalPropertyTypes: true`. */
export interface WorkingStatePatch {
  ownerShortlist?: { file: string; reason: string }[] | undefined
  hypothesis?: string | null | undefined
  blockers?: { what: string; surface: string }[] | undefined
  nextStepQueue?: { what: string; deferred?: boolean | undefined }[] | undefined
  deferredValidation?: { rail: string; reason: string }[] | undefined
}

export interface ToolResult {
  ok: boolean
  /** Text returned to the model as the tool_result content. */
  output: string
}

/**
 * Events a tool streams while running. A tool yields zero or more `progress`
 * events, then exactly one terminal `result` — which MUST be the last event.
 */
export type ToolEvent =
  | { type: "progress"; message: string }
  | { type: "result"; result: ToolResult }

/**
 * Codex HITL 4-tier taxonomy (hitl-audit.md). Structurally identical to
 * `HITLTier` in `@/permission`, redeclared here so the `@/tool` slice never
 * imports `@/permission` (biome forbids that direction). Dispatch composes
 * the two via duck-typing.
 */
export type HITLTier = "hand-off-required" | "always-confirm" | "pre-approval-ok" | "none"

/**
 * Phase 2 tool contract (RFC §6.2). `execute` is an async generator yielding
 * `ToolEvent`s; `isConcurrencySafe(input)` lets the dispatcher batch pure
 * reads to run in parallel while keeping side-effecting calls serialized.
 */
export interface Tool<I = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  isReadOnly(): boolean
  /** True ⇒ this call has no observable interaction with any other call and
   *  may run concurrently with other concurrency-safe calls. */
  isConcurrencySafe(input: I): boolean
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent>
  /** OPTIONAL: input-dependent HITL tier (Codex hitl-audit.md absorption).
   *  When omitted, the dispatch gate infers tier from `isReadOnly()`
   *  (true ⇒ "none", false ⇒ "pre-approval-ok"). Tools whose tier varies
   *  per-input (e.g. `bash` — `git push` is always-confirm, `ls` is
   *  pre-approval-ok) provide their own classifier here. Only consulted
   *  when the HITL gate is explicitly enabled in `AgentConfig.hitl`. */
  hitlTier?(input: I): HITLTier
}

/** Provider-agnostic schema the agent forwards to the LLM. */
export interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
