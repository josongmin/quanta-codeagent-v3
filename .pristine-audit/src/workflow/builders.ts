/**
 * §25.1 — Ergonomic constructors for the workflow node tree. Pure: each returns
 * a frozen node literal, no effect. These are the public authoring surface
 * (`phase("review", parallel(agent(...), agent(...)))`).
 */

import type {
  AgentNode,
  FanoutNode,
  LoopNode,
  ParallelNode,
  PhaseNode,
  PipelineNode,
  SequenceNode,
  WorkflowContext,
  WorkflowNode,
} from "./types"

/** A single subagent step. */
export const agent = (spec: {
  id: string
  prompt: AgentNode["prompt"]
  schema?: AgentNode["schema"]
  label?: string
  maxRetries?: number
}): AgentNode => ({
  type: "agent",
  id: spec.id,
  prompt: spec.prompt,
  ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
  ...(spec.label !== undefined ? { label: spec.label } : {}),
  ...(spec.maxRetries !== undefined ? { maxRetries: spec.maxRetries } : {}),
})

/** Run children in order (soft — a failure does not skip later children). */
export const sequence = (...children: WorkflowNode[]): SequenceNode => ({
  type: "sequence",
  children,
})

/** Run children concurrently with a barrier. */
export const parallel = (...children: WorkflowNode[]): ParallelNode => ({
  type: "parallel",
  children,
})

/** Named progress group. */
export const phase = (name: string, body: WorkflowNode): PhaseNode => ({
  type: "phase",
  name,
  body,
})

/** Dynamic fan-out over a runtime-computed item list. */
export const fanout = (spec: {
  over: (ctx: WorkflowContext) => ReadonlyArray<unknown>
  body: (item: unknown, index: number) => WorkflowNode
  mode?: "parallel" | "sequential"
}): FanoutNode => ({
  type: "fanout",
  over: spec.over,
  body: spec.body,
  ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
})

/** Per-item staged pipeline (no barrier between stages). */
export const pipeline = (spec: {
  over: (ctx: WorkflowContext) => ReadonlyArray<unknown>
  stages: ReadonlyArray<(prev: unknown, item: unknown, index: number) => AgentNode>
}): PipelineNode => ({
  type: "pipeline",
  over: spec.over,
  stages: spec.stages,
})

/** Bounded loop, stopping early on `until`. */
export const loop = (spec: {
  maxIterations: number
  body: (iteration: number, ctx: WorkflowContext) => WorkflowNode
  until?: (ctx: WorkflowContext) => boolean
}): LoopNode => ({
  type: "loop",
  maxIterations: spec.maxIterations,
  body: spec.body,
  ...(spec.until !== undefined ? { until: spec.until } : {}),
})
