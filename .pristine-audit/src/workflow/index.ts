/**
 * §25.1 — Declarative workflow orchestration engine. Barrel.
 *
 * SLICE `@/workflow`: a pure library that walks a declarative node tree,
 * spawning subagents through the injected {@link AgentRunPort}. Default-OFF
 * (acts only when `runWorkflow` is called); no clock/randomness in core.
 */

export { agent, fanout, loop, parallel, phase, pipeline, sequence } from "./builders"
export { compileWorkflowSpec } from "./compile"
export { runWorkflow } from "./executor"
export {
  type FieldType,
  fieldSchemaToZod,
  type OutputSchemaSpec,
  type PhaseSpec,
  PhaseSpecSchema,
  type StepSpec,
  StepSpecSchema,
  type WorkflowSpec,
  WorkflowSpecSchema,
} from "./spec"
export type {
  AgentNode,
  AgentRunPort,
  AgentRunRequest,
  AgentRunResult,
  BudgetPort,
  FanoutNode,
  LoopNode,
  ParallelNode,
  PhaseNode,
  PipelineNode,
  RunWorkflowOptions,
  SequenceNode,
  SkipReason,
  StepFailureReason,
  StepOutcome,
  WorkflowContext,
  WorkflowEvent,
  WorkflowNode,
  WorkflowResult,
  WorkflowSink,
} from "./types"
